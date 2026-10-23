/**
 * Shared domain types for torrential — TV-first, dual-mode edition.
 *
 * A search returns rows shaped by toTvResult() (see utils/tv.ts): episodic
 * rows carry show/scope and group into SERIES → SEASONS → EPISODES/PACKS;
 * rows that do not parse as episodic content (movies, junk) survive as
 * GENERIC rows (scope === undefined) — the session's content mode decides
 * how they are treated (see SearchMode below).
 *
 * Every row also carries a classifier verdict (media, see
 * utils/classify.ts) so the auto-mode router can send movie-heavy result
 * sets to the flat movie list instead of the TV tiers.
 */

import type { MediaKind } from './utils/classify.js'

export interface QualityInfo {
  resolution?: string
  codec?: string
  source?: string
}

/* ------------------------------------------------------------------ *
 * TV scope — what a torrent (or a file inside it) covers
 * ------------------------------------------------------------------ */

/**
 * Parsed season/episode coverage of a torrent title or file name.
 * Produced by parseTvTitle() in utils/tv.ts.
 */
export type TvScope =
  | {
      kind: 'episode'
      /** null = absolute numbering with no season marker (anime style). */
      season: number | null
      episode: number
      /** Present for multi-episode files ("S02E05-E08"). */
      episodes?: number[]
    }
  | {
      kind: 'pack'
      /** Season numbers covered; empty + complete = whole series. */
      seasons: number[]
      /** True for "Complete Series" / "S01-S05" collections. */
      complete?: boolean
    }

/** One row of the results table. */
export interface SearchResult {
  /** Stable dedupe id: infoHash when known, else `${provider}:${normalizedTitle}:${sizeBytes}`. */
  id: string
  provider: string
  title: string
  seeders: number
  leechers: number
  sizeBytes: number
  quality: QualityInfo
  /** Human readable upload date when the source exposes it. */
  uploaded?: string
  infoHash?: string
  /** Immediately available magnet (Pirate Bay builds these from info hashes). */
  magnet?: string
  /** Detail page URL for scrapers that resolve magnets lazily. */
  detailUrl?: string
  /** Lazily resolve a magnet link (memoized by the provider). */
  fetchMagnet?: () => Promise<string>

  /* ── TV shaping (attached by toTvResult in utils/tv.ts) ── */

  /** Cleaned, display-ready show name ("Breaking Bad"). TV rows always carry it. */
  show?: string
  /**
   * Parsed season/episode coverage. scope === undefined means a generic
   * (movie/junk) row, kept in auto/movies modes (see SearchMode).
   */
  scope?: TvScope
  /** Compact display label for the scope ("S02E05", "Season 2", "Complete"). */
  scopeLabel?: string

  /* ── media classification (attached by the aggregator) ── */

  /**
   * Classifier verdict for the raw release title (utils/classify.ts).
   * 'movie' rows feed the flat movie list; 'episode'/'season-pack' rows
   * feed the TV tiers; 'unknown' degrades silently to the 2.0.0 flow.
   */
  media?: { kind: MediaKind; confidence: number }
}

/* ------------------------------------------------------------------ *
 * Content mode
 * ------------------------------------------------------------------ */

/**
 * Session content mode — what the hunt targets.
 *
 * Providers read it to pick their search route (1337x uses its TV category
 * scrape in 'tv' mode, the plain catalogue search in 'auto'/'movies'). Rows
 * are TAGGED, not filtered, in this release: mode-aware list filtering is
 * the next roadmap step.
 */
export type SearchMode = 'auto' | 'tv' | 'movies'

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

export interface ProviderInfo {
  id: string
  label: string
  host: string
  /**
   * Where results come from. 'torrent' rows are resolved to magnets and
   * streamed peer-to-peer; the 'api' slot is reserved for future
   * API-backed streaming backends (debrid / direct media APIs) that can
   * slot into the same search pipeline without touching the UI.
   */
  kind?: 'torrent' | 'api'
}

export type ProviderState = 'pending' | 'running' | 'done' | 'error'

export interface ProviderStatus extends ProviderInfo {
  state: ProviderState
  count: number
  error?: string
}

export type SearchEvent =
  | { type: 'provider-start'; provider: ProviderInfo }
  | { type: 'provider-done'; provider: ProviderInfo; count: number }
  | { type: 'provider-error'; provider: ProviderInfo; error: string }
  | { type: 'results'; provider: ProviderInfo; results: SearchResult[] }
  | { type: 'all-done' }

export interface Provider {
  info: ProviderInfo
  search(query: string, opts: { timeoutMs: number; x1337Mirrors?: string[]; mode?: SearchMode }): Promise<SearchResult[]>
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

/**
 * Which file inside a torrent the engine should stream.
 *
 *  - auto:    engine decides — single video file plays directly; a
 *             multi-file season pack flips the UI into the interactive
 *             file picker (unless one file dwarfs the rest, e.g. samples)
 *  - episode: match the season/episode against FILE names (SxxExx,
 *             1xx and absolute-numbering forms all understood)
 *  - file:    exact index, as picked interactively
 */
export type StreamTarget =
  | { kind: 'auto' }
  | { kind: 'episode'; season: number | null; episode: number }
  | { kind: 'file'; fileIndex: number }

/** One file inside a torrent, as listed by the engine / file picker. */
export interface TorrentFileInfo {
  /** Index inside torrent.files — the value selectFile() expects. */
  index: number
  name: string
  path: string
  length: number
  isVideo: boolean
  /** TV scope parsed from the FILE name (episode packs label per file). */
  scope?: TvScope
  scopeLabel?: string
}

/** Live snapshot rendered by the stream screen. */
export interface StreamStats {
  phase: 'connecting' | 'metadata' | 'picking' | 'ready' | 'streaming' | 'done' | 'error' | 'stopped'
  /** Torrent display name (may be the info hash until metadata arrives). */
  title: string
  fileName: string
  fileSize: number
  fileIndex: number
  /** Total files / video files inside the torrent (season-pack context). */
  fileCount: number
  videoFileCount: number
  /** Local HTTP endpoint the player is pointed at. */
  url: string | null
  port: number
  /** Buffering progress of the target file (0..1). */
  progress: number
  /** Whole-torrent progress (0..1). */
  overallProgress: number
  downloaded: number
  downloadSpeed: number
  uploadSpeed: number
  peers: number
  timeRemaining: number
  warnings: string[]
  /** True while the turbo serving layer (playhead windows) is active. */
  turbo: boolean
  /** Estimated seconds of video ready in cache ahead of the playhead. */
  bufferAheadSecs: number | null
  /**
   * Multi-file torrent waiting on the interactive file picker: `files`
   * carries the candidate list; the UI calls engine.selectFile(index).
   */
  awaitingFile: boolean
  files?: TorrentFileInfo[]
  /**
   * Which backend is serving this stream. 'torrent' today; 'api' is the
   * reserved slot for a future direct-streaming fallback service.
   */
  backend: 'torrent' | 'api'
  error?: string
  /** Actionable next step shown with the error (dead swarm, port clash…). */
  errorHint?: string
}

export interface ReadyInfo {
  url: string
  title: string
  fileName: string
  fileSize: number
  fileIndex: number
  port: number
}

/** A file preserved via --keep: moved out of the cache before it is wiped. */
export interface KeptFile {
  fileName: string
  destPath: string
  sizeBytes: number
  /** Download completion 0..1 at the moment playback stopped. */
  progress: number
}
