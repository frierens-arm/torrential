import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderStatus, SearchMode, SearchResult } from '../../types.js'
import { providerInfos, resultKey, runSearch } from '../../providers/index.js'
import type { TorrentialConfig } from '../../config.js'
import { log } from '../../utils/log.js'

export interface UseSearchOptions {
  /** The submitted query (empty = idle, no search runs). */
  query: string
  /** Bumped by submitSearch to re-run an identical query. */
  searchSeq: number
  /**
   * Session content mode, read when a search launches. Changing /mode does
   * not restart the running hunt — that is the documented behavior.
   */
  mode: SearchMode
  config: TorrentialConfig
  /** First results batch of a main search — the auto-mode router hangs here. */
  onFirstBatch?: (rows: SearchResult[]) => void
  /** Main search finished without a single row (from any source). */
  onEmpty?: () => void
}

export interface SearchStore {
  statuses: ProviderStatus[]
  allResults: SearchResult[]
  /** Non-null while a supplemental SxxExx / 1xx hunt is in flight. */
  hunting: string | null
  absorbResults: (rows: SearchResult[]) => void
  hunt: (key: string, queries: string[], label: string) => void
  /** Clear rows + dedupe/hunt bookkeeping (a fresh search is starting). */
  resetResults: () => void
}

/**
 * Search state: the streaming provider aggregator, supplemental smart hunts,
 * dedupe, and the per-provider status chips.
 *
 * Extracted from App.tsx so the auto-mode router and the tier navigation can
 * stay readable, and so a hunt's bookkeeping cannot leak into screen state.
 * Callbacks land through a ref: re-renders during an in-flight search must
 * never restart it.
 */
export function useSearch({ query, searchSeq, mode, config, onFirstBatch, onEmpty }: UseSearchOptions): SearchStore {
  const [statuses, setStatuses] = useState<ProviderStatus[]>(() =>
    providerInfos()
      .filter(p => config.providers.includes(p.id))
      .map(p => ({ ...p, state: 'pending' as const, count: 0 }))
  )
  const [allResults, setAllResults] = useState<SearchResult[]>([])
  const [hunting, setHunting] = useState<string | null>(null)

  const seenRef = useRef(new Set<string>())
  const huntedRef = useRef(new Set<string>())
  const modeRef = useRef(mode)
  const configRef = useRef(config)
  const callbacksRef = useRef({ onFirstBatch, onEmpty })
  modeRef.current = mode
  configRef.current = config
  callbacksRef.current = { onFirstBatch, onEmpty }

  const absorbResults = useCallback((rows: SearchResult[]): void => {
    const fresh = rows.filter(row => {
      const key = resultKey(row)
      if (seenRef.current.has(key)) return false
      seenRef.current.add(key)
      return true
    })
    if (fresh.length > 0) setAllResults(prev => [...prev, ...fresh])
  }, [])

  const resetResults = useCallback((): void => {
    seenRef.current = new Set<string>()
    huntedRef.current = new Set<string>()
    setAllResults([])
    setHunting(null)
  }, [])

  /* ── main search ── */
  useEffect(() => {
    if (!query) return
    const cfg = configRef.current
    setStatuses(
      providerInfos()
        .filter(p => cfg.providers.includes(p.id))
        .map(p => ({ ...p, state: 'pending' as const, count: 0 }))
    )
    seenRef.current = new Set<string>()
    huntedRef.current = new Set<string>()
    setAllResults([])
    setHunting(null)
    log('search:session', { query, mode: modeRef.current })

    let cancelled = false
    let sawResults = false
    void (async () => {
      try {
        const events = runSearch(query, {
          providers: cfg.providers,
          timeoutMs: cfg.search_timeout * 1000,
          x1337Mirrors: cfg.x1337_mirrors,
          mode: modeRef.current
        })
        for await (const event of events) {
          if (cancelled) return
          switch (event.type) {
            case 'provider-start':
              setStatuses(prev => prev.map(s => (s.id === event.provider.id ? { ...s, state: 'running' } : s)))
              break
            case 'provider-done':
              setStatuses(prev =>
                prev.map(s => (s.id === event.provider.id ? { ...s, state: 'done', count: event.count } : s))
              )
              break
            case 'provider-error':
              setStatuses(prev =>
                prev.map(s => (s.id === event.provider.id ? { ...s, state: 'error', error: event.error } : s))
              )
              break
            case 'results':
              absorbResults(event.results)
              if (!sawResults) {
                sawResults = true
                callbacksRef.current.onFirstBatch?.(event.results)
              }
              break
            case 'all-done':
              // Zero rows anywhere → the empty series screen.
              if (!sawResults) callbacksRef.current.onEmpty?.()
              return
          }
        }
      } catch (err) {
        // Provider-level failures already surface through the status chips.
        log('search:session-failed', { query, message: err instanceof Error ? err.message : String(err) })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [query, searchSeq, absorbResults])

  /* ── supplemental hunts (SxxExx / 1xx / season queries) ── */
  const hunt = useCallback(
    (key: string, queries: string[], label: string): void => {
      if (huntedRef.current.has(key)) return
      huntedRef.current.add(key)
      setHunting(label)
      const cfg = configRef.current
      log('hunt:start', { key, queries })
      void (async () => {
        try {
          const events = runSearch(queries, {
            providers: cfg.providers,
            timeoutMs: cfg.search_timeout * 1000,
            x1337Mirrors: cfg.x1337_mirrors,
            mode: modeRef.current
          })
          for await (const event of events) {
            if (event.type === 'results') absorbResults(event.results)
            if (event.type === 'all-done') break
          }
        } catch {
          /* best effort — the view just stays as thin as it was */
        } finally {
          setHunting(null)
        }
      })()
    },
    [absorbResults]
  )

  return { statuses, allResults, hunting, absorbResults, hunt, resetResults }
}
