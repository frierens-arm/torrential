import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PROVIDER_IDS, MODE_IDS } from './constants.js'
import type { SearchMode } from './types.js'

export interface TorrentialConfig {
  /** 'system' | 'mpv' | 'vlc' | 'iina' | absolute path to a player binary. */
  default_player: string
  /** Extra CLI flags passed to binary players (ignored for 'system'). */
  player_flags: string[]
  /** Fallback chain used when the primary player cannot be launched. */
  player_fallbacks: string[]
  /** Where piece caches are written while streaming. */
  cache_directory: string
  /** Where --keep parks finished files (~/Movies/torrential by default). */
  keep_directory: string
  /** Local streaming server port (8000 by default). */
  port: number
  /** Keep cached pieces after exit instead of wiping them. */
  keep_cache: boolean
  /** Maximum rows kept in the results table. */
  max_results: number
  /** Enabled search providers (ids). */
  providers: string[]
  /** Seconds to wait for torrent metadata before declaring the swarm dead. */
  metadata_timeout: number
  /** Seconds before a provider search is abandoned. */
  search_timeout: number
  /** Turbo serving: custom HTTP layer with playhead-driven piece windows. */
  turbo: boolean
  /** Max peer connections per torrent (higher = more aggregate bandwidth). */
  max_conns: number
  /** RAM budget (MB) for the in-memory piece cache in front of disk. 0 = default. */
  ram_cache_mb: number
  /** Upload cap in kbps; 0 = unlimited. Capping helps slow ASYMMETRIC links. */
  upload_limit_kbps: number
  /** Head-start megabytes fetched before the player opens (first-frame path). */
  head_start_mb: number
  /** Tail megabytes fetched in parallel (MP4 moov / MKV Cues live at the end). */
  tail_prefetch_mb: number
  /** Rolling window target: seconds of video kept ahead of the playhead. */
  window_secs: number
  /** Active UI skin id (see themes.ts). Persisted by /theme <name>. */
  theme: string
  /**
   * Session content mode: 'auto' (shows + movies), 'tv' or 'movies'.
   * Persisted by /mode <name>; --mode wins for one session.
   */
  mode: SearchMode
  /** Extra 1337x mirrors/proxies tried FIRST (before the built-in list). */
  x1337_mirrors: string[]
}

export const DEFAULT_CONFIG: TorrentialConfig = {
  default_player: 'system',
  player_flags: [],
  player_fallbacks: ['mpv', 'vlc', 'iina'],
  cache_directory: '',
  keep_directory: '',
  port: 8000,
  keep_cache: false,
  max_results: 40,
  providers: ['piratebay', '1337x', 'nyaa'],
  metadata_timeout: 45,
  search_timeout: 12,
  turbo: true,
  max_conns: 200,
  ram_cache_mb: 256,
  upload_limit_kbps: 0,
  head_start_mb: 4,
  tail_prefetch_mb: 2,
  window_secs: 30,
  theme: 'rain',
  mode: 'auto',
  x1337_mirrors: []
}

/* ------------------------------------------------------------------ *
 * Content mode helpers
 * ------------------------------------------------------------------ */

/**
 * Resolve a user-typed mode name (config file, --mode, /mode) to a known
 * id. Returns null for anything unknown so callers can warn and fall back
 * to 'auto' — the same contract normalizeThemeName has for skins.
 */
export function normalizeModeName(value: string): SearchMode | null {
  const key = value.trim().toLowerCase()
  return (MODE_IDS as readonly string[]).includes(key) ? (key as SearchMode) : null
}

/* ------------------------------------------------------------------ *
 * Paths (XDG on Linux/macOS, known folders on Windows)
 * ------------------------------------------------------------------ */

function isWindows(): boolean {
  return process.platform === 'win32'
}

export function configDir(): string {
  if (isWindows()) {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'torrential')
  }
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg ? path.resolve(os.homedir(), xdg) : path.join(os.homedir(), '.config')
  return path.join(base, 'torrential')
}

export function configPath(): string {
  return path.join(configDir(), 'config.json')
}

