import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInput } from 'ink'
import type { SearchResult, StreamTarget } from '../types.js'
import type { TorrentialConfig } from '../config.js'
import type { EngineHost } from '../engine/host.js'
import { parseSlashCommand } from '../utils/commands.js'
import { looksLikeTorrentId } from '../utils/magnet.js'
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
import { lastWatchedFor, loadState, pushHistory, recordWatched, saveState, type SessionState } from '../utils/state.js'
import { SearchScreen } from './screens/SearchScreen.js'
import { SeriesScreen } from './screens/SeriesScreen.js'
import { MovieResultsScreen } from './screens/MovieResultsScreen.js'
import { SeasonScreen } from './screens/SeasonScreen.js'
import { EpisodeScreen } from './screens/EpisodeScreen.js'
import { DetailScreen } from './screens/DetailScreen.js'
import { FilePickerScreen } from './screens/FilePickerScreen.js'
import { StreamScreen } from './screens/StreamScreen.js'
import { useSearch } from './hooks/useSearch.js'
import { useStreamSession } from './hooks/useStreamSession.js'
import { usePreferences } from './hooks/usePreferences.js'

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

  /* ── tier navigation state ── */
  const [seriesSelected, setSeriesSelected] = useState(0)
  const [currentSeriesKey, setCurrentSeriesKey] = useState<string | null>(null)
  const [seasonSelected, setSeasonSelected] = useState(0)
  const [currentSeasonRef, setCurrentSeasonRef] = useState<SeasonRef | null>(null)
  const [episodeSelected, setEpisodeSelected] = useState(0)
  const [detail, setDetail] = useState<DetailCtx | null>(null)

  /* ── movie-path state (auto/movies modes) ── */
  const [movieSelected, setMovieSelected] = useState(0)
  /** Non-null = detail card points at the movie candidate list. */
  const [movieDetailIndex, setMovieDetailIndex] = useState<number | null>(null)
  /** Auto-mode router fires once per search — on the first results batch. */
  const routedRef = useRef(false)

  /* ── continuity: search history + where you left off ── */
  const [sessionState, setSessionState] = useState<SessionState>(() => loadState())
  /** "next up: E02 — ⏎ to play" line on the pre-flight card. */
  const [nextNote, setNextNote] = useState<string | null>(null)
  /** Guards the resume-cursor nudge so it fires once per season, not per render. */
  const resumeAppliedRef = useRef<string | null>(null)

  const prefs = usePreferences(config.mode, configFile)
  const mode = prefs.mode
  const { applyThemeCommand, applyModeCommand, setNote, closeThemeList } = prefs

  /* Refs so the stable stream/search callbacks always read current state. */
  const modeRef = useRef(mode)
  const detailRef = useRef(detail)
  const movieDetailIndexRef = useRef(movieDetailIndex)
  const allResultsLenRef = useRef(0)
  const seriesRef = useRef<SeriesData | null>(null)
  const progressRef = useRef(0)
  const lastPlayedRef = useRef<{ seriesKey: string; season: number | null; episode: number } | null>(null)
  modeRef.current = mode
  detailRef.current = detail
  movieDetailIndexRef.current = movieDetailIndex

  /* ------------------------------------------------------------------ *
   * Search + supplemental hunts (hooks/useSearch)
   * ------------------------------------------------------------------ */

  const { statuses, allResults, hunting, hunt, resetResults } = useSearch({
    query,
    searchSeq,
    mode,
    config,
    onFirstBatch: rows => {
      // ── auto-mode router: the FIRST batch decides, once ──
      if (modeRef.current !== 'auto' || routedRef.current) return
      routedRef.current = true
      const classes = rows.map(r =>
        r.media
          ? { kind: r.media.kind, confidence: r.media.confidence, signals: ['row-media'] }
          : classifyTitle(r.title)
      )
      const vote = voteKind(classes)
      let winner = vote.kind
      if (winner === 'unknown') {
        // Mild prior: a bare query with a year leans movie when the swarm
        // answered with uninformative rows.
        const prior = classifyQuery(query)
        if (prior.kind === 'movie' && prior.confidence >= 0.5) winner = 'movie'
      }
      setScreen(winner === 'movie' ? 'results' : 'series')
    },
    onEmpty: () => {
      // Zero rows anywhere → 2.0.0's empty series screen.
      if (modeRef.current === 'auto' && !routedRef.current) {
        routedRef.current = true
        setScreen('series')
      }
    }
  })

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

  allResultsLenRef.current = allResults.length
  seriesRef.current = currentSeries

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
      return ref.season === 0 ? 'Specials' : `Season ${ref.season}`
    }
    return 'Season'
  }

  /* ------------------------------------------------------------------ *
   * Streaming lifecycle (hooks/useStreamSession)
   * ------------------------------------------------------------------ */

  const stream = useStreamSession({
    config,
    host,
    noPlayer,
    playerOverride,
    keep,
    onBegin: () => setScreen('stream'),
    onStreamed: (_torrentId, target: StreamTarget) => {
      // A movie / magnet / pack stream must never trigger next-episode logic.
      if (target.kind !== 'episode') {
        lastPlayedRef.current = null
        progressRef.current = 0
        return
      }
      const ctx = detailRef.current
      if (!ctx || ctx.episode === null) return
      const season = ctx.ref.kind === 'season' ? ctx.ref.season : null
      lastPlayedRef.current = { seriesKey: ctx.seriesKey, season, episode: target.episode }
      progressRef.current = 0
      setSessionState(prev => recordWatched(prev, ctx.seriesKey, { season, episode: target.episode }))
    },
    onTeardown: () => {
      // Auto-advance only when the episode really finished: bailing out at
      // 40% must leave the pre-flight card exactly where it was.
      const finished = progressRef.current >= 0.95
      const last = lastPlayedRef.current
      const series = seriesRef.current
      let advanced = false
      if (finished && last && series && last.seriesKey === series.key) {
        const bucket = last.season === null ? series.unsorted : series.seasons.get(last.season)
        const episodes = bucket ? [...bucket.episodes.keys()].sort((a, b) => a - b) : []
        const next = episodes.find(episode => episode > last.episode)
        if (next !== undefined) {
          const ref: SeasonRef =
            last.season === null ? { kind: 'unsorted' } : { kind: 'season', season: last.season }
          setDetail({ seriesKey: series.key, ref, episode: next, index: 0, from: 'episode' })
          setNextNote(`finished E${pad2(last.episode)} — next up E${pad2(next)} · ⏎ to play`)
          advanced = true
        }
      }
      if (advanced) lastPlayedRef.current = null

      // Land back where the stream was launched from — the detail pre-flight
      // (n/p to another torrent), the series browser, the movie list, or the
      // search bar.
      setScreen(prev => {
        if (prev !== 'stream' && prev !== 'files') return prev
        if (advanced || detailRef.current || movieDetailIndexRef.current !== null) return 'detail'
        if (allResultsLenRef.current > 0) return modeRef.current === 'movies' ? 'results' : 'series'
        return 'search'
      })
    }
  })
  const { stats, player, keepNote, clearKeepNote, beginStream, teardownStream, selectFile, shutdown } = stream

  useEffect(() => {
    if (stats) progressRef.current = stats.progress
  }, [stats])

  /* Persist history / last-watched. Failures are logged and ignored. */
  useEffect(() => {
    saveState(sessionState)
  }, [sessionState])

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

  /**
   * Resume: when the episode grid for a season opens, park the cursor on the
   * last episode streamed from that season. Runs once per (series, season) so
   * it never fights the user's own j/k movement afterwards. Absolute-numbered
   * shows use the 'unsorted' bucket, whose season is null.
   */
  useEffect(() => {
    if (screen !== 'episode' || !currentSeries || !currentSeasonRef) return
    const seasonOf = currentSeasonRef.kind === 'season' ? currentSeasonRef.season : currentSeasonRef.kind === 'unsorted' ? null : undefined
    if (seasonOf === undefined) return
    const key = `${currentSeries.key}:${seasonOf ?? 'absolute'}`
    if (resumeAppliedRef.current === key) return
    resumeAppliedRef.current = key
    const watched = lastWatchedFor(sessionState, currentSeries.key)
    if (!watched || watched.season !== seasonOf) return
    const index = episodeRows.findIndex(row => row.episode === watched.episode)
    if (index >= 0) setEpisodeSelected(index)
  }, [screen, currentSeries, currentSeasonRef, episodeRows, sessionState])

  /* ------------------------------------------------------------------ *
   * Navigation handlers
   * ------------------------------------------------------------------ */

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
        setNote({
          kind: 'err',
          text: `unknown command "/${cmd.name}" — try /theme <name> or /mode <auto|tv|movies>`
        })
        return
      }
      const torrentId = looksLikeTorrentId(trimmed)
      if (torrentId) {
        clearKeepNote() // last rescue line expires on a fresh hunt
        setNote(null)
        closeThemeList()
        setDetail(null)
        beginStream(torrentId)
        return
      }
      clearKeepNote() // last rescue line expires on a fresh hunt
      setNote(null) // command feedback expires too
      closeThemeList()
      resetResults()
      setSeriesSelected(0)
      setMovieSelected(0)
      setMovieDetailIndex(null)
      setDetail(null)
      setNextNote(null)
      resumeAppliedRef.current = null
      setCurrentSeriesKey(null)
      setCurrentSeasonRef(null)
      setQuery(trimmed)
      setSearchSeq(seq => seq + 1)
      setSessionState(prev => pushHistory(prev, trimmed))
      // Landing screen by content mode: tv keeps 2.0.0's series tiers;
      // movies goes to the flat list; auto stays put until the first
      // results batch votes (see the router above).
      setScreen(mode === 'tv' ? 'series' : mode === 'movies' ? 'results' : 'search')
    },
    [applyModeCommand, applyThemeCommand, beginStream, clearKeepNote, closeThemeList, mode, resetResults, setNote]
  )

  /* ── movie path: pick a row → pre-flight card over the movie list ── */
  const pickMovie = useCallback(
    (result: SearchResult): void => {
      const index = Math.max(0, movieRows.findIndex(r => r.id === result.id))
      setMovieDetailIndex(index)
      setNextNote(null)
      setScreen('detail')
    },
    [movieRows]
  )

  /* ── tier 1 → tier 2: pick a series, browse its seasons ── */
  const pickSeries = useCallback((summary: SeriesSummary): void => {
    setCurrentSeriesKey(summary.key)
    setSeasonSelected(0)
    setNextNote(null)
    setScreen('season')
  }, [])

  /* ── tier 2 → tier 3: pick a season (or pack bucket), browse episodes ── */
  const pickSeason = useCallback(
    (ref: SeasonRef): void => {
      if (!currentSeries) return
      setCurrentSeasonRef(ref)
      setEpisodeSelected(0)
      setNextNote(null)
      setScreen('episode')

      // Smart hunt: a season with no pack coverage gets Sxx / "season N"
      // queries injected so packs and straggler episodes surface.
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
      setNextNote(null)
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
      setNextNote(null)
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
  const pickFile = useCallback(
    (fileIndex: number): void => {
      selectFile(fileIndex)
      setScreen('stream')
    },
    [selectFile]
  )

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

  // ▶ marker: only for the season (or absolute bucket) actually watched.
  const watchedForSeries = currentSeries ? lastWatchedFor(sessionState, currentSeries.key) : null
  let resumeEpisode: number | null = null
  if (watchedForSeries && currentSeasonRef) {
    if (currentSeasonRef.kind === 'season' && watchedForSeries.season === currentSeasonRef.season) {
      resumeEpisode = watchedForSeries.episode
    } else if (currentSeasonRef.kind === 'unsorted' && watchedForSeries.season === null) {
      resumeEpisode = watchedForSeries.episode
    }
  }

  const searchScreen = (
    <SearchScreen
      initialQuery={query}
      onSubmit={submitSearch}
      warnings={warnings}
      history={sessionState.history}
      keepNote={keepNote}
      themeNote={prefs.note}
      showThemeList={prefs.showThemeList}
      themeCursor={prefs.themeCursor}
      onThemeCursor={prefs.setThemeCursor}
      onThemePick={prefs.applyThemeById}
      onThemeClose={prefs.closeThemeList}
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
          resumeEpisode={resumeEpisode}
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
          note={nextNote}
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
