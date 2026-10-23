import type { SearchResult, TvScope } from '../types.js'

/* ================================================================== *
 * torrential·tv — episodic metadata parsing
 *
 * Everything TV-shaped in torrential flows through this module:
 *   · parseTvTitle()     → show name + season/episode/pack scope
 *   · toTvResult()       → shapes a raw provider row (tags episodic rows;
 *                          movies survive as generic rows)
 *   · buildSeriesIndex() → groups rows into series → seasons → episodes
 *   · episodeQueries() / seasonQueries() → smart SxxExx / 1xx injection
 *
 * The parser is intentionally regex-driven and conservative: a title that
 * carries NO recognizable season/episode/pack marker is treated as a movie
 * (or junk) and kept as a GENERIC row (show/scope omitted, see toTvResult)
 * — the TV tiers ignore it, auto/movies modes keep it.
 * ================================================================== */

export interface ParsedTv {
  /** Cleaned, display-ready show name ("Breaking Bad", "Frieren"). */
  show: string
  /** null when the title carries no season/episode/pack marker (a movie). */
  scope: TvScope | null
  /** Character index in the ORIGINAL title where the scope marker began. */
  cutIndex: number
}

/* ------------------------------------------------------------------ *
 * Regex battery — ordered from most explicit to most heuristic
 * ------------------------------------------------------------------ */

/** "Show S02E05-E08" / "S2E5 to E8" — episode ranges (mini packs). */
const RE_SXXEXX = /\bS(\d{1,2})\s?-?\s?E(\d{1,3})(?:\s?(?:[-–~]\s?)?E(\d{1,3}))?\b/i

/** "Season 5 Episode 8" spelled out. */
const RE_SEASON_EPISODE_WORDS = /\bseason\s?(\d{1,2})\s?episode\s?(\d{1,3})\b/i

/** "2x05" / "10x12" — the X-Files fan notation. Guards: 1920x1080, S02x264. */
const RE_XNN = /(?<![\dxXsS])(\d{1,2})x(\d{1,3})(?![\w])/i

/** "205" / "1005" — the 1xx concatenated notation (season, then episode). */
const RE_NNN = /(?<![\dxX.])([1-9]\d?)(\d{2})(?![\w])/g

/** "2nd Season" / "3rd season" — anime season markers. */
const RE_NTH_SEASON = /\b(\d{1,2})(?:st|nd|rd|th)\s?season\b/i

/** "Season 2" / "season 02" — also captures a season context for anime eps. */
const RE_SEASON_WORD = /\bseasons?\s?(\d{1,2})\b/i

