import type { QualityInfo } from '../types.js'

/* ------------------------------------------------------------------ *
 * Byte / speed / duration formatting
 * ------------------------------------------------------------------ */

const SIZE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

/** Parse "1.4 GB", "756 MB", "890.55kB", "1.02 GiB" (binary) etc. into bytes. */
export function parseSize(text: string): number {
  const m = /([\d.]+)\s*([a-z]*)/i.exec(text.replace(/,/g, ''))
  if (!m) return 0
  const value = Number.parseFloat(m[1])
  if (!Number.isFinite(value)) return 0
  const rawUnit = m[2].toLowerCase()
  const binary = /i/.test(rawUnit) // 'GiB', 'MiB', 'KiB' — base 1024
  const unit = rawUnit.replace(/i?b$/, '') // 'gib'→'g', 'gb'→'g', 'b'→'', 'k'→'k'
  const idx = ['', 'k', 'm', 'g', 't', 'p'].indexOf(unit)
  if (idx < 0) return Math.round(value)
  return Math.round(value * Math.pow(binary ? 1024 : 1000, idx))
}

/** Format bytes as a compact human string (base-1000, like the indexers use). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  let v = bytes
  let i = 0
  while (v >= 1000 && i < SIZE_UNITS.length - 1) {
    v /= 1000
    i++
  }
  if (i === 0) return `${Math.round(v)} B`
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
  return `${trimZeros(v.toFixed(digits))} ${SIZE_UNITS[i]}`
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** Format a byte-per-second rate. */
export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSec)}/s`
}

/** Format milliseconds as a compact playback ETA. */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 1000 * 60 * 60 * 24 * 7) return '—'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** Unix seconds → short relative age ("3h ago"). Empty for missing/invalid dates. */
export function relativeFromUnix(unixSec: number): string {
  // v1.3.1: 0 / negative / NaN used to render as "56y ago" on rows where
  // the source never supplied an upload date — treat it as missing instead.
  if (!Number.isFinite(unixSec) || unixSec <= 0) return ''
  const delta = Date.now() / 1000 - unixSec
  if (!Number.isFinite(delta) || delta < 0) return ''
  const abs = Math.floor(delta)
  if (abs < 60) return 'just now'
  if (abs < 3600) return `${Math.floor(abs / 60)}m ago`
  if (abs < 86400) return `${Math.floor(abs / 3600)}h ago`
  if (abs < 86400 * 30) return `${Math.floor(abs / 86400)}d ago`
  if (abs < 86400 * 365) return `${Math.floor(abs / (86400 * 30))}mo ago`
  return `${Math.floor(abs / (86400 * 365))}y ago`
}

/* ------------------------------------------------------------------ *
 * Title heuristics — quality badges
 * ------------------------------------------------------------------ */

const RESOLUTIONS: Array<[RegExp, string]> = [
  [/\b(2160p|4k|uhd)\b/i, '4K'],
  [/\b(1080[pi])\b/i, '1080p'],
  [/\b(720[pi])\b/i, '720p'],
  [/\b(480[pi]|sd)\b/i, '480p']
]

const CODECS: Array<[RegExp, string]> = [
  [/\b(x265|h\.?265|hevc)\b/i, 'x265'],
  [/\b(x264|h\.?264|avc)\b/i, 'x264'],
  [/\b(av1)\b/i, 'AV1'],
  [/\b(vp9?)\b/i, 'VP9'],
  [/\b(xvid|divx)\b/i, 'XviD']
]

const SOURCES: Array<[RegExp, string]> = [
  [/\b(bluray|blu-?ray|bdrip|brrip|bdremux)\b/i, 'BluRay'],
  [/\b(web-?dl|webrip|web\s?rip)\b/i, 'WEB'],
  [/\b(hdtv|pdtv)\b/i, 'HDTV'],
  [/\b(dvdrip|dvd)\b/i, 'DVD'],
  [/\b(hdcam|hd-?cam|camrip|cam|telesync|ts|screener)\b/i, 'CAM']
]

/** Extract a compact quality profile from a release title. */
export function parseQuality(title: string): QualityInfo {
  const find = (table: Array<[RegExp, string]>): string | undefined =>
    table.find(([re]) => re.test(title))?.[1]
  return {
    resolution: find(RESOLUTIONS),
    codec: find(CODECS),
    source: find(SOURCES)
  }
}

/** "1080p · WEB · x264" style badge; empty string when nothing matched. */
export function qualityBadge(q: QualityInfo): string {
  return [q.resolution, q.source, q.codec].filter(Boolean).join('·')
}

/* ------------------------------------------------------------------ *
 * Terminal-safe string helpers
 *
 * v1.3.1: padding/truncation is now display-width aware — a CJK glyph
 * (anime titles from nyaa!) occupies two columns, so counting UTF-16
 * code units let rows overflow their cells and rag the table edges.
 * ------------------------------------------------------------------ */

/** Number of terminal columns a string occupies (CJK = 2, combining marks = 0). */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0) continue
    // combining marks & zero-width
    if (code >= 0x0300 && code <= 0x036f) continue
    if (code >= 0x200b && code <= 0x200f) continue
    if (code >= 0xfe00 && code <= 0xfe0f) continue
    // wide / fullwidth ranges (CJK, Hangul, Kana, fullwidth forms)
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      width += 2
      continue
    }
    width += 1
  }
  return width
}

/** Truncate to a visual width, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 1) return displayWidth(text) > max ? '…' : text
  if (displayWidth(text) <= max) return text
  let width = 0
  let cut = 0
  for (const ch of text) {
    const w = ch.codePointAt(0) !== undefined ? charWidth(ch) : 1
    if (width + w > max - 1) break
    width += w
    cut += ch.length
  }
  return text.slice(0, cut) + '…'
}

/** Truncate from the left, keeping the tail — right shape for file paths. */
export function truncateStart(text: string, max: number): string {
  if (max <= 1) return displayWidth(text) > max ? '…' : text
  if (displayWidth(text) <= max) return text
  let width = 0
  let cut = text.length
  const chars = [...text]
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i])
    if (width + w > max - 1) break
    width += w
    cut -= chars[i].length
  }
  return '…' + text.slice(cut)
}

function charWidth(ch: string): number {
  return displayWidth(ch) || 1
}

/** Left-pad to a display width for right-aligned table cells. */
export function padStart(text: string, len: number): string {
  if (displayWidth(text) >= len) return truncate(text, len)
  return ' '.repeat(len - displayWidth(text)) + text
}

/** Right-pad to a display width for left-aligned table cells. */
export function padEnd(text: string, len: number): string {
  if (displayWidth(text) >= len) return truncate(text, len)
  return text + ' '.repeat(len - displayWidth(text))
}

/** Seed-count health color used across the table and detail views. */
export function seedColor(seeders: number): string {
  if (seeders <= 0) return '#f87171'
  if (seeders < 10) return '#fbbf24'
  if (seeders < 100) return '#a3e635'
  return '#4ade80'
}

/* ------------------------------------------------------------------ *
 * Provider error summarization
 * ------------------------------------------------------------------ */

/**
 * Collapse a provider error into one short word for the status chips,
 * so a blocked scraper reads as "✗ 1337x blocked" instead of a truncated
 * wall of red text above the results. The full message moves to the
 * dim footnote below the table.
 */
export function shortProviderError(error: string | undefined): string {
  if (!error) return 'failed'
  if (/HTTP 40[35]/i.test(error)) return 'blocked'
  if (/HTTP 429/.test(error)) return 'rate-limited'
  if (/timed out/i.test(error)) return 'timeout'
  if (/network unreachable/i.test(error)) return 'unreachable'
  if (/malformed JSON/i.test(error)) return 'bad response'
  if (/magnet link not found/i.test(error)) return 'no magnet'
  if (/did not respond|mirrors did not respond/i.test(error)) return 'no answer'
  return 'failed'
}
