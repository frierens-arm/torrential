import type { Provider, ProviderInfo, SearchEvent, SearchMode, SearchResult } from '../types.js'
import { piratebayProvider } from './piratebay.js'
import { x1337Provider } from './x1337.js'
import { nyaaProvider } from './nyaa.js'
import { toTvResult } from '../utils/tv.js'
import { classifyTitle } from '../utils/classify.js'

export const ALL_PROVIDERS: Provider[] = [piratebayProvider, x1337Provider, nyaaProvider]

export function providerById(id: string): Provider | undefined {
  return ALL_PROVIDERS.find(p => p.info.id === id)
}

export function providerInfos(): ProviderInfo[] {
  return ALL_PROVIDERS.map(p => p.info)
}

/**
 * Run every enabled provider concurrently and yield events as they land,
 * so the results table can fill up fluidly — torlink-style.
 *
 * TV edition:
 *  - accepts ONE query or a LIST of queries (smart SxxExx / 1xx injection,
 *    see episodeQueries()/seasonQueries() in utils/tv.ts); every provider
 *    fans out across all of them and the rows are merged + deduped
 *  - every row is shaped through toTvResult() AND tagged with a classifier
 *    verdict (media, see utils/classify.ts): episodic rows also get
 *    show/scope; nothing is discarded in auto/movies modes — the session
 *    router decides where rows surface. tv mode keeps the strict 2.0.0
 *    firewall (non-episodic rows dropped)
 *  - opts.mode flows to providers that scope their scrape by it (1337x
 *    picks its TV category route in 'tv' mode)
 *
 * Each (provider × query) task is individually raced against the search
 * timeout; one failing source never poisons the others.
 */
export async function* runSearch(
  query: string | string[],
  opts: { providers: string[]; timeoutMs: number; x1337Mirrors?: string[]; mode?: SearchMode }
): AsyncGenerator<SearchEvent> {
  const queries = (Array.isArray(query) ? query : [query])
    .map(q => q.trim())
    .filter(q => q.length > 0)
    .filter((q, i, all) => all.indexOf(q) === i) // dedupe

  const enabled = opts.providers
    .map(id => providerById(id))
    .filter((p): p is Provider => p !== undefined)

  if (enabled.length === 0 || queries.length === 0) {
    yield { type: 'all-done' }
    return
  }

  type Queued = SearchEvent
  const queue: Queued[] = []
  let notify: (() => void) | null = null
  /** provider id → number of (still-running) query tasks */
  const pendingQueries = new Map<string, number>(enabled.map(p => [p.info.id, 0]))
  /** provider id → rows contributed across all its queries */
  const providerRows = new Map<string, number>(enabled.map(p => [p.info.id, 0]))
  /** provider id → last error, reported only if the provider never answers */
  const providerErrors = new Map<string, string>()
  /** Cross-query dedupe of provider rows. */
  const seen = new Set<string>()

  const push = (event: Queued): void => {
    queue.push(event)
    notify?.()
    notify = null
  }

  const wait = (): Promise<void> =>
    new Promise(resolve => {
      if (queue.length > 0) return resolve()
      notify = resolve
    })

  const launch = (provider: Provider, query: string): void => {
    const id = provider.info.id
    const first = (pendingQueries.get(id) ?? 0) === 0
    pendingQueries.set(id, (pendingQueries.get(id) ?? 0) + 1)
    if (first) push({ type: 'provider-start', provider: provider.info })

    void (async () => {
      let rows: SearchResult[] = []
      let failure: string | null = null
      try {
        const raw = await withTimeout(
          provider.search(query, { timeoutMs: opts.timeoutMs, x1337Mirrors: opts.x1337Mirrors, mode: opts.mode }),
          opts.timeoutMs,
          `${provider.info.label} timed out`
        )
        // ── row shaping: classify + tag episodic rows, keep the rest ──
        rows = raw
          .map(r => tagRow(r, provider.info.id))
          // 2.0.0 compatibility: tv mode is the ONLY path that still drops
          // non-episodic rows (movies must never surface in the TV tiers).
          .filter(r => opts.mode !== 'tv' || (r.show !== undefined && r.scope !== undefined))
          .filter(r => {
            const key = resultKey(r)
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      }

      if (failure !== null) providerErrors.set(id, failure)
      if (rows.length > 0) {
        providerRows.set(id, (providerRows.get(id) ?? 0) + rows.length)
        push({ type: 'results', provider: provider.info, results: rows })
      }

      const remaining = (pendingQueries.get(id) ?? 1) - 1
      pendingQueries.set(id, remaining)
      if (remaining === 0) {
        // A provider only counts as failed when NONE of its query variants
        // produced a single row.
        const total = providerRows.get(id) ?? 0
        if (total === 0 && providerErrors.has(id)) {
          push({ type: 'provider-error', provider: provider.info, error: providerErrors.get(id)! })
        }
        push({ type: 'provider-done', provider: provider.info, count: total })
        pendingQueries.delete(id)
        if (pendingQueries.size === 0) push({ type: 'all-done' })
      }
    })()
  }

  for (const provider of enabled) {
    for (const query of queries) {
      launch(provider, query)
    }
  }

  while (true) {
    if (queue.length === 0) {
      if (pendingQueries.size === 0) return
      await wait()
      continue
    }
    const event = queue.shift()!
    yield event
    if (event.type === 'all-done') return
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Shape + classify one raw provider row: toTvResult attaches show/scope
 * when the title parses as episodic; classifyTitle attaches the media
 * verdict for every row (movies included — they are tagged, never
 * dropped, outside tv mode).
 */
function tagRow(r: SearchResult, providerId: string): SearchResult {
  const shaped = toTvResult(r)
  const cls = classifyTitle(r.title, providerId)
  return { ...shaped, media: { kind: cls.kind, confidence: cls.confidence } }
}

/** Normalize a title for dedupe keys. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Stable dedupe id: prefer info hash, fall back to title+size. */
export function resultKey(r: SearchResult): string {
  if (r.infoHash) return r.infoHash
  return `${normalizeTitle(r.title)}|${r.sizeBytes}`
}
