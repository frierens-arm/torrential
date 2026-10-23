import * as cheerio from 'cheerio'
import type { Provider, SearchResult } from '../types.js'
import { MIRRORS } from '../constants.js'
import { fetchText } from '../utils/http.js'
import { parseQuality, parseSize } from '../utils/format.js'

interface NyaaRow {
  title: string
  detailUrl: string
  magnet?: string
  seeders: number
  leechers: number
  sizeBytes: number
  uploaded?: string
}

/**
 * Column layout (verified against live HTML):
 *   0 category icon · 1 name (colspan 2) · 2 torrent/magnet links
 *   3 size · 4 date · 5 seeders · 6 leechers · 7 downloads
 * Nyaa embeds the magnet right in the results row — no detail round-trip.
 */
function parseNyaaPage(html: string, base: string): NyaaRow[] {
  const $ = cheerio.load(html)
  const rows: NyaaRow[] = []
  $('table.torrent-list tbody tr').each((_i, tr) => {
    const row = $(tr)
    const cells = row.children('td')
    if (cells.length < 7) return

    const titleLink = cells.eq(1).find('a:not(.comments)').first()
    const title = titleLink.text().replace(/\s+/g, ' ').trim()
    const href = titleLink.attr('href')
    if (!title || !href) return

    const magnet = row.find('a[href^="magnet:?"]').first().attr('href')

    rows.push({
      title,
      detailUrl: new URL(href, base).toString(),
      magnet: magnet && /^magnet:\?/i.test(magnet) ? magnet : undefined,
      seeders: Number.parseInt(cells.eq(5).text().replace(/\D/g, ''), 10) || 0,
      leechers: Number.parseInt(cells.eq(6).text().replace(/\D/g, ''), 10) || 0,
      sizeBytes: parseSize(cells.eq(3).text().trim()),
      uploaded: cells.eq(4).text().replace(/\s+/g, ' ').trim() || undefined
    })
  })
  return rows
}

/** Fallback: fetch the magnet off a nyaa detail page. */
async function fetchNyaaMagnet(detailUrl: string, timeoutMs: number): Promise<string> {
  const html = await fetchText(detailUrl, { timeoutMs })
  const $ = cheerio.load(html)
  const magnet = $('a[href^="magnet:?"]').first().attr('href')
  if (!magnet || !/^magnet:\?/i.test(magnet)) {
    throw new Error('magnet link not found on detail page')
  }
  return magnet
}

/** Nyaa.si — anime & J-media specialist. */
export const nyaaProvider: Provider = {
  info: { id: 'nyaa', label: 'nyaa', host: 'nyaa.si', kind: 'torrent' },

  async search(query, opts): Promise<SearchResult[]> {
    let html: string
    try {
      const url = `${MIRRORS.nyaa[0]}/?f=0&c=0_0&q=${encodeURIComponent(query)}&s=seeders&o=desc`
      html = await fetchText(url, { timeoutMs: opts.timeoutMs })
    } catch (err) {
      // Retry without the server-side sort (some mirrors ignore params).
      html = await fetchText(`${MIRRORS.nyaa[0]}/?f=0&c=0_0&q=${encodeURIComponent(query)}`, {
        timeoutMs: opts.timeoutMs
      })
    }
    const rows = parseNyaaPage(html, MIRRORS.nyaa[0])
    const sorted = rows.sort((a, b) => b.seeders - a.seeders).slice(0, 60)

    return sorted.map(r => {
      // Magnets usually ride along with the row; fall back to a lazy detail fetch.
      let cached: Promise<string> | null = null
      const fetchMagnet = (): Promise<string> => {
        if (r.magnet) return Promise.resolve(r.magnet)
        if (!cached) {
          cached = fetchNyaaMagnet(r.detailUrl, opts.timeoutMs).catch(err => {
            cached = null
            throw err
          })
        }
        return cached
      }
      return {
        id: `nyaa:${r.detailUrl}`,
        provider: 'nyaa',
        title: r.title,
        seeders: r.seeders,
        leechers: r.leechers,
        sizeBytes: r.sizeBytes,
        quality: parseQuality(r.title),
        uploaded: r.uploaded,
        magnet: r.magnet,
        detailUrl: r.detailUrl,
        fetchMagnet
      } satisfies SearchResult
    })
  }
}
