import { TRACKERS } from '../constants.js'

export interface ParsedMagnet {
  infoHash?: string
  displayName?: string
}

/** Parse the useful bits out of a magnet URI. */
export function parseMagnet(uri: string): ParsedMagnet {
  const out: ParsedMagnet = {}
  const xt = /urn:btih:([a-z0-9]+)/i.exec(uri)
  if (xt) out.infoHash = xt[1].toLowerCase()
  const dn = /[?&]dn=([^&]*)/i.exec(uri)
  if (dn) out.displayName = decodeURIComponent(dn[1].replace(/\+/g, ' '))
  return out
}

/** Build a magnet URI from an info hash + display name + our tracker list. */
export function buildMagnet(infoHash: string, displayName?: string): string {
  const parts = [`xt=urn:btih:${infoHash}`]
  if (displayName) parts.push(`dn=${encodeURIComponent(displayName)}`)
  for (const tr of TRACKERS) parts.push(`tr=${encodeURIComponent(tr)}`)
  return `magnet:?${parts.join('&')}`
}

/**
 * Recognize a torrent id typed/pasted into the search bar:
 * magnet URI, 40-hex info hash, 32-char base32 info hash, or a http(s) .torrent URL.
 * Returns a normalized torrent id (magnet or URL) or null when it is a plain query.
 */
export function looksLikeTorrentId(text: string): string | null {
  const t = text.trim()
  if (/^magnet:\?/i.test(t)) return t
  if (/^[a-f0-9]{40}$/i.test(t)) return buildMagnet(t.toLowerCase())
  if (/^[a-z2-7]{32}$/i.test(t) && /[2-7]/.test(t)) return buildMagnet(t.toLowerCase())
  if (/^https?:\/\/\S+\.torrent\b/i.test(t)) return t
  return null
}

/**
 * Canonical 40-hex info-hash for a torrent id (magnet URI, bare hex hash, or
 * base32 hash). Returns null for URLs and anything unparseable. Used to key
 * the on-disk metadata cache.
 */
export function infoHashFromId(id: string): string | null {
  const t = id.trim()
  const isMagnet = /^magnet:\?/i.test(t)
  if (/^https?:\/\//i.test(t)) return null
  const xt = isMagnet ? /urn:btih:([a-z0-9]+)/i.exec(t) : null
  const raw = xt ? xt[1] : isMagnet ? null : t
  if (!raw) return null
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase()
  if (/^[a-z2-7]{32}$/i.test(raw) && /[2-7]/.test(raw)) return base32ToHex(raw.toLowerCase())
  return null
}

/** RFC 4648 base32 (a-z2-7) → 40-char lowercase hex; null on bad input. */
export function base32ToHex(input: string): string | null {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of input) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return out.length === 20 ? Buffer.from(out).toString('hex') : null
}

/** Short, display-safe identifier for a torrent id (magnet or URL). */
export function describeTorrentId(id: string): string {
  const parsed = parseMagnet(id)
  if (parsed.displayName) return parsed.displayName
  if (parsed.infoHash) return parsed.infoHash.slice(0, 16) + '…'
  return id.length > 48 ? id.slice(0, 45) + '…' : id
}
