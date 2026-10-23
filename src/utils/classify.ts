/* ================================================================== *
 * torrential·classify — movie vs TV title classification
 *
 * Pure, dependency-free scoring over release titles. The aggregator
 * (providers/index.ts) runs every raw row through classifyTitle() and
 * attaches the verdict as row.media; the App router runs voteKind()
 * over the first results batch (plus classifyQuery() as a mild prior)
 * to decide between the flat movie list and the TV tiers.
 *
 * Design rules (see PROMPT-auto-mode-movie-vs-tv.md):
 *   · an EXPLICIT episode marker (SxxExx, date form, 1xx, …) always
 *     beats movie-looking release tags — "Oppenheimer S01E04" is an
 *     episode, period
 *   · movie needs corroborating evidence: at least TWO of year /
 *     source / codec / audio / movie-only phrase. Resolution alone is
 *     NOT evidence — episodes carry 1080p too
 *   · a provider prior (nyaa leans episodic) may break AMBIGUOUS ties
 *     only — it never overrides strong signals
 *   · when unsure → kind 'unknown', confidence <= 0.3, and the UI
 *     degrades silently to the 2.0.0 TV flow
 * ================================================================== */

export type MediaKind = 'movie' | 'episode' | 'season-pack' | 'unknown'

export interface MediaClass {
  kind: MediaKind
  /** 0..1 — how sure the scorer is; <= 0.3 marks a guess. */
  confidence: number
  /** Which firing rules produced the verdict (debug + vote tiebreaks). */
  signals: string[]
}

/* ------------------------------------------------------------------ *
 * Signal regexes — ordered like the TV parser in tv.ts
 * ------------------------------------------------------------------ */

/** "Show S02E05" / "S2E5" / range "S02E05-E08" / chain "S02E05E06". */
const RE_SXXEXX = /\bS(\d{1,2})\s?-?\s?E(\d{1,3})(?:\s?(?:[-–~]\s?)?E(\d{1,3}))?\b/i

/** "Season 5 Episode 8" spelled out. */
const RE_SEASON_EPISODE_WORDS = /\bseason\s?(\d{1,2})\s?episode\s?(\d{1,3})\b/i

/** "2x05" fan notation — same guards as tv.ts (1920x1080, S02x264). */
const RE_XNN = /(?<![\dxXsS])(\d{1,2})x(\d{1,3})(?![\w])/i

/** "205" / "1005" concatenated 1xx form — year tokens skipped by the scanner. */
const RE_NNN = /(?<![\dxX.])([1-9]\d?)(\d{2})(?![\w])/g

/** Date-episode form: "The Daily Show 2023.10.12" / "2023-10-12". */
const RE_DATE_EPISODE = /(?<!\d)(19\d{2}|20\d{2})[._\-](\d{1,2})[._\-](\d{1,2})(?!\d)/