/** "Season One" .. "Season Twelve" spelled out. */
const RE_SEASON_WORD_NUM = /\bseason\s(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i

/** "The Complete First Season" — ordinal seasons. */
const RE_ORDINAL_SEASON = /\b(?:complete\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/i

/** nyaa-style absolute episode: "Show - 28 [1080p]", "Show - 12v2 (720p)", "- 12 - END [720p]". */
const RE_ABS_DASH = /[-–]\s(\d{1,4})(?:v\d+)?(?=\s*(?:[-–]\s*(?:end|final)\s*)?[\[(])/i

/** nyaa-style absolute range: "Show - 01-12 [Batch]". */
const RE_ABS_DASH_RANGE = /[-–]\s(\d{1,4})\s?[-–]\s?(\d{1,4})(?:v\d+)?(?=\s*[\[(])/

/** "Show 12 [1080p]" — absolute episode without a dash. */
const RE_ABS_SPACE = /(?<![\w])(\d{1,3})(?=\s*[\[(])/

/** "S01-S05" / "Seasons 1-5" / "Season 1 to 4" — multi-season packs. */
const RE_MULTI_SEASON = /\bS?easons?\s?(\d{1,2})\s?(?:[-–~]|to)\s?S?easons?\s?(\d{1,2})\b/i

/** "Show S02" — a bare Sxx tag (season pack). Must not eat S02E05. */
const RE_SXX_PACK = /\bS(\d{1,2})\b(?!\s?-?\s?E)(?![\dxX])/i

/** "Complete Series" / "Complete Collection" / "The Complete …". */
const RE_COMPLETE = /\bcomplete\b/i

/** Trailing years, stripped before 1xx matching so "2023" ≠ S20E23. */
const YEAR_RE = /\b(19[5-9]\d|20[0-2]\d)\b/g

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
}

const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function rangeList(from: number, to: number): number[] {
  if (to <= from) return [from]
  // Guard against absurd ranges (a typo'd "- E9999" would explode memory).
  const capped = Math.min(to, from + 199)
  const out: number[] = []
  for (let i = from; i <= capped; i++) out.push(i)
  return out
}

function validSeason(n: number): boolean {
  return n >= 0 && n <= 99
}

function validEpisode(n: number): boolean {
  return n >= 0 && n <= 999
}

/** Year-shaped number (1900-2099) — never a plausible absolute episode. */
function isYearNumber(n: number): boolean {
  return n >= 1900 && n <= 2099
}

/* ------------------------------------------------------------------ *
 * Show-name cleanup
 * ------------------------------------------------------------------ */

/** Title-case a string without touching already-mixed case ("CSI: Vegas"). */
function titleCase(text: string): string {
  return text
    .split(' ')
    .map(word => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ')
}

/**
 * Turn the raw left-hand side of a torrent title into a display-ready
 * show name: strips release-group tags, dots/underscores, trailing years,
 * and joins SCREAMING single-letter chains ("C S I" → "CSI").
 */
export function cleanShowName(raw: string): string {
  let s = raw
  // Leading release-group tags: "[SubsPlease] " / "(GRP) "
  s = s.replace(/^\s*[[(][^\])]+[\])]\s*/, '')
  // Separator soup → spaces
  s = s.replace(/[._]+/g, ' ')
  // "C S I" → "CSI" (scene-style single-letter chains, up to a few rounds)
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\b([A-Z])\s(?=[A-Z](?:\s|$))/g, '$1')
    if (next === s) break
    s = next
  }
  // Trailing "The Complete" / "Complete" leftovers (cut happened mid-phrase)
  s = s.replace(/\s*\bthe\s+complete\b\s*$/i, '')
  s = s.replace(/\s*\bcomplete\b\s*$/i, '')
  // Trailing year (+ optional bracket wrapper)
  s = s.replace(/\s*[([]?\b(19[5-9]\d|20[0-2]\d)\b[)\]]?\s*$/, '')
  // Trailing separator noise
  s = s.replace(/[\s\-–_:,;·|]+$/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  // ALL-CAPS or all-lower names read better title-cased
  if (s.length > 0 && (s === s.toUpperCase() || s === s.toLowerCase())) s = titleCase(s)
  return s
}

/** Normalized grouping key: case/punctuation-insensitive, leading "the" dropped. */
export function showKey(show: string): string {
  return show
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^the/, '')
}

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/**
 * Parse a raw torrent (or file) title into show + scope.
 *
 * Supported markers, in priority order:
 *   S02E05 / S2E5 / S02-E05 · S02E05-E08 ranges · S02E05E06 chains
 *   Season 5 Episode 8 · 2x05 · 205 (1xx) · 2nd Season · Season Two
 *   "Show - 28 [1080p]" absolute · "- 01-12 [Batch]" absolute ranges
 *   S01-S05 multi-season · Season 2 / S02 packs · Complete Series
 */
export function parseTvTitle(title: string): ParsedTv {
  const raw = title.replace(/\s+/g, ' ').trim()
  if (raw.length === 0) return { show: '', scope: null, cutIndex: 0 }

  let m: RegExpExecArray | null

  // ── 1. SxxExx (with optional range / chain) ────────────────────────
  m = RE_SXXEXX.exec(raw)
  if (m) {
    const season = Number.parseInt(m[1], 10)
    const episode = Number.parseInt(m[2], 10)
    const end = m[3] !== undefined ? Number.parseInt(m[3], 10) : undefined
    if (validSeason(season) && validEpisode(episode)) {
      const scope: TvScope =
        end !== undefined && validEpisode(end) && end > episode
          ? { kind: 'episode', season, episode, episodes: rangeList(episode, end) }
          : { kind: 'episode', season, episode }
      return finish(raw, m.index, scope)
    }
  }

  // ── 2. "Season 5 Episode 8" ────────────────────────────────────────
  m = RE_SEASON_EPISODE_WORDS.exec(raw)
  if (m) {
    const season = Number.parseInt(m[1], 10)
    const episode = Number.parseInt(m[2], 10)
    if (validSeason(season) && validEpisode(episode)) {
      return finish(raw, m.index, { kind: 'episode', season, episode })
    }
  }

  // ── 3. 2x05 ────────────────────────────────────────────────────────
  m = RE_XNN.exec(raw)
  if (m) {
    const season = Number.parseInt(m[1], 10)
    const episode = Number.parseInt(m[2], 10)
    if (validSeason(season) && validEpisode(episode)) {
      return finish(raw, m.index, { kind: 'episode', season, episode })
    }
  }

  // ── 4. 205 / 1005 (1xx notation) — year tokens skipped inline ──
  const nnn = findNnn(raw)
  if (nnn) {
    return finish(raw, nnn.index, { kind: 'episode', season: nnn.season, episode: nnn.episode })
  }

  // ── 5. Anime forms: "2nd Season" / "Season 2" + absolute episode ───
  let seasonToken: number | undefined
  let seasonCut = -1
  m = RE_NTH_SEASON.exec(raw)
  if (m) {
    seasonToken = Number.parseInt(m[1], 10)
    seasonCut = m.index
  } else {
    m = RE_SEASON_WORD.exec(raw)
    if (m) {
      seasonToken = Number.parseInt(m[1], 10)
      seasonCut = m.index
    } else {
      m = RE_SEASON_WORD_NUM.exec(raw)
      if (m) {
        seasonToken = WORD_NUMBERS[m[1].toLowerCase()]
        seasonCut = m.index
      }
    }
  }
  if (seasonToken !== undefined && validSeason(seasonToken)) {
    const abs = parseAbsolute(raw)
    if (abs) {
      if (abs.range) {
        return finish(raw, seasonCut, {
          kind: 'episode',
          season: seasonToken,
          episode: abs.episode,
          episodes: rangeList(abs.episode, abs.end!)
        })
      }
      return finish(raw, seasonCut, { kind: 'episode', season: seasonToken, episode: abs.episode })
    }
    return finish(raw, seasonCut, { kind: 'pack', seasons: [seasonToken] })
  }

  // ── 6. Absolute numbering without a season token (nyaa) ────────────
  const abs = parseAbsolute(raw)
  if (abs) {
    if (abs.range) {
      return finish(raw, abs.index, {
        kind: 'episode',
        season: null,
        episode: abs.episode,
        episodes: rangeList(abs.episode, abs.end!)
      })
    }
    return finish(raw, abs.index, { kind: 'episode', season: null, episode: abs.episode })
  }

  // ── 7. Multi-season packs: "S01-S05", "Seasons 1 to 4" ────────────
  m = RE_MULTI_SEASON.exec(raw)
  if (m) {
    const a = Number.parseInt(m[1], 10)
    const b = Number.parseInt(m[2], 10)
    if (validSeason(a) && validSeason(b) && b > a && b - a <= 60) {
      return finish(raw, m.index, { kind: 'pack', seasons: rangeList(a, b) })
    }
  }

  // ── 8. Ordinal season packs: "(The) Complete First Season" ─────────
  m = RE_ORDINAL_SEASON.exec(raw)
  if (m) {
    const n = ORDINALS[m[1].toLowerCase()]
    if (n !== undefined) return finish(raw, m.index, { kind: 'pack', seasons: [n] })
  }

  // ── 9. Bare season packs: "Show S02 …" / "Season 2" ────────────────
  m = RE_SXX_PACK.exec(raw)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    if (validSeason(n) && n > 0) return finish(raw, m.index, { kind: 'pack', seasons: [n] })
  }

  // ── 10. Complete series ────────────────────────────────────────────
  if (RE_COMPLETE.test(raw) && raw.length > 12) {
    // Only trust "complete" when it's phrased like a collection; a lone
    // "complete" inside a release-group tag is noise.
    if (/\b(complete\s+(series|collection|seasons?|pack|box)|series\s+complete|complete\b)/i.test(raw)) {
      return finish(raw, RE_COMPLETE.exec(raw)!.index, { kind: 'pack', seasons: [], complete: true })
    }
  }

  return { show: cleanShowName(raw), scope: null, cutIndex: raw.length }
}

/** Shared tail: clean the show name and reject degenerate leftovers. */
function finish(raw: string, cutIndex: number, scope: TvScope): ParsedTv {
  const show = cleanShowName(raw.slice(0, cutIndex))
  if (show.length < 2) {
    // Unattributable ("[Group] - 05.mkv") — keep the scope but the caller
    // drops rows whose show name is unusable.
    return { show, scope: null, cutIndex }
  }
  return { show, scope, cutIndex }
}

/**
 * Absolute episode extraction for anime-style titles.
 *   "Show - 28 [1080p]"   → 28
 *   "Show - 01-12 [Batch]"→ range 1..12
 *   "Show 12 [1080p]"     → 12   (rejected when it looks like a year)
 */
function parseAbsolute(raw: string): { episode: number; end?: number; range?: boolean; index: number } | null {
  // "N [Batch]" / "- N [Batch]" → a batch covering episodes 1..N
  let m = /(?<![\w])(\d{1,3})\s*[\[(]\s*batch/i.exec(raw)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    if (n >= 2 && n <= 999) return { episode: 1, end: n, range: true, index: m.index }
  }
  m = RE_ABS_DASH_RANGE.exec(raw)
  if (m) {
    const a = Number.parseInt(m[1], 10)
    const b = Number.parseInt(m[2], 10)
    // Year guard (same contract as RE_ABS_SPACE): "Show - 2023-2024 [BluRay]"
    // is a movie pair, not absolute episodes E2023-E2024.
    if (a >= 1 && b > a && b <= 4000 && !isYearNumber(a) && !isYearNumber(b)) {
      return { episode: a, end: b, range: true, index: m.index }
    }
  }
  m = RE_ABS_DASH.exec(raw)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    // Year guard: "Oppenheimer - 2023 [1080p]" is a movie, not E2023. Real
    // shows with 1900+ absolute episodes effectively do not exist.
    if (n >= 1 && n <= 4000 && !isYearNumber(n)) return { episode: n, index: m.index }
  }
  m = RE_ABS_SPACE.exec(raw)
  if (m) {
    const n = Number.parseInt(m[1], 10)
    // Reject year-looking numbers in the space form ("Show 2023 [Batch]")
    if (n >= 1 && n <= 999 && !(n >= 1900 && n <= 2099)) return { episode: n, index: m.index }
  }
  return null
}

/**
 * Scan the ORIGINAL title for 1xx tokens, skipping anything that is a
 * 4-digit year ("Show 2023" stays a year, "Show 205" becomes S2E05).
 */
function findNnn(raw: string): { season: number; episode: number; index: number } | null {
  for (const match of raw.matchAll(RE_NNN)) {
    const token = match[0]
    // Any year-shaped 4-digit token is a year first ("Show 2023", but also
    // "Blade Runner 2049" — 1xx seasons never reach 19-20xx numbers).
    if (token.length === 4 && /^(?:19|20)\d{2}$/.test(token)) continue
    const season = Number.parseInt(match[1], 10)
    const episode = Number.parseInt(match[2], 10)
    // Seasons beyond 30 in 1xx form are almost always junk (serials etc.)
    if (season >= 1 && season <= 30 && validEpisode(episode)) {
      return { season, episode, index: match.index ?? 0 }
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Result shaping + labels
 * ------------------------------------------------------------------ */

/**
 * Shape a raw provider row for the aggregator. Rows that parse as episodic
 * content get show/scope/scopeLabel attached; anything else SURVIVES as a
 * generic row: show and scope stay undefined/omitted — scope === undefined
 * means a generic (movie/junk) row, kept in auto/movies modes (mode-aware
 * filtering of the list is a later roadmap step).
 */
export function toTvResult(r: SearchResult): SearchResult {
  if (r.show !== undefined && r.scope !== undefined) return r // already shaped
  const parsed = parseTvTitle(r.title)
  if (!parsed.scope) return r // generic (movie/junk) row: kept, untagged
  return { ...r, show: parsed.show, scope: parsed.scope, scopeLabel: scopeLabel(parsed.scope) }
}

/** Compact human label for a scope: "S02E05", "S02E05-E08", "Season 2", … */
export function scopeLabel(scope: TvScope): string {
  if (scope.kind === 'episode') {
    if (scope.season === null) {
      if (scope.episodes && scope.episodes.length > 1) {
        return `E${pad2(scope.episode)}-E${pad2(scope.episodes[scope.episodes.length - 1])}`
      }
      return `E${pad2(scope.episode)}`
    }
    if (scope.episodes && scope.episodes.length > 1) {
      return `S${pad2(scope.season)}E${pad2(scope.episode)}-E${pad2(scope.episodes[scope.episodes.length - 1])}`
    }
    return `S${pad2(scope.season)}E${pad2(scope.episode)}`
  }
  if (scope.complete) return 'Complete Series'
  if (scope.seasons.length === 0) return 'Episode Batch'
  if (scope.seasons.length > 1) {
    return `S${pad2(scope.seasons[0])}-S${pad2(scope.seasons[scope.seasons.length - 1])}`
  }
  return `Season ${scope.seasons[0]}`
}

/* ------------------------------------------------------------------ *
 * Smart query generation — inject SxxExx / 1xx nomenclature
 * ------------------------------------------------------------------ */

/** Queries that surface torrents for one exact episode. */
export function episodeQueries(show: string, season: number | null, episode: number): string[] {
  if (season === null) {
    // Absolute (anime-style) numbering: "- 28" dash form, then bare form.
    const e = pad2(episode)
    return [`${show} - ${e}`, `${show} ${e}`]
  }
  const s = pad2(season)
  const e = pad2(episode)
  const numeric = `${season}${String(episode).padStart(2, '0')}` // "205", "1005"
  return [`${show} S${s}E${e}`, `${show} ${numeric}`]
}

/** Queries that surface a season's episodes + season packs. */
export function seasonQueries(show: string, season: number): string[] {
  return [`${show} S${pad2(season)}`, `${show} season ${season}`]
}

/* ------------------------------------------------------------------ *
 * Series → seasons → episodes derivation
 * ------------------------------------------------------------------ */

export interface SeasonData {
  /** null = the "Episodes" bucket (absolute numbering, no season marker). */
  season: number | null
  /** Exact-episode torrents keyed by episode number. */
  episodes: Map<number, SearchResult[]>
  /** Multi-episode torrents ("S02E01-E04") relevant to this season. */
  ranges: SearchResult[]
  /** Season packs for this season. */
  packs: SearchResult[]
}

export interface SeriesData {
  key: string
  show: string
  torrents: SearchResult[]
  seasons: Map<number, SeasonData>
  /** Absolute-numbered episodes / batches (season: null bucket). */
  unsorted: SeasonData
  /** Whole-series and multi-season packs. */
  completePacks: SearchResult[]
}

function emptySeason(season: number | null): SeasonData {
  return { season, episodes: new Map(), ranges: [], packs: [] }
}

/** Group TV-shaped results into series buckets. */
export function buildSeriesIndex(results: SearchResult[]): Map<string, SeriesData> {
  const index = new Map<string, SeriesData>()
  for (const r of results) {
    if (r.scope === undefined || r.show === undefined) continue
    const key = showKey(r.show)
    if (key.length === 0) continue
    let data = index.get(key)
    if (!data) {
      data = { key, show: r.show, torrents: [], seasons: new Map(), unsorted: emptySeason(null), completePacks: [] }
      index.set(key, data)
    }
    data.torrents.push(r)

    const scope = r.scope
    if (scope.kind === 'episode') {
      const bucket = scope.season === null ? data.unsorted : seasonBucket(data, scope.season)
      if (scope.episodes && scope.episodes.length > 1) bucket.ranges.push(r)
      else pushEpisode(bucket, scope.episode, r)
    } else {
      if (scope.complete || scope.seasons.length > 1) data.completePacks.push(r)
      if (scope.seasons.length > 0) {
        for (const s of scope.seasons) seasonBucket(data, s).packs.push(r)
      }
      if (scope.seasons.length === 0) data.unsorted.packs.push(r)
    }
  }
  return index
}

function seasonBucket(data: SeriesData, season: number): SeasonData {
  let bucket = data.seasons.get(season)
  if (!bucket) {
    bucket = emptySeason(season)
    data.seasons.set(season, bucket)
  }
  return bucket
}

function pushEpisode(bucket: SeasonData, episode: number, r: SearchResult): void {
  const list = bucket.episodes.get(episode)
  if (list) list.push(r)
  else bucket.episodes.set(episode, [r])
}

export interface SeriesSummary {
  key: string
  show: string
  torrentCount: number
  /** Distinct season numbers, ascending (0 = specials sorted last). */
  seasons: number[]
  hasUnsorted: boolean
  episodeCount: number
  totalSeeders: number
  bestSeeders: number
  sources: string[]
}

/** One row of the series list. */
export function seriesSummaries(index: Map<string, SeriesData>): SeriesSummary[] {
  const out: SeriesSummary[] = []
  for (const data of index.values()) {
    const seasons = [...data.seasons.keys()].sort((a, b) => sortSeason(a) - sortSeason(b))
    let episodeCount = 0
    for (const bucket of [...data.seasons.values(), data.unsorted]) {
      episodeCount += bucket.episodes.size
    }
    const totalSeeders = data.torrents.reduce((sum, r) => sum + r.seeders, 0)
    const bestSeeders = data.torrents.reduce((best, r) => Math.max(best, r.seeders), 0)
    const sources = [...new Set(data.torrents.map(r => r.provider))]
    out.push({
      key: data.key,
      show: data.show,
      torrentCount: data.torrents.length,
      seasons,
      hasUnsorted: data.unsorted.episodes.size > 0 || data.unsorted.ranges.length > 0 || data.unsorted.packs.length > 0,
      episodeCount,
      totalSeeders,
      bestSeeders,
      sources
    })
  }
  return out.sort((a, b) => b.totalSeeders - a.totalSeeders || b.torrentCount - a.torrentCount)
}

/** Sort key that keeps "Specials" (season 0) at the end of the list. */
function sortSeason(season: number): number {
  return season === 0 ? 10_000 : season
}

export type SeasonRef =
  | { kind: 'season'; season: number }
  | { kind: 'unsorted' }
  | { kind: 'complete' }

export interface SeasonRow {
  ref: SeasonRef
  label: string
  episodeCount: number
  packCount: number
  torrentCount: number
  bestSeeders: number
  best: SearchResult | null
}

/** Rows for the series screen: seasons, then complete-series, then unsorted. */
export function buildSeasonRows(data: SeriesData): SeasonRow[] {
  const rows: SeasonRow[] = []
  const seasons = [...data.seasons.keys()].sort((a, b) => sortSeason(a) - sortSeason(b))
  for (const season of seasons) {
    const bucket = data.seasons.get(season)!
    const all = [
      ...[...bucket.episodes.values()].flat(),
      ...bucket.ranges,
      ...bucket.packs
    ]
    rows.push({
      ref: { kind: 'season', season },
      label: season === 0 ? 'Specials' : `Season ${season}`,
      episodeCount: bucket.episodes.size,
      packCount: bucket.packs.length,
      torrentCount: all.length,
      bestSeeders: bestOf(all)?.seeders ?? 0,
      best: bestOf(all)
    })
  }
  if (data.completePacks.length > 0) {
    rows.push({
      ref: { kind: 'complete' },
      label: 'Complete series / multi-season packs',
      episodeCount: 0,
      packCount: data.completePacks.length,
      torrentCount: data.completePacks.length,
      bestSeeders: bestOf(data.completePacks)?.seeders ?? 0,
      best: bestOf(data.completePacks)
    })
  }
  const unsortedAll = [
    ...[...data.unsorted.episodes.values()].flat(),
    ...data.unsorted.ranges,
    ...data.unsorted.packs
  ]
  if (unsortedAll.length > 0) {
    rows.push({
      ref: { kind: 'unsorted' },
      label: 'Episodes (no season tag)',
      episodeCount: data.unsorted.episodes.size,
      packCount: data.unsorted.packs.length,
      torrentCount: unsortedAll.length,
      bestSeeders: bestOf(unsortedAll)?.seeders ?? 0,
      best: bestOf(unsortedAll)
    })
  }
  return rows
}

export interface EpisodeRow {
  season: number | null
  episode: number
  /** Exact single-episode torrents. */
  torrents: SearchResult[]
  /** Ranges covering this episode (mini packs). */
  ranges: SearchResult[]
  best: SearchResult | null
  /** True when only reachable through a range torrent. */
  viaRangeOnly: boolean
}

/** Rows for the season screen: episodes + a pinned pack entry. */
export function buildEpisodeRows(bucket: SeasonData): EpisodeRow[] {
  const rows: EpisodeRow[] = []
  const covered = new Set<number>(bucket.episodes.keys())
  for (const r of bucket.ranges) {
    const scope = r.scope
    if (scope?.kind === 'episode' && scope.episodes) {
      for (const e of scope.episodes) covered.add(e)
    }
  }
  const sorted = [...covered].sort((a, b) => a - b)
  for (const episode of sorted) {
    const torrents = bucket.episodes.get(episode) ?? []
    const ranges = bucket.ranges.filter(coversEpisode(episode))
    const all = [...torrents, ...ranges]
    rows.push({
      season: bucket.season,
      episode,
      torrents,
      ranges,
      best: bestOf(all),
      viaRangeOnly: torrents.length === 0 && ranges.length > 0
    })
  }
  return rows
}

function coversEpisode(episode: number): (r: SearchResult) => boolean {
  return (r: SearchResult): boolean => {
    const scope = r.scope
    if (!scope || scope.kind !== 'episode') return false
    if (scope.episodes) return scope.episodes.includes(episode)
    return scope.episode === episode
  }
}

/** All torrents relevant to one episode: exact matches + covering ranges. */
export function torrentsForEpisode(bucket: SeasonData, episode: number): SearchResult[] {
  const direct = bucket.episodes.get(episode) ?? []
  const ranges = bucket.ranges.filter(coversEpisode(episode))
  return [...direct.sort(bySeeders), ...ranges.sort(bySeeders)]
}

/** All packs relevant to a season view (season packs + complete + unsorted). */
export function packsForSeason(data: SeriesData, ref: SeasonRef): SearchResult[] {
  if (ref.kind === 'complete') return [...data.completePacks].sort(bySeeders)
  if (ref.kind === 'unsorted') {
    return [...data.unsorted.packs, ...data.unsorted.ranges].sort(bySeeders)
  }
  const bucket = data.seasons.get(ref.season)
  return bucket ? [...bucket.packs].sort(bySeeders) : []
}

export function bySeeders(a: SearchResult, b: SearchResult): number {
  return b.seeders - a.seeders
}

export function bestOf(torrents: SearchResult[]): SearchResult | null {
  if (torrents.length === 0) return null
  return torrents.reduce((best, r) => (r.seeders > best.seeders ? r : best), torrents[0])
}

/** Resolve the SeasonData bucket a SeasonRef points at (null for complete). */
export function resolveSeasonBucket(data: SeriesData, ref: SeasonRef): SeasonData | null {
  if (ref.kind === 'complete') return null
  if (ref.kind === 'unsorted') return data.unsorted
  return data.seasons.get(ref.season) ?? null
}

/** "1-5" for contiguous runs, "1, 3, 5" otherwise. */
export function seasonsLabel(seasons: number[]): string {
  if (seasons.length === 0) return '—'
  const sorted = [...seasons].sort((a, b) => a - b)
  if (sorted.length > 1 && sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) {
    return `${sorted[0]}-${sorted[sorted.length - 1]}`
  }
  return sorted.join(', ')
}
