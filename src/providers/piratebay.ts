import type { Provider, SearchResult } from '../types.js'
import { fetchJson } from '../utils/http.js'
import { buildMagnet } from '../utils/magnet.js'
import { parseQuality } from '../utils/format.js'
import { relativeFromUnix } from '../utils/format.js'

interface ApibayRow {
  id: string
  name: string
  info_hash: string
  seeders: string
  leechers: string
  size: string
  username: string
  added: string
  cat: string
  status?: string
}

const VIDEO_CATS = (cat: number): boolean => cat >= 200 && cat < 300

/**
 * Pirate Bay via the unofficial-but-stable apibay.org JSON API.
 * Magnets are built locally from the info hash, so every result is
 * immediately streamable — no detail page round-trip.
 */
export const piratebayProvider: Provider = {
  info: { id: 'piratebay', label: 'piratebay', host: 'apibay.org', kind: 'torrent' },

  async search(query, opts): Promise<SearchResult[]> {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&num=100`
    const data = await fetchJson<ApibayRow[] | Record<string, unknown>>(url, {
      timeoutMs: opts.timeoutMs
    })

    // apibay answers with a single object (no array) on empty results.
    const rows = Array.isArray(data)
      ? data
      : []
    const usable = rows.filter(
      r =>
        r &&
        typeof r.name === 'string' &&
        r.name.length > 0 &&
        !/^no results/i.test(r.name) &&
        typeof r.info_hash === 'string' &&
        /^[a-f0-9]{40}$/i.test(r.info_hash)
    )
    if (usable.length === 0) return []

    const video = usable.filter(r => VIDEO_CATS(Number(r.cat)))
    const source = video.length > 0 ? video : usable

    return source.map(r => {
      const seeders = Number.parseInt(r.seeders, 10) || 0
      const sizeBytes = Number.parseInt(r.size, 10) || 0
      const title = r.name.trim()
      const infoHash = r.info_hash.toLowerCase()
      return {
        id: `piratebay:${infoHash}`,
        provider: 'piratebay',
        title,
        seeders,
        leechers: Number.parseInt(r.leechers, 10) || 0,
        sizeBytes,
        quality: parseQuality(title),
        uploaded: relativeFromUnix(Number.parseInt(r.added, 10) || 0) || undefined,
        infoHash,
        magnet: buildMagnet(infoHash, title)
      } satisfies SearchResult
    })
  }
}