export function defaultCacheDir(): string {
  if (isWindows()) {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'torrential', 'cache')
  }
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg ? path.resolve(os.homedir(), xdg) : path.join(os.homedir(), '.cache')
  return path.join(base, 'torrential')
}

/** Where --keep puts saved movies: inside the OS media folder. */
export function defaultKeepDir(): string {
  const home = os.homedir()
  if (isWindows()) return path.join(home, 'Videos', 'torrential')
  if (process.platform === 'darwin') return path.join(home, 'Movies', 'torrential')
  return path.join(home, 'Videos', 'torrential')
}

/* ------------------------------------------------------------------ *
 * Loading, validating, saving
 * ------------------------------------------------------------------ */

function coerceStringArray(value: unknown, field: string, warnings: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[]
  warnings.push(`config: "${field}" must be an array of strings — ignoring it`)
  return undefined
}

function coerceNumber(value: unknown, field: string, min: number, max: number, warnings: string[]): number | undefined {
  if (value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    warnings.push(`config: "${field}" must be a number between ${min} and ${max} — ignoring it`)
    return undefined
  }
  return Math.round(n)
}

export interface LoadConfigResult {
  config: TorrentialConfig
  /** Non-fatal problems (bad values, malformed JSON…) shown as a banner in the TUI. */
  warnings: string[]
  /** True when the file was created fresh on this run. */
  created: boolean
}

/**
 * Load ~/.config/torrential/config.json, validating and merging over the
 * defaults. A missing file is created with defaults so users can discover it.
 */