/** nyaa-style absolute episode: "Show - 28 [1080p]" / "Show 28 [1080p]". */
const RE_ABS_DASH = /[-–]\s(\d{1,4})(?:v\d+)?(?=\s*(?:[-–]\s*(?:end|final)\s*)?[\[(])/i
const RE_ABS_DASH_RANGE = /[-–]\s(\d{1,4})\s?[-–]\s?(\d{1,4})(?:v\d+)?(?=\s*[\[(])/
const RE_ABS_SPACE = /(?<![\w])(\d{1,3})(?=\s*[\[(])/

/** "Show S02" — bare season tag. Must not eat S02E05. */
const RE_SXX_PACK = /\bS(\d{1,2})\b(?!\s?-?\s?E)(?![\dxX])/i

/** "Season 2" / "2nd Season" / "Season Two" (word forms). */
const RE_SEASON_WORD = /\bseasons?\s?(\d{1,2})\b/i
const RE_NTH_SEASON = /\b(\d{1,2})(?:st|nd|rd|th)\s?season\b/i
const RE_SEASON_WORD_NUM = /\bseason\s(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i

/** "S01-S05" / "Seasons 1 to 4" — multi-season collections. */
const RE_MULTI_SEASON = /\bS?easons?\s?(\d{1,2})\s?(?:[-–~]|to)\s?S?easons?\s?(\d{1,2})\b/i

/** "Complete Series / Collection / Box set" — phrased like a collection. */
const RE_COMPLETE = /\bcomplete\s+(series|collection|seasons?|pack|box\s?set?)\b|\bseries\s+complete\b/i

/** Standalone release year (word-bounded — "1920x1080" does not match). */
const RE_YEAR = /\b(19\d{2}|20\d{2})\b/

/** Movie source tags. REMUX/WEB-DL/HDCAM never ride episode names. */
const RE_SOURCE_TAG =
  /\b(BluRay|Blu-?Ray|BRRip|BDRip|BDRemux|REMUX|WEB-?DL|WEBRip|Web\s?Rip|HDTV|HDCAM|HDTCAM|CAM|DVDScr|DVDRip)\b/i

/** Codec tags. */
const RE_CODEC = /\b(x264|x265|h\.?264|h\.?265|HEVC|AVC|AV1|XviD)\b/i

/** Audio tags. */
const RE_AUDIO = /\b(AAC2?|AC3|E-?AC-?3|DDP|DD\+|DTS(?:-HD)?|TrueHD|Atmos|FLAC|OPUS)\b/i

/** Phrases that only ever ride movie releases. */
const RE_MOVIE_PHRASE = /\b(IMAX|Extended|Unrated|Remastered|Remaster|Theatrical|Director'?s\s?Cut|4K\s?UHD)\b/i

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
}

/** Year-shaped 4-digit token (1900-2099) — never a 1xx season/episode. */
function isYearToken(token: string): boolean {
  return /^(?:19|20)\d{2}$/.test(token)
}

/**
 * Absolute-episode probe mirroring parseAbsolute() in tv.ts, WITH the
 * year guard applied to the dash forms: "Oppenheimer - 2023 [1080p]"
 * is a movie, not episode 2023.
 */
function absoluteEpisode(title: string): { episode: number; range: boolean } | null {
  let m = RE_ABS_DASH_RANGE.exec(title)
  if (m) {
    const a = Number.parseInt(m[1], 10)
    const b = Number.parseInt(m[2], 10)
    if (a >= 1 && b > a && b <= 4000 && !isYearToken(m[1]) && !isYearToken(m[2])) {
      return { episode: a, range: true }
    }
  }
  m = RE_ABS_DASH.exec(title)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    if (n >= 1 && n <= 4000 && !isYearToken(m[1])) return { episode: n, range: false }
  }
  m = RE_ABS_SPACE.exec(title)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    if (n >= 1 && n <= 999 && !isYearToken(m[1])) return { episode: n, range: false }
  }
  return null
}

/**
 * Scan for a 1xx token ("205" → S02E05), skipping year-shaped tokens
 * ("Show 2023 1080p" stays a movie). Mirrors findNnn() in tv.ts but
 * requires episode >= 1 — "300" (S03E00) is a movie, not a special.
 */
function onexxToken(title: string): { season: number; episode: number } | null {
  for (const match of title.matchAll(RE_NNN)) {
    if (isYearToken(match[0])) continue
    const season = Number.parseInt(match[1], 10)
    const episode = Number.parseInt(match[2], 10)
    // Seasons beyond 30 in 1xx form are serial numbers, not TV.
    if (season >= 1 && season <= 30 && episode >= 1 && episode <= 999) {
      return { season, episode }
    }
  }
  return null
}

/** Word/ordinal season marker ("Season 2", "2nd Season", "Season Two"). */
function seasonWord(title: string): number | null {
  let m = RE_NTH_SEASON.exec(title) ?? RE_SEASON_WORD.exec(title)
  if (m) return Number.parseInt(m[1], 10)
  m = RE_SEASON_WORD_NUM.exec(title)
  if (m) return WORD_NUMBERS[m[1].toLowerCase()] ?? null
  return null
}

/** Count the independent movie evidence bits in the title. */
function movieSignals(title: string): string[] {
  const signals: string[] = []
  if (RE_YEAR.test(title)) signals.push('year')
  if (RE_SOURCE_TAG.test(title)) signals.push('source-tag')
  if (RE_CODEC.test(title)) signals.push('codec')
  if (RE_AUDIO.test(title)) signals.push('audio-tag')
  if (RE_MOVIE_PHRASE.test(title)) signals.push('movie-phrase')
  return signals
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Classify one release title.
 *
 * Priority: near-certain episode markers > season/absolute combo >
 * season packs > movie evidence (needs >= 2 signals) > provider prior
 * (nyaa only, ambiguous rows only) > unknown.
 */
export function classifyTitle(title: string, providerId?: string): MediaClass {
  const raw = title.replace(/\s+/g, ' ').trim()

  // ── 1. Near-certain episode markers — one alone settles it ────────
  const sxxexx = RE_SXXEXX.exec(raw)
  if (sxxexx) {
    return { kind: 'episode', confidence: 0.97, signals: ['sxxexx'] }
  }
  if (RE_SEASON_EPISODE_WORDS.test(raw)) {
    return { kind: 'episode', confidence: 0.95, signals: ['season-episode-words'] }
  }
  if (RE_DATE_EPISODE.test(raw)) {
    return { kind: 'episode', confidence: 0.95, signals: ['date-episode'] }
  }
  if (RE_XNN.test(raw)) {
    return { kind: 'episode', confidence: 0.92, signals: ['xnn'] }
  }
  const onexx = onexxToken(raw)
  if (onexx) {
    return { kind: 'episode', confidence: 0.9, signals: ['1xx'] }
  }

  // ── 2. Absolute numbering + season context ("2nd Season - 07") ────
  const abs = absoluteEpisode(raw)
  const season = seasonWord(raw)
  const bareSeasonPack = RE_SXX_PACK.exec(raw) !== null
  if ((season !== null || bareSeasonPack) && abs) {
    return { kind: 'episode', confidence: 0.85, signals: ['season-context', 'absolute-episode'] }
  }

  // ── 3. Season packs ───────────────────────────────────────────────
  const multiSeason = RE_MULTI_SEASON.test(raw)
  const complete = RE_COMPLETE.test(raw)
  if (multiSeason || bareSeasonPack || season !== null || complete) {
    const signals: string[] = []
    if (multiSeason) signals.push('multi-season')
    if (bareSeasonPack) signals.push('bare-sxx')
    if (season !== null) signals.push('season-word')
    if (complete) signals.push('complete-series')
    return { kind: 'season-pack', confidence: multiSeason || complete ? 0.85 : 0.8, signals }
  }

  // ── 4. Absolute episode without season context (nyaa style) ───────
  if (abs) {
    const nyaa = providerId === 'nyaa'
    return {
      kind: 'episode',
      confidence: nyaa ? 0.85 : 0.72,
      signals: nyaa ? ['absolute-episode', 'provider-prior'] : ['absolute-episode']
    }
  }

  // ── 5. Movie evidence — at least TWO independent signals ──────────
  const movie = movieSignals(raw)
  if (movie.length >= 2) {
    return {
      kind: 'movie',
      confidence: Math.min(0.95, 0.72 + 0.07 * (movie.length - 2)),
      signals: movie
    }
  }

  // ── 6. Ambiguous — provider prior may lean, never override ────────
  if (providerId === 'nyaa') {
    return { kind: 'episode', confidence: 0.55, signals: ['provider-prior'] }
  }
  return {
    kind: 'unknown',
    confidence: movie.length === 1 ? 0.25 : 0.1,
    signals: movie.length === 1 ? movie : ['no-signal']
  }
}

/**
 * Classify the user's QUERY itself — a mild prior for the set vote,
 * not a verdict. Queries are short and untagged, so the bar is lower:
 * a bare title with a year leans movie; explicit markers lean TV.
 */
export function classifyQuery(query: string): MediaClass {
  const raw = query.replace(/\s+/g, ' ').trim()

  if (RE_SXXEXX.test(raw) || RE_SEASON_EPISODE_WORDS.test(raw) || RE_DATE_EPISODE.test(raw)) {
    return { kind: 'episode', confidence: 0.8, signals: ['query-episode-marker'] }
  }
  if (RE_XNN.test(raw) || onexxToken(raw)) {
    return { kind: 'episode', confidence: 0.75, signals: ['query-episode-marker'] }
  }
  const season = seasonWord(raw) ?? (RE_SXX_PACK.exec(raw) ? Number.parseInt(RE_SXX_PACK.exec(raw)![1], 10) : null)
  if (season !== null) {
    return { kind: 'season-pack', confidence: 0.7, signals: ['query-season-marker'] }
  }

  // Bare title + release-ish context → leans movie.
  const movie = movieSignals(raw)
  if (movie.length >= 2) return { kind: 'movie', confidence: 0.75, signals: movie }
  if (movie.length === 1) return { kind: 'movie', confidence: 0.6, signals: movie }

  return { kind: 'unknown', confidence: 0.1, signals: ['no-signal'] }
}

/**
 * Set-level vote: the majority verdict among decisive rows wins.
 * A tie between kinds, or a set dominated by unknowns, votes
 * 'unknown' — the caller then degrades to the 2.0.0 TV flow.
 */
export function voteKind(classes: MediaClass[]): MediaClass {
  if (classes.length === 0) {
    return { kind: 'unknown', confidence: 0, signals: ['empty-set'] }
  }
  const tally = new Map<MediaKind, number>()
  for (const c of classes) {
    // Only decisive rows vote; low-confidence guesses are noise.
    if (c.kind === 'unknown' || c.confidence < 0.5) continue
    tally.set(c.kind, (tally.get(c.kind) ?? 0) + 1)
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (!top) {
    return { kind: 'unknown', confidence: 0.2, signals: ['mostly-unknown'] }
  }
  const tied = ranked.length > 1 && ranked[1][1] === top[1]
  const share = top[1] / classes.length
  if (tied || share <= 0.5) {
    return { kind: 'unknown', confidence: 0.2, signals: ['split-vote'] }
  }
  return { kind: top[0], confidence: Math.min(0.95, 0.5 + share / 2), signals: ['set-vote'] }
}
