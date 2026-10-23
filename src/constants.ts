import { VERSION } from './version.js'

/** Public trackers appended to every magnet we construct or normalize. */
export const TRACKERS: string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'wss://tracker.openwebtorrent.com'
]

/** Browser-ish UA keeps scrapers happy; we still identify ourselves at the end. */
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0 torrential/' + VERSION

/** File extensions we are willing to stream. */
export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.mpg', '.mpeg',
  '.wmv', '.flv', '.ts', '.ogv', '.3gp', '.m2ts', '.mts'
])

/** Ordered mirrors tried per scraper. */
export const MIRRORS: Record<string, string[]> = {
  x1337: ['https://1337x.to', 'https://www.1377x.to', 'https://www.1337xx.to', 'https://1337x.st'],
  nyaa: ['https://nyaa.si']
}

/** All provider ids in display order. */
export const PROVIDER_IDS = ['piratebay', '1337x', 'nyaa'] as const

/** Valid content-mode ids (config "mode" · --mode · /mode — see SearchMode). */
export const MODE_IDS = ['auto', 'tv', 'movies'] as const

/**
 * Visual language of torrential. The default "rain" palette is a
 * violet-to-cyan downpour, heavily inspired by torlink's dark-violet
 * wordmark aesthetic.
 *
 * THEME is a MUTABLE singleton: setTheme() (see themes.ts) overwrites its
 * properties in place so every component that reads THEME.* at render time
 * picks up the active skin without any prop drilling. It is intentionally
 * NOT `as const` — that would freeze the property types and block mutation.
 */
export interface ThemeSpec {
  /** logo gradient (6 stops, top → bottom) */
  gradient: string[]
  // accents
  pink: string
  violet: string
  indigo: string
  cyan: string
  blue: string
  // semantic
  green: string
  lime: string
  yellow: string
  red: string
  dim: string
  subtle: string
  // selection & chrome
  selBg: string
  border: string
  barEmpty: string
  /** Optional per-provider chip color overrides applied on activation. */
  providerColors?: Record<string, string>
}

export const THEME: ThemeSpec = {
  // logo gradient (pink → violet → indigo → cyan)
  gradient: ['#f0abfc', '#c084fc', '#a78bfa', '#8b5cf6', '#60a5fa', '#38bdf8'],
  // accents
  pink: '#f0abfc',
  violet: '#c084fc',
  indigo: '#818cf8',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  // semantic
  green: '#4ade80',
  lime: '#a3e635',
  yellow: '#fbbf24',
  red: '#f87171',
  dim: 'gray',
  subtle: '#7c6f94',
  // selection & chrome
  selBg: '#2e1a47',
  border: '#6d4fa8',
  barEmpty: '#4a4458'
}

/** Per-provider accent colors for chips and source columns. */
export const PROVIDER_COLORS: Record<string, string> = {
  piratebay: '#22d3ee',
  '1337x': '#c084fc',
  nyaa: '#f0abfc'
}

/** Short source tag shown in the results table. */
export const PROVIDER_SHORT: Record<string, string> = {
  piratebay: 'tpb',
  '1337x': '1337x',
  nyaa: 'nyaa'
}

/** Loading phrases rotated while the swarm is queried (TV flavored). */
export const DIVE_PHRASES = [
  'diving into the swarm',
  'asking apibay.org',
  'scraping 1337x for shows',
  'whispering to nyaa.si',
  'parsing SxxExx tags',
  'grouping episodes into seasons',
  'counting seeders',
  'sorting the downpour'
] as const
