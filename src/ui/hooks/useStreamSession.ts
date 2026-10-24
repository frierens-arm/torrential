import { useCallback, useRef, useState } from 'react'
import { useApp } from 'ink'
import type { ChildProcess } from 'node:child_process'
import type { KeptFile, ReadyInfo, StreamStats, StreamTarget } from '../../types.js'
import type { TorrentialConfig } from '../../config.js'
import { StreamEngine } from '../../engine/stream.js'
import type { EngineHost } from '../../engine/host.js'
import { resolveLaunchChain, trySpawnPlayer, killPlayer, type PlayerLaunch } from '../../utils/players.js'
import { formatBytes, truncateStart } from '../../utils/format.js'
import { log } from '../../utils/log.js'
import type { PlayerInfo } from '../screens/StreamScreen.js'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface UseStreamSessionOptions {
  config: TorrentialConfig
  host: EngineHost
  noPlayer: boolean
  playerOverride?: string
  /** --keep: rescue the streamed file into config.keep_directory on stop. */
  keep: boolean
  /** Called before a stream starts (the screen flips to 'stream'). */
  onBegin: () => void
  /** Called once a stream is actually starting, with its target. */
  onStreamed?: (torrentId: string, target: StreamTarget) => void
  /**
   * Called after teardown finishes. Lives in App because only it knows which
   * screen the stream was launched from.
   */
  onTeardown: () => void
}

export interface StreamSession {
  stats: StreamStats | null
  player: PlayerInfo | null
  /** "saved → …" note from a --keep teardown, shown on the search screen. */
  keepNote: string | null
  clearKeepNote: () => void
  beginStream: (torrentId: string, target?: StreamTarget) => void
  teardownStream: () => Promise<void>
  selectFile: (fileIndex: number) => void
  /** Full app shutdown: player, engine, shared client, then exit Ink. */
  shutdown: () => Promise<void>
}

/** Human line for a file --keep rescued out of the cache. */
function describeKept(kept: KeptFile): string {
  const pct = Math.floor((kept.progress ?? 0) * 100)
  const completeness = (kept.progress ?? 0) < 0.999 ? `${pct}% downloaded` : 'complete'
  return `saved → ${truncateStart(kept.destPath, 64)} (${formatBytes(kept.sizeBytes)}, ${completeness})`
}

/**
 * One stream's lifecycle: engine construction, player hand-off, stats, and
 * teardown. Extracted from App.tsx so the provider/search side and the
 * playback side cannot entangle, and so a future remote-player mode has a
 * single place to hook into.
 */
export function useStreamSession(opts: UseStreamSessionOptions): StreamSession {
  const { exit } = useApp()
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [player, setPlayer] = useState<PlayerInfo | null>(null)
  const [keepNote, setKeepNote] = useState<string | null>(null)

  const engineRef = useRef<StreamEngine | null>(null)
  const playerChildRef = useRef<ChildProcess | null>(null)
  const tearingDownRef = useRef(false)
  const shuttingDownRef = useRef(false)

  // Latest options behind a ref: engine callbacks fire long after the render
  // that created them, and re-creating beginStream would restart playback.
  const optsRef = useRef(opts)
  optsRef.current = opts

  const teardownStream = useCallback(async (): Promise<void> => {
    if (tearingDownRef.current) return
    tearingDownRef.current = true
    const child = playerChildRef.current
    playerChildRef.current = null
    const engine = engineRef.current
    engineRef.current = null
    setPlayer(null)
    log('stream:teardown', { player: child !== null, engine: engine !== null })
    if (child) await Promise.race([killPlayer(child), delay(2500)])
    if (engine) await Promise.race([engine.stop(), delay(3000)])
    tearingDownRef.current = false
    optsRef.current.onTeardown()
  }, [])

  const beginStream = useCallback((torrentId: string, target: StreamTarget = { kind: 'auto' }): void => {
    const o = optsRef.current
    setStats(null)
    setPlayer(null)
    o.onBegin()
    o.onStreamed?.(torrentId, target)

    const engine = new StreamEngine({
      host: o.host,
      cacheDir: o.config.cache_directory,
      port: o.config.port,
      metadataTimeoutMs: o.config.metadata_timeout * 1000,
      keepCache: o.config.keep_cache,
      keepDir: o.keep ? o.config.keep_directory : null,
      turbo: o.config.turbo,
      ramCacheMB: o.config.ram_cache_mb,
      headStartBytes: o.config.head_start_mb * 1_000_000,
      tailPrefetchBytes: o.config.tail_prefetch_mb * 1_000_000,
      windowSecs: o.config.window_secs
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
      if (o.noPlayer) {
        setPlayer({ label: 'none (--no-player) — open the endpoint above', detached: true })
        return
      }
      const preference = o.playerOverride ?? o.config.default_player
      const { chain, note } = resolveLaunchChain(
        preference,
        o.config.player_fallbacks,
        info.url,
        o.config.player_flags
      )
      if (chain.length === 0) {
        setPlayer({
          label: 'no player found — open the endpoint above manually',
          detached: true,
          note: 'install mpv or vlc (see README) or set default_player / --player to a binary you have'
        })
        return
      }
      void trySpawnPlayer(chain).then(({ child, launch }: { child: ChildProcess | null; launch: PlayerLaunch | null }) => {
        if (!child || !launch) {
          setPlayer({ label: 'player launch failed — open the endpoint above manually', detached: true, note })
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
  }, [teardownStream])

  const selectFile = useCallback((fileIndex: number): void => {
    engineRef.current?.selectFile(fileIndex)
  }, [])

  const shutdown = useCallback(async (): Promise<void> => {
    if (shuttingDownRef.current) return
    shuttingDownRef.current = true
    const child = playerChildRef.current
    const engine = engineRef.current
    playerChildRef.current = null
    engineRef.current = null
    log('app:shutdown')
    if (child) void killPlayer(child)
    if (engine) await Promise.race([engine.stop(), delay(2500)])
    // The shared client is destroyed only on app exit.
    await Promise.race([optsRef.current.host.destroy(), delay(3500)])
    exit()
  }, [exit])

  const clearKeepNote = useCallback((): void => setKeepNote(null), [])

  return {
    stats,
    player,
    keepNote,
    clearKeepNote,
    beginStream,
    teardownStream,
    selectFile,
    shutdown
  }
}
