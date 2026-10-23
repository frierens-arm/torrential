import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useInput } from 'ink'
import type { ChildProcess } from 'node:child_process'
import type {
  KeptFile,
  ProviderStatus,
  ReadyInfo,
  SearchMode,
  SearchResult,
  StreamStats,
  StreamTarget
} from '../types.js'
import type { TorrentialConfig } from '../config.js'
import { runSearch, resultKey, providerInfos } from '../providers/index.js'
import { StreamEngine } from '../engine/stream.js'
import type { EngineHost } from '../engine/host.js'
import { setTheme, normalizeThemeName, themeId, themeList } from '../themes.js'
import { parseSlashCommand } from '../utils/commands.js'
import { loadConfig, saveConfig, normalizeModeName } from '../config.js'
import { MODE_IDS } from '../constants.js'
import {
  resolveLaunchChain,
  trySpawnPlayer,
  killPlayer,
  type PlayerLaunch
} from '../utils/players.js'
import { looksLikeTorrentId } from '../utils/magnet.js'
import { formatBytes, truncateStart } from '../utils/format.js'
import {
  buildSeriesIndex,
  seriesSummaries,
  buildSeasonRows,
  buildEpisodeRows,
  packsForSeason,
  torrentsForEpisode,
  episodeQueries,
  seasonQueries,
  bySeeders,
  pad2,
  type EpisodeRow,
  type SeasonRef,
  type SeriesData,
  type SeriesSummary
} from '../utils/tv.js'
import { classifyQuery, classifyTitle, voteKind } from '../utils/classify.js'
import { SearchScreen } from './screens/SearchScreen.js'
import { SeriesScreen } from './screens/SeriesScreen.js'
import { MovieResultsScreen } from './screens/MovieResultsScreen.js'
import { SeasonScreen } from './screens/SeasonScreen.js'
import { EpisodeScreen } from './screens/EpisodeScreen.js'
import { DetailScreen } from './screens/DetailScreen.js'
import { FilePickerScreen } from './screens/FilePickerScreen.js'
import { StreamScreen, type PlayerInfo } from './screens/StreamScreen.js'

type Screen = 'search' | 'results' | 'series' | 'season' | 'episode' | 'detail' | 'files' | 'stream'

/**
 * Where the detail view points at: one exact episode, or a season's packs.
 * Torrents are DERIVED from the live series index on every render, so
 * supplemental hunts (SxxExx queries) fill the candidate list in place.
 */
interface DetailCtx {
  seriesKey: string
  ref: SeasonRef
  /** null = pack listing (target: whole torrent). */
  episode: number | null
  /** Preferred candidate index (n/p cycling). */
  index: number
  /** Where b goes back to. */
  from: 'episode' | 'season'
}

/** Detail-card context line for a movie row ("movie · 2023"). */
function movieContext(result: SearchResult | undefined): string {
  if (!result) return 'movie'
  const year = /\b(19\d{2}|20\d{2})\b/.exec(result.title)?.[1]
  return year ? `movie · ${year}` : 'movie'
}