export function loadConfig(explicitPath?: string): LoadConfigResult {
  const warnings: string[] = []
  const file = explicitPath ?? configPath()
  const config: TorrentialConfig = {
    ...DEFAULT_CONFIG,
    cache_directory: defaultCacheDir(),
    keep_directory: defaultKeepDir()
  }

  let created = false
  let raw: string | undefined
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    // First run (or unreadable) → materialize defaults next to the user.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
      created = true
    } catch (err) {
      warnings.push(`could not write config to ${file}: ${(err as Error).message}`)
    }
  }

  if (raw !== undefined) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      warnings.push(
        `config file at ${file} is not valid JSON (${(err as Error).message}) — using defaults`
      )
      parsed = {}
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      if (typeof parsed.default_player === 'string') config.default_player = parsed.default_player.trim()
      else if (parsed.default_player !== undefined) warnings.push('config: "default_player" must be a string — ignoring it')

      config.player_flags = coerceStringArray(parsed.player_flags, 'player_flags', warnings) ?? config.player_flags
      config.player_fallbacks =
        coerceStringArray(parsed.player_fallbacks, 'player_fallbacks', warnings) ?? config.player_fallbacks

      // v1.3.1: unknown provider ids used to be dropped SILENTLY — a typo like
      // "1337" instead of "1337x" meant the source just never ran. Validate loudly.
      const providers = coerceStringArray(parsed.providers, 'providers', warnings)
      if (providers) {
        const known = new Set<string>(PROVIDER_IDS)
        const valid: string[] = []
        for (const id of providers) {
          if (known.has(id)) {
            if (!valid.includes(id)) valid.push(id)
          } else {
            const hint = id.replace(/[^a-z0-9]/gi, '').toLowerCase()
            const close = PROVIDER_IDS.find(p => p.toLowerCase().includes(hint) && hint.length >= 3)
            warnings.push(`config: unknown source "${id}" — ignoring it${close ? ` (did you mean "${close}"?)` : ' (valid: piratebay, 1337x, nyaa)'}`)
          }
        }
        config.providers = valid.length > 0 ? valid : config.providers
        if (valid.length === 0 && providers.length > 0) {
          warnings.push('config: "providers" has no valid sources — falling back to defaults (piratebay, 1337x, nyaa)')
        }
      }

      const port = coerceNumber(parsed.port, 'port', 1, 65535, warnings)
      if (port !== undefined) config.port = port
      const maxResults = coerceNumber(parsed.max_results, 'max_results', 5, 250, warnings)
      if (maxResults !== undefined) config.max_results = maxResults
      const metadataTimeout = coerceNumber(parsed.metadata_timeout, 'metadata_timeout', 5, 600, warnings)
      if (metadataTimeout !== undefined) config.metadata_timeout = metadataTimeout
      const searchTimeout = coerceNumber(parsed.search_timeout, 'search_timeout', 3, 120, warnings)
      if (searchTimeout !== undefined) config.search_timeout = searchTimeout

      const maxConns = coerceNumber(parsed.max_conns, 'max_conns', 5, 2000, warnings)
      if (maxConns !== undefined) config.max_conns = maxConns
      const ramCacheMb = coerceNumber(parsed.ram_cache_mb, 'ram_cache_mb', 0, 8192, warnings)
      if (ramCacheMb !== undefined) config.ram_cache_mb = ramCacheMb
      const uploadLimitKbps = coerceNumber(parsed.upload_limit_kbps, 'upload_limit_kbps', 0, 10_000_000, warnings)
      if (uploadLimitKbps !== undefined) config.upload_limit_kbps = uploadLimitKbps
      const headStartMb = coerceNumber(parsed.head_start_mb, 'head_start_mb', 0, 512, warnings)
      if (headStartMb !== undefined) config.head_start_mb = headStartMb
      const tailPrefetchMb = coerceNumber(parsed.tail_prefetch_mb, 'tail_prefetch_mb', 0, 512, warnings)
      if (tailPrefetchMb !== undefined) config.tail_prefetch_mb = tailPrefetchMb
      const windowSecs = coerceNumber(parsed.window_secs, 'window_secs', 5, 600, warnings)
      if (windowSecs !== undefined) config.window_secs = windowSecs

      if (typeof parsed.turbo === 'boolean') config.turbo = parsed.turbo
      else if (parsed.turbo !== undefined) warnings.push('config: "turbo" must be true or false — ignoring it')

      if (typeof parsed.theme === 'string' && parsed.theme.trim().length > 0) {
        config.theme = parsed.theme.trim()
      } else if (parsed.theme !== undefined) {
        warnings.push('config: "theme" must be a skin name (try /theme in the search bar) — ignoring it')
      }

      // Content mode: a closed set, validated like theme — an unknown value
      // warns and falls back to 'auto' instead of poisoning the session.
      const mode = typeof parsed.mode === 'string' ? normalizeModeName(parsed.mode) : null
      if (mode !== null) {
        config.mode = mode
      } else if (parsed.mode !== undefined) {
        warnings.push(`config: "mode" must be one of ${MODE_IDS.join(', ')} — falling back to "auto"`)
      }

      config.x1337_mirrors =
        coerceStringArray(parsed.x1337_mirrors, 'x1337_mirrors', warnings) ?? config.x1337_mirrors

      if (typeof parsed.keep_cache === 'boolean') config.keep_cache = parsed.keep_cache
      else if (parsed.keep_cache !== undefined) warnings.push('config: "keep_cache" must be true or false — ignoring it')

      if (typeof parsed.cache_directory === 'string' && parsed.cache_directory.trim().length > 0) {
        config.cache_directory = parsed.cache_directory
      } else if (parsed.cache_directory !== undefined) {
        warnings.push('config: "cache_directory" must be a non-empty string — ignoring it')
      }

      if (typeof parsed.keep_directory === 'string' && parsed.keep_directory.trim().length > 0) {
        config.keep_directory = parsed.keep_directory
      } else if (parsed.keep_directory !== undefined) {
        warnings.push('config: "keep_directory" must be a non-empty string — ignoring it')
      }

      const known = new Set(Object.keys(DEFAULT_CONFIG))
      for (const key of Object.keys(parsed)) {
        if (!known.has(key)) warnings.push(`config: unknown key "${key}" — ignoring it`)
      }
    } else if (raw.trim().length > 0) {
      warnings.push(`config file at ${file} must contain a JSON object — using defaults`)
    }
  }

  return { config, warnings, created }
}

/** Persist a config back to disk (used by --default-player, /theme and /mode). */
export function saveConfig(config: TorrentialConfig, explicitPath?: string): void {
  const file = explicitPath ?? configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
}
