import * as cheerio from 'cheerio'
import type { Provider, SearchResult } from '../types.js'
import { MIRRORS } from '../constants.js'
import { fetchText } from '../utils/http.js'
import { parseQuality, parseSize, relativeFromUnix } from '../utils/format.js'

interface ScrapeContext {
  base: string
  html: string
}

/**
 * Build the candidate mirror list: user-configured mirrors first (they are
 * chosen because they work in that user's region), then the built-ins.
 * A mirror may be:
 *   - a plain origin ("https://unblockit.example/1337x.to") → the search
 *     route is picked by the session mode: in tv mode the TV category
 *     search path is appended (`/category-search/<q>/TV/1/`), which keeps
 *     the swarm catalogue on shows; in movies/auto the plain catalogue
 *     search (`/search/<q>/1/`) is used — a first-class route now that
 *     generic (movie) rows survive the aggregator, and still the fallback
 *     when the TV category page is unavailable on a mirror
 *   - a template containing {query} ("https://p.example/s?q={query}") for
 *     sites whose search URL shape differs — used verbatim, since only the
 *     operator knows whether it is already TV-scoped
 */
export function x1337MirrorUrls(mirrors: string[], query: string, tvCategory = true): string[] {
  const q = encodeURIComponent(query)
  return mirrors.map(m => m.trim()).filter(Boolean).map(m => {
    if (m.includes('{query}')) return m.replace('{query}', q)
    const origin = m.replace(/\/+$/, '')
    return tvCategory
      ? `${origin}/category-search/${q}/TV/1/`
      : `${origin}/search/${q}/1/`
  })
}

/** Try each mirror until one answers with a parseable search table. */
async function loadSearchPage(
  query: string,
  timeoutMs: number,
  customMirrors: string[],
  tvCategory: boolean
): Promise<ScrapeContext> {
  const mirrors = [...customMirrors, ...MIRRORS.x1337]
  const failures: string[] = []
  for (const url of x1337MirrorUrls(mirrors, query, tvCategory)) {
    const base = new URL('/', url).toString()
    try {
      const html = await fetchText(url, { timeoutMs })
      const $ = cheerio.load(html)
      if ($('table tbody tr').length > 0) return { base, html }
      // A page with no rows can also mean "no results" on the primary mirror.
      if ($('.box-info').length > 0 || $('table').length > 0) return { base, html }
      failures.push(`${new URL(url).host}: page shape not recognized`)
    } catch (err) {
      failures.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // TV category pass exhausted → one plain-search pass before giving up
  // (some mirrors only expose the generic route). Only reachable when the
  // first pass was the category one; movies/auto START on plain search.
  if (tvCategory) return loadSearchPage(query, timeoutMs, customMirrors, false)
  const detail = failures.slice(0, 2).join(' · ')
  throw new Error(
    `all 1337x mirrors failed (${detail}). Your ISP may block these domains — ` +
      'DNS-over-HTTPS was already attempted as a bypass. Fixes: try a VPN, ' +
      'add a working mirror to config "x1337_mirrors", or use other sources (--sources tpb,nyaa)'
  )
}

interface Row337x {
  title: string
  detailUrl: string
  seeders: number
  leechers: number
  sizeBytes: number
  uploaded?: string
}

function parseRows(ctx: ScrapeContext): Row337x[] {
  const $ = cheerio.load(ctx.html)
  const rows: Row337x[] = []
  $('table tbody tr').each((_i, tr) => {
    const row = $(tr)
    const link = row.find('.name a[href*="/torrent/"]').first()
    const title = link.text().replace(/\s+/g, ' ').trim()
    const href = link.attr('href')
    if (!title || !href) return

    const seeders = Number.parseInt(row.find('.seeds').text().replace(/\D/g, ''), 10) || 0
    const leechers = Number.parseInt(row.find('.leeches').text().replace(/\D/g, ''), 10) || 0

    // The size cell embeds a hidden span (upload date) on narrow layouts.
    const sizeCell = row.find('.size').first().clone()
    sizeCell.children('span').remove()
    const sizeText = sizeCell.text().replace(/\s+/g, ' ').trim()
    const sizeBytes = parseSize(sizeText)

    const dateText = row.find('.date').first().text().replace(/\s+/g, ' ').trim()

    rows.push({
      title,
      detailUrl: new URL(href, ctx.base).toString(),
      seeders,
      leechers,
      sizeBytes,
      uploaded: dateText.length > 0 && dateText !== 'Unknown' ? dateText : undefined
    })
  })
  return rows
}

/** Fetch the magnet off a 1337x torrent detail page. */
async function fetchDetailMagnet(detailUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('aborted')
  const html = await fetchText(detailUrl, { timeoutMs })
  const $ = cheerio.load(html)
  const magnet = $('a[href^="magnet:?"]').first().attr('href')
  if (!magnet || !/^magnet:\?/i.test(magnet)) {
    throw new Error('magnet link not found on detail page')
  }
  return magnet
}

/** Upload-date text like "Apr. 12th '25" → short relative-ish label. */
function parseUploaded337x(text: string | undefined): string | undefined {
  if (!text) return undefined
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 1337x — largest general catalog, scraped politely:
 * one search page + lazy magnet resolution per selected row.
 *
 * Route by session mode: tv mode scrapes the TV category (keeps show
 * hunts clean); movies/auto scrape the full catalogue via the plain
 * search path — generic rows are kept by the aggregator now, so the
 * category scoping is a tv-mode preference, not a hard requirement.
 */
export const x1337Provider: Provider = {
  info: { id: '1337x', label: '1337x', host: '1337x.to', kind: 'torrent' },

  async search(query, opts): Promise<SearchResult[]> {
    const tvCategory = opts.mode === 'tv'
    const ctx = await loadSearchPage(query, opts.timeoutMs, opts.x1337Mirrors ?? [], tvCategory)
    const rows = parseRows(ctx)
    const sorted = rows.sort((a, b) => b.seeders - a.seeders).slice(0, 60)

    return sorted.map(r => {
      // Memoize the detail-page fetch so selecting a row twice hits the network once.
      let cached: Promise<string> | null = null
      const fetchMagnet = (): Promise<string> => {
        if (!cached) {
          cached = fetchDetailMagnet(r.detailUrl, opts.timeoutMs).catch(err => {
            cached = null // allow a retry on the next selection
            throw err
          })
        }
        return cached
      }
      return {
        id: `1337x:${r.detailUrl}`,
        provider: '1337x',
        title: r.title,
        seeders: r.seeders,
        leechers: r.leechers,
        sizeBytes: r.sizeBytes,
        quality: parseQuality(r.title),
        uploaded: parseUploaded337x(r.uploaded),
        detailUrl: r.detailUrl,
        fetchMagnet
      } satisfies SearchResult
    })
  }
}

// Re-exported for tests / the aggregator's dedupe helper.
export { relativeFromUnix }