export interface AppProps {
  config: TorrentialConfig
  /** The pre-warmed shared WebTorrent client owner (lives for the session). */
  host: EngineHost
  initialQuery: string
  magnetArg?: string
  noPlayer: boolean
  playerOverride?: string
  /** --keep: move the streamed file to config.keep_directory on teardown. */
  keep?: boolean
  /** Path the config was loaded from (undefined = default), used by /theme persistence. */
  configFile?: string
  warnings: string[]
  /** Lets cli.ts hook SIGINT into the same teardown path as ctrl+c. */
  onRegisterShutdown: (fn: () => Promise<void>) => void
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function App({
  config,
  host,
  initialQuery,
  magnetArg,
  noPlayer,
  playerOverride,
  keep = false,
  configFile,
  warnings,
  onRegisterShutdown
}: AppProps): React.ReactElement {
  const { exit } = useApp()

  // Boot screen by content mode: tv keeps the 2.0.0 series landing;
  // movies goes straight to the flat list; auto waits on the search bar
  // until the first results batch votes (classifier router below).
  const [screen, setScreen] = useState<Screen>(() => {
    if (magnetArg) return 'stream'
    if (!initialQuery) return 'search'
    if (config.mode === 'tv') return 'series'
    if (config.mode === 'movies') return 'results'
    return 'search'
  })
  const [query, setQuery] = useState(initialQuery)
  const [searchSeq, setSearchSeq] = useState(0)
  const [statuses, setStatuses] = useState<ProviderStatus[]>(() =>
    providerInfos()
      .filter(p => config.providers.includes(p.id))
      .map(p => ({ ...p, state: 'pending' as const, count: 0 }))
  )

  /* ── tier navigation state ── */
  const [allResults, setAllResults] = useState<SearchResult[]>([])
  const [seriesSelected, setSeriesSelected] = useState(0)
  const [currentSeriesKey, setCurrentSeriesKey] = useState<string | null>(null)
  const [seasonSelected, setSeasonSelected] = useState(0)
  const [currentSeasonRef, setCurrentSeasonRef] = useState<SeasonRef | null>(null)
  const [episodeSelected, setEpisodeSelected] = useState(0)
  const [detail, setDetail] = useState<DetailCtx | null>(null)
  /** Supplemental smart-hunt label ("hunting S02E05…"). */
  const [hunting, setHunting] = useState<string | null>(null)

  /* ── movie-path state (auto/movies modes) ── */
  const [movieSelected, setMovieSelected] = useState(0)
  /** Non-null = detail card points at the movie candidate list. */
  const [movieDetailIndex, setMovieDetailIndex] = useState<number | null>(null)
  /** Auto-mode router fires once per search — on the first results batch. */
  const routedRef = useRef(false)

  /* ── streaming state ── */
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [player, setPlayer] = useState<PlayerInfo | null>(null)
  const [keepNote, setKeepNote] = useState<string | null>(null)
  const [themeNote, setThemeNote] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [showThemeList, setShowThemeList] = useState(false)
  const [themeCursor, setThemeCursor] = useState(() => {
    const idx = themeList().findIndex(t => t.id === themeId())
    return idx >= 0 ? idx : 0
  })
  /** Session content mode — live so /mode applies without a restart. */
  const [mode, setMode] = useState<SearchMode>(config.mode)

  const engineRef = useRef<StreamEngine | null>(null)
  const playerChildRef = useRef<ChildProcess | null>(null)
  const shuttingDownRef = useRef(false)
  const tearingDownRef = useRef(false)
  const seenRef = useRef(new Set<string>())
  /** hunt keys already fired (per main search). */
  const huntedRef = useRef(new Set<string>())

  /* ------------------------------------------------------------------ *
   * Derived TV index — series → seasons → episodes, rebuilt whenever
   * the accumulated result set grows (main search + smart hunts).
   * ------------------------------------------------------------------ */

  const seriesIndex = useMemo(() => buildSeriesIndex(allResults), [allResults])
  const seriesList = useMemo(() => seriesSummaries(seriesIndex), [seriesIndex])
  /** Flat movie list — every 'movie'-tagged row, best swarm first. */
  const movieRows = useMemo(
    () => allResults.filter(r => r.media?.kind === 'movie').sort(bySeeders),
    [allResults]
  )
  const currentSeries = useMemo(
    () => (currentSeriesKey ? (seriesIndex.get(currentSeriesKey) ?? null) : null),
    [seriesIndex, currentSeriesKey]
  )
  const seasonRows = useMemo(() => (currentSeries ? buildSeasonRows(currentSeries) : []), [currentSeries])
  const currentBucket = useMemo(() => {
    if (!currentSeries || !currentSeasonRef) return null
    if (currentSeasonRef.kind === 'season') return currentSeries.seasons.get(currentSeasonRef.season) ?? null
    if (currentSeasonRef.kind === 'unsorted') return currentSeries.unsorted
    return null
  }, [currentSeries, currentSeasonRef])
  const episodeRows = useMemo(
    () => (currentBucket ? buildEpisodeRows(currentBucket) : []),
    [currentBucket]
  )
  const seasonPacks = useMemo(
    () => (currentSeries && currentSeasonRef ? packsForSeason(currentSeries, currentSeasonRef) : []),
    [currentSeries, currentSeasonRef]
  )

  /** Detail candidates, derived live so hunts can extend them underfoot. */
  const detailTorrents = useMemo(() => {
    if (!detail || !currentSeries) return []
    if (detail.episode === null) return packsForSeason(currentSeries, detail.ref)
    const bucket =
      detail.ref.kind === 'season'
        ? currentSeries.seasons.get(detail.ref.season)
        : detail.ref.kind === 'unsorted'
          ? currentSeries.unsorted
          : null
    return bucket ? torrentsForEpisode(bucket, detail.episode) : []
  }, [detail, currentSeries])

  const seasonLabel = (ref: SeasonRef, data: SeriesData | null): string => {
    if (ref.kind === 'complete') return 'Complete series packs'
    if (ref.kind === 'unsorted') return 'Episodes (no season tag)'
    if (ref.kind === 'season' && data) {
      const label = ref.season === 0 ? 'Specials' : `Season ${ref.season}`
      if (data.show) return label
      return label
    }
    return 'Season'
  }

  /** Human line for a file --keep rescued out of the cache. */
  const describeKept = (kept: KeptFile): string => {
    const pct = Math.floor((kept.progress ?? 0) * 100)
    const completeness = (kept.progress ?? 0) < 0.999 ? `${pct}% downloaded` : 'complete'
    return `saved → ${truncateStart(kept.destPath, 64)} (${formatBytes(kept.sizeBytes)}, ${completeness})`
  }

  /* ------------------------------------------------------------------ *
   * Search: consume the streaming aggregator as events land, then keep
   * absorbing rows from supplemental SxxExx / 1xx hunts.
   * ------------------------------------------------------------------ */

  const absorbResults = useCallback((rows: SearchResult[]): void => {
    const fresh = rows.filter(r => {
      const key = resultKey(r)
      if (seenRef.current.has(key)) return false
      seenRef.current.add(key)
      return true
    })
    if (fresh.length > 0) setAllResults(prev => [...prev, ...fresh])
  }, [])

  useEffect(() => {
    if (!query) return
    const enabledIds = new Set(config.providers)
    setStatuses(
      providerInfos()
        .filter(p => enabledIds.has(p.id))
        .map(p => ({ ...p, state: 'pending' as const, count: 0 }))
    )
    seenRef.current = new Set<string>()
    huntedRef.current = new Set<string>()
    routedRef.current = false
    setAllResults([])
    setHunting(null)

    let cancelled = false
    void (async () => {
      try {
        const events = runSearch(query, {
          providers: config.providers,
          timeoutMs: config.search_timeout * 1000,
          x1337Mirrors: config.x1337_mirrors,
          mode
        })
        for await (const event of events) {
          if (cancelled) return
          switch (event.type) {
            case 'provider-start':
              setStatuses(prev =>
                prev.map(s => (s.id === event.provider.id ? { ...s, state: 'running' } : s))
              )
              break
            case 'provider-done':
              setStatuses(prev =>
                prev.map(s =>
                  s.id === event.provider.id ? { ...s, state: 'done', count: event.count } : s
                )
              )
              break
            case 'provider-error':
              setStatuses(prev =>
                prev.map(s =>
                  s.id === event.provider.id ? { ...s, state: 'error', error: event.error } : s
                )
              )
              break
            case 'results': {
              absorbResults(event.results)
              // ── auto-mode router: the FIRST batch decides, once ──
              // Movie-majority → flat list; episode/pack-majority or
              // unknown → today's series path (silent degradation: a
              // classifier miss must look exactly like 2.0.0).
              if (mode === 'auto' && !routedRef.current) {
                routedRef.current = true
                const classes = event.results.map(r =>
                  r.media
                    ? { kind: r.media.kind, confidence: r.media.confidence, signals: ['row-media'] }
                    : classifyTitle(r.title)
                )
                const vote = voteKind(classes)
                let winner = vote.kind
                if (winner === 'unknown') {
                  // Mild prior: a bare query with a year leans movie when
                  // the swarm answered with uninformative rows.
                  const prior = classifyQuery(query)
                  if (prior.kind === 'movie' && prior.confidence >= 0.5) winner = 'movie'
                }
                setScreen(winner === 'movie' ? 'results' : 'series')
              }
              break
            }
            case 'all-done':
              // Zero rows anywhere → 2.0.0's empty series screen.
              if (mode === 'auto' && !routedRef.current) {
                routedRef.current = true
                setScreen('series')
              }
              return
          }
        }
      } catch {
        // Provider-level failures already surface through statuses.
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchSeq])

  /* ------------------------------------------------------------------ *
   * Smart supplemental hunts — inject SxxExx / 1xx nomenclature the
   * moment a view looks thin, and merge the answers into the index.
   * ------------------------------------------------------------------ */

  const hunt = useCallback(
    (key: string, queries: string[], label: string): void => {
      if (huntedRef.current.has(key)) return
      huntedRef.current.add(key)
      setHunting(label)
      void (async () => {
        try {
          const events = runSearch(queries, {
            providers: config.providers,
            timeoutMs: config.search_timeout * 1000,
            x1337Mirrors: config.x1337_mirrors,
            mode
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
    [absorbResults, config.providers, config.search_timeout, config.x1337_mirrors, mode]
  )

  /* ------------------------------------------------------------------ *
   * Streaming lifecycle
   * ------------------------------------------------------------------ */

  const teardownStream = useCallback(async (): Promise<void> => {
    if (tearingDownRef.current) return
    tearingDownRef.current = true
    const child = playerChildRef.current
    playerChildRef.current = null
    const engine = engineRef.current
    engineRef.current = null
    setPlayer(null)
    if (child) await Promise.race([killPlayer(child), delay(2500)])
    if (engine) await Promise.race([engine.stop(), delay(3000)])
    tearingDownRef.current = false
    // Land back where the stream was launched from — the detail pre-flight
    // (n/p to another torrent), the series browser, the movie list, or the
    // search bar.
    setScreen(prev => {
      if (prev !== 'stream' && prev !== 'files') return prev
      if (detail || movieDetailIndex !== null) return 'detail'
      if (allResults.length > 0) return mode === 'movies' ? 'results' : 'series'
      return 'search'
    })
  }, [detail, movieDetailIndex, allResults.length, mode])

  const beginStream = useCallback(
    (torrentId: string, target: StreamTarget = { kind: 'auto' }): void => {
      setStats(null)
      setPlayer(null)
      setScreen('stream')

      const engine = new StreamEngine({
        host,
        cacheDir: config.cache_directory,
        port: config.port,
        metadataTimeoutMs: config.metadata_timeout * 1000,
        keepCache: config.keep_cache,
        keepDir: keep ? config.keep_directory : null,
        turbo: config.turbo,
        ramCacheMB: config.ram_cache_mb,
        headStartBytes: config.head_start_mb * 1_000_000,
        tailPrefetchBytes: config.tail_prefetch_mb * 1_000_000,
        windowSecs: config.window_secs
      })
      engineRef.current = engine
      engine.on('stats', s => setStats(s))
      engine.on('error', () => {
        /* stats carries the error surfaced in the UI */
      })
      engine.on('stopped', kept => {
        if (kept) setKeepNote(describeKept(kept))
      })

      engine.on('ready', (info: ReadyInfo) => {
        if (noPlayer) {
          setPlayer({ label: 'none (--no-player) — open the endpoint above', detached: true })
          return
        }
        const preference = playerOverride ?? config.default_player
        const { chain, note } = resolveLaunchChain(
          preference,
          config.player_fallbacks,
          info.url,
          config.player_flags
        )
        if (chain.length === 0) {
          setPlayer({
            label: 'no player found — open the endpoint above manually',
            detached: true,
            note:
              'install mpv or vlc (see README) or set default_player / --player to a binary you have'
          })
          return
        }
        void trySpawnPlayer(chain).then(({ child, launch }: { child: ChildProcess | null; launch: PlayerLaunch | null }) => {
          if (!child || !launch) {
            setPlayer({
              label: 'player launch failed — open the endpoint above manually',
              detached: true,
              note
            })
            return
          }
          playerChildRef.current = child
          setPlayer({ label: launch.name, detached: launch.detached, note })
          if (!launch.detached) {
            child.once('exit', () => {
              // Player window closed → stop streaming, keep the TUI alive.
              void teardownStream()
            })
          }
        })
      })

      engine.start(torrentId, target).catch(() => {
        /* stats.phase === 'error' drives the error block in the UI */
      })
    },
    [config, noPlayer, playerOverride, teardownStream, keep, host]
  )

  /* Multi-file torrents flip the UI into the interactive file picker. */
  useEffect(() => {
    if (stats && stats.awaitingFile && stats.files && stats.files.length > 0 && screen === 'stream') {
      setScreen('files')
    }
    if (screen === 'files' && stats && !stats.awaitingFile) {
      setScreen('stream')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats])

  /* ------------------------------------------------------------------ *
   * Navigation handlers
   * ------------------------------------------------------------------ */

  /** Apply a skin from the search bar (or picker) and persist it to the config file. */
  const applyThemeById = useCallback(
    (id: string): void => {
      if (id === themeId()) {
        setShowThemeList(false)
        setThemeNote({ kind: 'info', text: `skin "${id}" is already active` })
        return
      }
      setTheme(id)
      let savedNote = ''
      try {
        // Reload from disk so we never persist session-only CLI overrides.
        const fresh = loadConfig(configFile)
        saveConfig({ ...fresh.config, theme: id }, configFile)
        savedNote = ' · saved to config'
      } catch (err) {
        savedNote = ` · could not save: ${(err as Error).message}`
      }
      setShowThemeList(false)
      setThemeNote({ kind: 'ok', text: `skin applied: ${id}${savedNote}` })
    },
    [configFile]
  )

  /** /theme (no arg) → open the live picker, cursor parked on the active skin. */
  const openThemeList = useCallback((): void => {
    setShowThemeList(true)
    setThemeNote(null)
    const idx = themeList().findIndex(t => t.id === themeId())
    setThemeCursor(idx >= 0 ? idx : 0)
  }, [])

  const applyThemeCommand = useCallback(
    (arg: string | undefined): void => {
      if (!arg) {
        openThemeList()
        return
      }
      const id = normalizeThemeName(arg)
      if (!id) {
        setShowThemeList(false)
        setThemeNote({
          kind: 'err',
          text: `unknown skin "${arg}" — available: ${themeList().map(t => t.id).join(', ')}`
        })
        return
      }
      applyThemeById(id)
    },
    [applyThemeById, openThemeList]
  )

  /** Apply a content mode from the search bar and persist it to the config file. */
  const applyModeById = useCallback(
    (id: SearchMode): void => {
      if (id === mode) {
        setThemeNote({ kind: 'info', text: `mode "${id}" is already active` })
        return
      }
      setMode(id)
      let savedNote = ''
      try {
        // Reload from disk so we never persist session-only CLI overrides.
        const fresh = loadConfig(configFile)
        saveConfig({ ...fresh.config, mode: id }, configFile)
        savedNote = ' · saved to config'
      } catch (err) {
        savedNote = ` · could not save: ${(err as Error).message}`
      }
      setThemeNote({ kind: 'ok', text: `mode applied: ${id}${savedNote}` })
    },
    [configFile, mode]
  )

  /** /mode (no arg) → show the current mode + choices, /mode <name> → apply + save. */
  const applyModeCommand = useCallback(
    (arg: string | undefined): void => {
      if (!arg) {
        setThemeNote({
          kind: 'info',
          text: `mode: ${mode} — choices: ${MODE_IDS.join(' · ')} (usage: /mode <${MODE_IDS.join('|')}>)`
        })
        return
      }
      const id = normalizeModeName(arg)
      if (!id) {
        setThemeNote({ kind: 'err', text: `unknown mode "${arg}" — choices: ${MODE_IDS.join(' · ')}` })
        return
      }
      applyModeById(id)
    },
    [applyModeById, mode]
  )

  const submitSearch = useCallback(
    (text: string): void => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      const cmd = parseSlashCommand(trimmed)
      if (cmd?.kind === 'theme') {
        applyThemeCommand(cmd.arg)
        return
      }
      if (cmd?.kind === 'mode') {
        applyModeCommand(cmd.arg)
        return
      }
      if (cmd?.kind === 'unknown') {
        setThemeNote({ kind: 'err', text: `unknown command "/${cmd.name}" — try /theme <name> or /mode <auto|tv|movies>` })
        return
      }
      const torrentId = looksLikeTorrentId(trimmed)
      if (torrentId) {
        setKeepNote(null) // last rescue line expires on a fresh hunt
        setThemeNote(null)
        setShowThemeList(false)
        setDetail(null)
        beginStream(torrentId)
        return
      }
      setKeepNote(null) // last rescue line expires on a fresh hunt
      setThemeNote(null) // command feedback expires too
      setShowThemeList(false)
      setAllResults([])
      setSeriesSelected(0)
      setMovieSelected(0)
      setMovieDetailIndex(null)
      setDetail(null)
      setCurrentSeriesKey(null)
      setCurrentSeasonRef(null)
      setQuery(trimmed)
      setSearchSeq(s => s + 1)
      // Landing screen by content mode: tv keeps 2.0.0's series tiers;
      // movies goes to the flat list; auto stays put until the first
      // results batch votes (see the router in the search effect).
      setScreen(mode === 'tv' ? 'series' : mode === 'movies' ? 'results' : 'search')
    },
    [beginStream, applyThemeCommand, applyModeCommand, mode]
  )

  /* ── movie path: pick a row → pre-flight card over the movie list ── */
  const pickMovie = useCallback(
    (result: SearchResult): void => {
      const index = Math.max(0, movieRows.findIndex(r => r.id === result.id))
      setMovieDetailIndex(index)
      setScreen('detail')
    },
    [movieRows]
  )

  /* ── tier 1 → tier 2: pick a series, browse its seasons ── */
  const pickSeries = useCallback((summary: SeriesSummary): void => {
    setCurrentSeriesKey(summary.key)
    setSeasonSelected(0)
    setScreen('season')
  }, [])

  /* ── tier 2 → tier 3: pick a season (or pack bucket), browse episodes ── */
  const pickSeason = useCallback(
    (ref: SeasonRef): void => {
      if (!currentSeries) return
      setCurrentSeasonRef(ref)
      setEpisodeSelected(0)
      setScreen('episode')

      // Smart hunt: a season with no pack coverage gets Sxx / "season N"
      // queries injected so packs and straggl episodes surface.
      if (ref.kind === 'season') {
        const packs = packsForSeason(currentSeries, ref)
        const bucket = currentSeries.seasons.get(ref.season)
        const episodes = bucket ? bucket.episodes.size : 0
        if (packs.length === 0 || episodes < 2) {
          hunt(
            `season:${currentSeries.key}:${ref.season}`,
            seasonQueries(currentSeries.show, ref.season),
            `hunting ${ref.season === 0 ? 'specials' : `season ${ref.season}`} packs for ${currentSeries.show}`
          )
        }
      }
    },
    [currentSeries, hunt]
  )

  /* ── tier 3: pick an episode (or a pinned pack) → detail pre-flight ── */
  const pickEpisode = useCallback(
    (row: EpisodeRow): void => {
      if (!currentSeries || !currentSeasonRef) return
      const season = currentSeasonRef.kind === 'season' ? currentSeasonRef.season : null
      setDetail({
        seriesKey: currentSeries.key,
        ref: currentSeasonRef,
        episode: row.episode,
        index: 0,
        from: 'episode'
      })
      setScreen('detail')

      // Smart hunt: thin candidate lists get the exact SxxExx / 1xx forms.
      const torrents = row.torrents.length + row.ranges.length
      if (torrents < 3) {
        hunt(
          `ep:${currentSeries.key}:${season ?? 'x'}:${row.episode}`,
          episodeQueries(currentSeries.show, season, row.episode),
          season === null
            ? `hunting episode ${row.episode} of ${currentSeries.show}`
            : `hunting S${pad2(season)}E${pad2(row.episode)} of ${currentSeries.show}`
        )
      }
    },
    [currentSeries, currentSeasonRef, hunt]
  )

  const pickPack = useCallback(
    (pack: SearchResult): void => {
      if (!currentSeries || !currentSeasonRef) return
      const packs = packsForSeason(currentSeries, currentSeasonRef)
      const index = Math.max(0, packs.findIndex(p => p.id === pack.id))
      setDetail({
        seriesKey: currentSeries.key,
        ref: currentSeasonRef,
        episode: null,
        index,
        from: 'season'
      })
      setScreen('detail')
    },
    [currentSeries, currentSeasonRef]
  )

  /* ── detail → stream ── */
  const streamResult = useCallback(
    (result: SearchResult, magnet: string, target: StreamTarget): void => {
      beginStream(result.magnet ?? magnet, target)
    },
    [beginStream]
  )

  /* ── file picker answers ── */
  const pickFile = useCallback((fileIndex: number): void => {
    engineRef.current?.selectFile(fileIndex)
    setScreen('stream')
  }, [])

  /* ------------------------------------------------------------------ *
   * Cursor hygiene: keep selections valid when result sets shift under
   * supplemental hunts (rows can appear, never disappear).
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (seriesSelected >= seriesList.length && seriesList.length >= 0) {
      setSeriesSelected(seriesList.length > 0 ? seriesList.length - 1 : 0)
    }
  }, [seriesList.length, seriesSelected])

  useEffect(() => {
    if (seasonSelected >= seasonRows.length && seasonRows.length >= 0) {
      setSeasonSelected(seasonRows.length > 0 ? seasonRows.length - 1 : 0)
    }
  }, [seasonRows.length, seasonSelected])

  useEffect(() => {
    if (movieSelected >= movieRows.length && movieRows.length >= 0) {
      setMovieSelected(movieRows.length > 0 ? movieRows.length - 1 : 0)
    }
  }, [movieRows.length, movieSelected])

  /* ------------------------------------------------------------------ *
   * Global shutdown (ctrl+c in-TUI + SIGINT from cli.ts)
   * ------------------------------------------------------------------ */

  const shutdown = useCallback(async (): Promise<void> => {
    if (shuttingDownRef.current) return
    shuttingDownRef.current = true
    const child = playerChildRef.current
    const engine = engineRef.current
    playerChildRef.current = null
    engineRef.current = null
    if (child) void killPlayer(child)
    if (engine) await Promise.race([engine.stop(), delay(2500)])
    // The shared client is destroyed only on app exit.
    await Promise.race([host.destroy(), delay(3500)])
    exit()
  }, [exit, host])

  useEffect(() => {
    onRegisterShutdown(shutdown)
  }, [onRegisterShutdown, shutdown])

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === '\x03')) {
      void shutdown()
    }
  })

  /* ------------------------------------------------------------------ *
   * Boot: --magnet skips straight to the stream
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (magnetArg) beginStream(magnetArg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------------------------------------------ *
   * Screen router
   * ------------------------------------------------------------------ */

  const searchScreen = (
    <SearchScreen
      initialQuery={query}
      onSubmit={submitSearch}
      warnings={warnings}
      keepNote={keepNote}
      themeNote={themeNote}
      showThemeList={showThemeList}
      themeCursor={themeCursor}
      onThemeCursor={setThemeCursor}
      onThemePick={applyThemeById}
      onThemeClose={() => {
        setShowThemeList(false)
        setThemeNote(null)
      }}
    />
  )

  switch (screen) {
    case 'search':
      return searchScreen
    case 'results':
      return (
        <MovieResultsScreen
          query={query}
          movies={movieRows}
          statuses={statuses}
          selected={movieSelected}
          onSelected={setMovieSelected}
          onPick={pickMovie}
          onBack={() => setScreen('search')}
          keepNote={keepNote}
        />
      )
    case 'series':
      return (
        <SeriesScreen
          query={query}
          series={seriesList}
          statuses={statuses}
          selected={seriesSelected}
          onSelected={setSeriesSelected}
          onPick={pickSeries}
          onBack={() => setScreen('search')}
          keepNote={keepNote}
        />
      )
    case 'season':
      return currentSeries ? (
        <SeasonScreen
          show={currentSeries.show}
          rows={seasonRows}
          hunting={hunting}
          selected={seasonSelected}
          onSelected={setSeasonSelected}
          onPick={pickSeason}
          onBack={() => setScreen('series')}
        />
      ) : (
        searchScreen
      )
    case 'episode':
      return currentSeries && currentSeasonRef ? (
        <EpisodeScreen
          show={currentSeries.show}
          label={seasonLabel(currentSeasonRef, currentSeries)}
          rows={episodeRows}
          packs={seasonPacks}
          hunting={hunting}
          selected={episodeSelected}
          onSelected={setEpisodeSelected}
          onPickEpisode={pickEpisode}
          onPickPack={pickPack}
          onBack={() => setScreen('season')}
        />
      ) : (
        searchScreen
      )
    case 'detail':
      // Movie pre-flight: candidates are the flat movie rows; target 'auto'
      // lets the engine stream a single-video torrent directly and flip
      // multi-video torrents into the file picker.
      if (movieDetailIndex !== null) {
        return (
          <DetailScreen
            torrents={movieRows}
            index={movieDetailIndex}
            onIndex={setMovieDetailIndex}
            contextLabel={movieContext(movieRows[movieDetailIndex])}
            target={{ kind: 'auto' }}
            onStream={streamResult}
            onBack={() => {
              setMovieDetailIndex(null)
              setScreen('results')
            }}
          />
        )
      }
      return detail && currentSeries ? (
        <DetailScreen
          torrents={detailTorrents}
          index={detail.index}
          onIndex={index => setDetail(d => (d ? { ...d, index } : d))}
          contextLabel={
            detail.episode === null
              ? `${currentSeries.show} · ${seasonLabel(detail.ref, currentSeries)}`
              : detail.ref.kind === 'season'
                ? `${currentSeries.show} · S${pad2(detail.ref.season)}E${pad2(detail.episode)}`
                : `${currentSeries.show} · E${pad2(detail.episode)}`
          }
          target={
            detail.episode === null
              ? { kind: 'auto' }
              : {
                  kind: 'episode',
                  season: detail.ref.kind === 'season' ? detail.ref.season : null,
                  episode: detail.episode
                }
          }
          onStream={streamResult}
          hunting={hunting}
          onBack={() => setScreen(detail.from)}
        />
      ) : (
        searchScreen
      )
    case 'files':
      // The picker owns the screen only while a choice is genuinely pending;
      // engine errors (dead swarm mid-pick) fall through to the dashboard.
      return stats && stats.files && stats.awaitingFile && stats.phase === 'picking' ? (
        <FilePickerScreen
          stats={stats}
          wanted={
            detail && detail.episode !== null
              ? {
                  season: detail.ref.kind === 'season' ? detail.ref.season : null,
                  episode: detail.episode
                }
              : null
          }
          onPick={pickFile}
          onCancel={() => void teardownStream()}
        />
      ) : (
        <StreamScreen
          stats={stats}
          player={player}
          keepCache={config.keep_cache}
          keepDir={keep ? config.keep_directory : null}
          onStop={() => void teardownStream()}
        />
      )
    case 'stream':
      return (
        <StreamScreen
          stats={stats}
          player={player}
          keepCache={config.keep_cache}
          keepDir={keep ? config.keep_directory : null}
          onStop={() => void teardownStream()}
        />
      )
  }
}
