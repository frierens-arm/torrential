import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import WebTorrent, { type WebTorrentFile, type WebTorrentTorrent, type WebTorrentServer } from 'webtorrent'
import parseTorrent from 'parse-torrent'
import type { KeptFile, ReadyInfo, StreamStats, StreamTarget, TorrentFileInfo } from '../types.js'
import { TRACKERS, VIDEO_EXTENSIONS } from '../constants.js'
import { describeTorrentId, infoHashFromId } from '../utils/magnet.js'
import { moveFileToKeepDir } from '../utils/keep.js'
import { parseTvTitle, scopeLabel } from '../utils/tv.js'
import { EngineHost } from './host.js'
import { TurboServer, type TurboFile, type TurboSnapshot, type TurboTorrent } from './turbo-server.js'

/* ------------------------------------------------------------------ *
 * Tiny typed event emitter
 * ------------------------------------------------------------------ */

export interface EngineError {
  message: string
  hint?: string
}

type EngineEvents = {
  stats: StreamStats
  ready: ReadyInfo
  error: EngineError
  /** Payload carries the file --keep rescued, or null. */
  stopped: KeptFile | null
}

type EventKey = keyof EngineEvents

export interface EngineOptions {
  /** The shared, pre-warmed WebTorrent client owner (one per app session). */
  host: EngineHost
  cacheDir: string
  /** Preferred local port; a nearby one is picked when busy. */
  port: number
  /** Milliseconds to wait for metadata before declaring the torrent dead. */
  metadataTimeoutMs: number
  /** Keep cached pieces on teardown instead of wiping them. */
  keepCache: boolean
  /** --keep: move the streamed file here (instead of wiping it) on teardown. */
  keepDir?: string | null
  /**
   * Turbo serving: custom HTTP layer with playhead tracking, an adaptive
   * rolling priority window and stall escalation. Falls back to
   * webtorrent's built-in server when disabled or unavailable.
   */
  turbo: boolean
  /** RAM budget (MB) for the piece cache in front of the disk store. 0 = webtorrent default. */
  ramCacheMB: number
  /** Head-start bytes fetched before the player ever opens a connection. */
  headStartBytes: number
  /** Tail bytes fetched in parallel (moov / Cues / idx1 live at file end). */
  tailPrefetchBytes: number
  /** Rolling window target in seconds of video ahead of the playhead. */
  windowSecs: number
  /** Filled in by start() — used for stat snapshots before metadata lands. */
  torrentId?: string
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Pick the file we stream: largest video file, else largest file. */
export function pickStreamFile(files: WebTorrentFile[]): WebTorrentFile {
  const score = (f: WebTorrentFile): number => {
    const ext = path.extname(f.name ?? '').toLowerCase()
    return (VIDEO_EXTENSIONS.has(ext) ? 1e15 : 0) + f.length
  }
  return files.reduce((best, f) => (score(f) > score(best) ? f : best), files[0])
}

/** Describe every file in a torrent — picker rows + episode matching. */
export function describeFiles(files: WebTorrentFile[]): TorrentFileInfo[] {
  return files.map((f, index) => {
    const name = f.name ?? `file-${index}`
    const parsed = parseTvTitle(name)
    return {
      index,
      name,
      path: f.path ?? name,
      length: f.length ?? 0,
      isVideo: VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()),
      scope: parsed.scope ?? undefined,
      scopeLabel: parsed.scope ? scopeLabel(parsed.scope) : undefined
    }
  })
}

function largestInfo(infos: TorrentFileInfo[]): TorrentFileInfo {
  return infos.reduce((best, i) => (i.length > best.length ? i : best), infos[0])
}

/**
 * The single video file of a one-file torrent, or a file that dwarfs the
 * rest (a feature upload with sample clips). null → needs the picker.
 */
function dominantVideo(infos: TorrentFileInfo[]): TorrentFileInfo | null {
  const videos = infos.filter(i => i.isVideo).sort((a, b) => b.length - a.length)
  if (videos.length === 0) return null
  if (videos.length === 1) return videos[0]
  const [top, second] = videos
  if (top.length >= 100_000_000 && top.length >= second.length * 5) return top
  return null
}

/**
 * Find the file inside a multi-file torrent that carries the wanted
 * episode. Exact SxxExx / 1xx / absolute-numbering matches first, then
 * filename heuristics; null = no confident match → interactive picker.
 */
export function pickEpisodeFile(
  infos: TorrentFileInfo[],
  season: number | null,
  episode: number
): TorrentFileInfo | null {
  const candidates = infos.filter(i => i.isVideo)
  if (candidates.length === 0) return null

  // 1. exact scope match: same season (or same absolute numbering),
  //    exact episode or an episodes[] range covering it.
  const exact = candidates.filter(i => {
    const s = i.scope
    if (!s || s.kind !== 'episode') return false
    if (s.season !== season) return false
    if (s.episodes) return s.episodes.includes(episode)
    return s.episode === episode
  })
  if (exact.length > 0) return largestInfo(exact)

  // 2. season-less files when the hunt itself is absolute (anime buckets).
  if (season === null) {
    const absolute = candidates.filter(i => {
      const s = i.scope
      if (!s || s.kind !== 'episode') return false
      return s.season === null && (s.episode === episode || (s.episodes?.includes(episode) ?? false))
    })
    if (absolute.length > 0) return largestInfo(absolute)
  }

  // 3. filename nomenclature, most explicit first.
  const e2 = String(episode).padStart(2, '0')
  const patterns: RegExp[] =
    season !== null
      ? [
          new RegExp(`\\bS0?${season}\\s?-?\\s?E0?${episode}\\b`, 'i'),
          new RegExp(`\\b${season}x0?${episode}\\b`, 'i'),
          new RegExp(`(?<!\\d)0?${season}${e2}(?!\\d)`),
          new RegExp(`\\bE${e2}\\b`, 'i')
        ]
      : [
          new RegExp(` - 0?${episode}(?:v\\d+)?\\s*[.\\[(]`, 'i'),
          new RegExp(`\\bE${e2}\\b`, 'i'),
          new RegExp(`(?<!\\d)${e2}(?!\\d)`)
        ]
  for (const re of patterns) {
    const hits = candidates.filter(i => re.test(i.name))
    if (hits.length > 0) return largestInfo(hits)
  }
  return null
}

/** Reserve a free TCP port near `start` without holding it (TOCTOU-tolerant). */
function findFreePort(start: number, attempts = 10): Promise<number> {
  return new Promise(resolve => {
    const tryPort = (port: number, remaining: number): void => {
      const probe = net.createServer()
      probe.once('error', () => {
        if (remaining > 0) tryPort(port + 1, remaining - 1)
        else resolve(0) // let the OS choose
      })
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(port))
      })
    }
    tryPort(start, attempts)
  })
}

/**
 * Verify webtorrent ≥ 2 route answers, using HEAD and a short timeout.
 * The package is pinned to ^3.0.21 (v2 routing), so this is a fast sanity
 * check — on any doubt we assume the v2 format instead of stalling startup.
 */
function probeStreamRoute(origin: string, infoHash: string, timeoutMs = 750): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const req = http.request(`${origin}/webtorrent/${infoHash}`, { method: 'HEAD' }, res => {
        const ok = (res.statusCode ?? 0) < 400
        res.resume()
        resolve(ok)
        req.destroy()
      })
      req.on('error', () => resolve(false))
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    } catch {
      resolve(false)
    }
  })
}

function waitForMetadata(torrent: WebTorrentTorrent, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (torrent.metadata) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('metadata never arrived'))
    }, timeoutMs)
    const onMetadata = (): void => {
      cleanup()
      resolve()
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      torrent.removeListener('metadata', onMetadata)
      torrent.removeListener('error', onError)
    }
    torrent.on('metadata', onMetadata)
    torrent.on('error', onError)
  })
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

export class StreamEngine {
  private listeners: { [K in EventKey]?: Array<(payload: EngineEvents[K]) => void> } = {}

  on<K extends EventKey>(event: K, cb: (payload: EngineEvents[K]) => void): this {
    const list = (this.listeners[event] ??= []) as Array<(payload: EngineEvents[K]) => void>
    list.push(cb)
    return this
  }

  private emitEvent<K extends EventKey>(event: K, payload: EngineEvents[K]): void {
    const list = this.listeners[event] as Array<(payload: EngineEvents[K]) => void> | undefined
    if (list) for (const cb of [...list]) cb(payload)
  }

  private readonly opts: EngineOptions
  private client: WebTorrent | null = null
  private torrent: WebTorrentTorrent | null = null
  private server: WebTorrentServer | null = null
  private turboServer: TurboServer | null = null
  private targetFile: WebTorrentFile | null = null
  private fileIndex = 0
  /** Parsed per-file TV metadata (populated when torrent metadata lands). */
  private fileInfos: TorrentFileInfo[] | null = null
  /** True while a multi-file torrent waits on the interactive picker. */
  private awaitingFile = false
  /** What the caller asked us to stream (auto / episode / exact file). */
  private streamTarget: StreamTarget = { kind: 'auto' }
  private url: string | null = null
  private port = 0
  private phase: StreamStats['phase'] = 'connecting'
  private errorMessage: string | undefined
  private errorHint: string | undefined
  private warnings: string[] = []
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private quietSince: number | null = null
  private deadWarned = false
  private stallWarned = false
  private bufferAheadSecs: number | null = null
  private metaCacheHit = false

  constructor(opts: EngineOptions) {
    this.opts = opts
  }

  get currentUrl(): string | null {
    return this.url
  }

  private addWarning(text: string): void {
    if (!this.warnings.includes(text)) {
      this.warnings = [...this.warnings, text].slice(-4)
    }
  }

  private snapshot(): StreamStats {
    const torrent = this.torrent
    const file = this.targetFile
    return {
      phase: this.phase,
      title: torrent?.name ?? describeTorrentId(this.opts.torrentId ?? ''),
      fileName: file?.name ?? 'resolving…',
      fileSize: file?.length ?? 0,
      fileIndex: this.fileIndex,
      fileCount: this.fileInfos?.length ?? torrent?.files.length ?? 0,
      videoFileCount: this.fileInfos ? this.fileInfos.filter(f => f.isVideo).length : 0,
      url: this.url,
      port: this.port,
      progress: file ? (file.progress ?? 0) : 0,
      overallProgress: torrent ? (torrent.progress ?? 0) : 0,
      downloaded: torrent ? (torrent.downloaded ?? 0) : 0,
      downloadSpeed: torrent ? (torrent.downloadSpeed ?? 0) : 0,
      uploadSpeed: torrent ? (torrent.uploadSpeed ?? 0) : 0,
      peers: torrent ? (torrent.numPeers ?? 0) : 0,
      timeRemaining: torrent ? (torrent.timeRemaining ?? 0) : 0,
      warnings: this.warnings,
      turbo: this.turboServer !== null,
      bufferAheadSecs: this.bufferAheadSecs,
      awaitingFile: this.awaitingFile,
      files: this.awaitingFile ? (this.fileInfos ?? undefined) : undefined,
      backend: 'torrent',
      error: this.errorMessage,
      errorHint: this.errorHint
    }
  }

  private emitStats(): void {
    this.emitEvent('stats', this.snapshot())
  }

  private fail(message: string, hint?: string): void {
    this.errorMessage = message
    this.errorHint = hint
    this.phase = 'error'
    this.emitStats()
    this.emitEvent('error', { message, hint })
  }

  /* ---------------------------------------------------------------- *
   * Metadata cache — the .torrent file is persisted per info-hash so
   * repeat streams skip the ut_metadata round-trip entirely.
   * ---------------------------------------------------------------- */

  private metaCachePath(infoHash: string): string {
    return path.join(this.opts.cacheDir, 'meta', `${infoHash}.torrent`)
  }

  private async loadCachedTorrentData(torrentId: string): Promise<{ data: Uint8Array; isPrivate: boolean } | null> {
    try {
      const hash = infoHashFromId(torrentId)
      if (!hash) return null
      const raw = await fs.promises.readFile(this.metaCachePath(hash))
      if (raw.byteLength === 0) return null
      const parsed = await parseTorrent(raw)
      if (!parsed || parsed.infoHash !== hash) return null
      return { data: new Uint8Array(raw), isPrivate: parsed.private === true }
    } catch {
      return null
    }
  }

  private saveMetadataCache(torrent: WebTorrentTorrent): void {
    try {
      const data = torrent.torrentFile
      if (!data || data.byteLength === 0) return
      const file = this.metaCachePath(torrent.infoHash)
      void fs.promises
        .mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.writeFile(file, data))
        .catch(() => {
          /* best effort — cache is a speedup, never a requirement */
        })
    } catch {
      /* best effort */
    }
  }

  /* ---------------------------------------------------------------- *
   * Head-start + tail prefetch
   *
   * Before the player opens a single connection we already mark the first
   * few megabytes as critical (first frame path) and the last couple as
   * high priority (MP4 moov atom / MKV Cues / AVI idx1 live at the end).
   * On slow links this collapses what used to be two serial player-driven
   * fetches into one parallel engine-driven fetch.
   * ---------------------------------------------------------------- */

  private applyPrefetchWindows(torrent: WebTorrentTorrent, file: WebTorrentFile): void {
    const pieceLength = torrent.pieceLength > 0 ? torrent.pieceLength : 0
    const lastPiece = torrent.pieces.length - 1
    if (pieceLength <= 0 || lastPiece < 0) return

    const fileStartPiece = Math.floor(file.offset / pieceLength)
    const headBytes = Math.min(this.opts.headStartBytes, file.length)
    let headEndPiece = fileStartPiece
    if (headBytes > 0) {
      headEndPiece = Math.min(lastPiece, Math.floor((file.offset + headBytes - 1) / pieceLength))
      try {
        torrent.select(fileStartPiece, headEndPiece, 3)
        torrent.critical(fileStartPiece, headEndPiece)
      } catch {
        /* prefetch is best effort */
      }
    }

    const tailBytes = Math.min(this.opts.tailPrefetchBytes, file.length)
    if (tailBytes > 0 && file.length > headBytes) {
      const tailStartByte = file.offset + (file.length - tailBytes)
      const tailStartPiece = Math.min(lastPiece, Math.floor(tailStartByte / pieceLength))
      if (tailStartPiece > headEndPiece) {
        try {
          torrent.select(tailStartPiece, lastPiece, 3)
          torrent.critical(tailStartPiece, lastPiece)
        } catch {
          /* prefetch is best effort */
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Add a torrent and bring the local stream server up.
   * Resolves once the endpoint is live; rejects on fatal problems
   * (dead swarm, invalid id, port trouble).
   */
  async start(torrentId: string, target: StreamTarget = { kind: 'auto' }): Promise<void> {
    this.opts.torrentId = torrentId
    this.streamTarget = target
    this.stopping = false
    this.awaitingFile = false
    this.fileInfos = null
    this.phase = 'connecting'
    this.metaCacheHit = false
    this.emitStats()

    const client = this.opts.host.client
    this.client = client

    // ── bring the HTTP endpoint up while the swarm is still being contacted ──
    // (the turbo server doesn't need metadata to listen — only to answer)
    if (this.opts.turbo) {
      try {
        const turbo = new TurboServer({
          port: this.opts.port,
          windowSecs: this.opts.windowSecs,
          resolveTorrent: hash => {
            const found = client.torrents.find(t => t.infoHash === hash)
            return (found as unknown as TurboTorrent) ?? null
          }
        })
        const port = await turbo.listen(this.opts.port)
        this.turboServer = turbo
        this.port = port
      } catch {
        // Turbo is a speedup, not a requirement — fall back to the
        // battle-tested webtorrent server below.
        this.turboServer = null
      }
    }

    // ── metadata fast path: reuse a previously saved .torrent when possible ──
    const cached = await this.loadCachedTorrentData(torrentId)
    this.metaCacheHit = cached !== null

    let torrent: WebTorrentTorrent
    try {
      const addOpts: Record<string, unknown> = {
        path: this.opts.cacheDir,
        deselect: true // nothing is downloaded until we select the stream file
      }
      if (this.opts.ramCacheMB > 0) {
        // Slots are pieces; assume a typical ~2 MB media piece so the RAM
        // budget lands in the right ballpark regardless of real piece size.
        addOpts.storeCacheSlots = Math.min(4096, Math.max(16, Math.round((this.opts.ramCacheMB * 1_000_000) / 2_000_000)))
      }
      if (cached) {
        // The saved .torrent already carries the original announce list; the
        // public tracker roster is merged on top unless the torrent is private.
        if (!cached.isPrivate) addOpts.announce = [...TRACKERS]
        torrent = client.add(cached.data, addOpts)
      } else {
        torrent = client.add(torrentId, addOpts)
      }
    } catch (err) {
      await this.destroyInternals()
      this.fail(
        `"${describeTorrentId(torrentId)}" is not a usable magnet or torrent URL`,
        'magnet links look like magnet:?xt=urn:btih:…'
      )
      throw err instanceof Error ? err : new Error(String(err))
    }
    this.torrent = torrent

    torrent.on('error', err => {
      if (!this.stopping) this.fail(err.message)
    })
    torrent.on('noPeers', (source: string) => {
      this.addWarning(`no peers via ${source} yet`)
    })

    try {
      await waitForMetadata(torrent, this.opts.metadataTimeoutMs)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.destroyInternals()
      const dead =
        message === 'metadata never arrived'
          ? `no metadata after ${Math.round(this.opts.metadataTimeoutMs / 1000)}s — this swarm looks dead (0 reachable seeds?)`
          : message
      this.fail(dead, 'try another result with more seeders, or check your connection')
      throw new Error(dead)
    }

    this.phase = 'metadata'
    this.emitStats()
    this.saveMetadataCache(torrent)

    // ── TV file resolution: which file inside the torrent do we serve? ──
    const infos = describeFiles(torrent.files)
    this.fileInfos = infos
    const file = this.resolveTargetFile(infos, target)

    if (file === null) {
      // Multi-file torrent with no confident match — hand the choice to
      // the interactive picker. The engine sits idle (nothing selected)
      // until selectFile() names the file.
      this.awaitingFile = true
      this.phase = 'picking'
      this.emitStats()
      return
    }

    await this.activateFile(torrent, file)
  }

  /**
   * Resolve a StreamTarget against the parsed file list.
   * null = no confident answer → the UI takes over with the picker.
   */
  private resolveTargetFile(infos: TorrentFileInfo[], target: StreamTarget): WebTorrentFile | null {
    const torrent = this.torrent
    if (!torrent) return null

    if (target.kind === 'file') {
      return torrent.files[target.fileIndex] ?? null
    }

    if (target.kind === 'episode') {
      const hit = pickEpisodeFile(infos, target.season, target.episode)
      return hit ? (torrent.files[hit.index] ?? null) : null
    }

    // auto: a lone video file (or one that dwarfs the rest) plays
    // directly; genuine multi-file season packs go to the picker.
    const dominant = dominantVideo(infos)
    if (dominant) return torrent.files[dominant.index] ?? null
    if (infos.filter(i => i.isVideo).length === 0) {
      const biggest = infos.reduce((best, i) => (i.length > best.length ? i : best), infos[0])
      this.addWarning('no video file in this torrent — serving the largest file anyway')
      return torrent.files[biggest.index] ?? null
    }
    return null
  }

  /**
   * Answer to the interactive picker: stream `fileIndex` from the
   * awaiting state. Ignored when no pick is pending.
   */
  selectFile(fileIndex: number): void {
    if (!this.awaitingFile) return
    const torrent = this.torrent
    if (!torrent) return
    const file = torrent.files[fileIndex]
    if (!file) return
    this.awaitingFile = false
    this.phase = 'ready'
    this.emitStats()
    void this.activateFile(torrent, file).catch(() => {
      /* fail() already surfaced the error through the stats channel */
    })
  }

  /** Common activation path once the target file is known. */
  private async activateFile(torrent: WebTorrentTorrent, file: WebTorrentFile): Promise<void> {
    const client = this.client ?? this.opts.host.client
    this.targetFile = file
    this.fileIndex = torrent.files.indexOf(file)
    try {
      torrent.files.forEach(f => {
        try {
          f.deselect()
        } catch {
          /* already deselected */
        }
      })
      file.select() // whole file at priority 0 — spare bandwidth fills it
    } catch {
      /* selection is best-effort; the HTTP server drives critical pieces anyway */
    }

    // Race the player to the bytes: head + tail are already moving before
    // the player's first Range request arrives.
    this.applyPrefetchWindows(torrent, file)

    // ── resolve the URL the player will open ──
    if (this.turboServer) {
      this.turboServer.attach(torrent as unknown as TurboTorrent, file as unknown as TurboFile)
      this.url = this.turboServer.canonicalUrl(torrent.infoHash, file as unknown as TurboFile)
    } else {
      try {
        const port = this.port !== 0 ? this.port : await findFreePort(this.opts.port)
        this.port = port
        const server = client.createServer()
        this.server = server
        await new Promise<void>((resolve, reject) => {
          const httpServer = server.listen(port, '127.0.0.1') as unknown as {
            once?: (ev: string, cb: (...args: unknown[]) => void) => void
          }
          const onError = (err: unknown): void =>
            reject(err instanceof Error ? err : new Error(String(err)))
          const onListening = (): void => resolve()
          if (httpServer?.once) {
            httpServer.once('error', onError)
            httpServer.once('listening', onListening)
          } else {
            resolve() // legacy API without events — assume it worked
          }
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.destroyInternals()
        this.fail(`could not start the local stream server: ${message}`, `is port ${this.opts.port} already in use?`)
        throw new Error(message)
      }

      const origin = `http://127.0.0.1:${this.port}`
      const segments = (file.path ?? file.name).split(/[\\/]/).map(encodeURIComponent).join('/')
      const v2Url = `${origin}/webtorrent/${torrent.infoHash}/${segments}`
      const v2Ok = await probeStreamRoute(origin, torrent.infoHash)
      if (v2Ok) {
        this.url = v2Url
      } else {
        // Legacy webtorrent 1.x routing: http://127.0.0.1:<port>/<fileIndex>
        this.url = `${origin}/${this.fileIndex}`
        this.addWarning('using legacy stream URL format')
      }
    }

    if (this.metaCacheHit) this.addWarning('metadata cache hit — torrent known from a previous session')

    this.phase = 'streaming'
    this.emitStats()
    this.emitEvent('ready', {
      url: this.url,
      title: torrent.name,
      fileName: file.name,
      fileSize: file.length,
      fileIndex: this.fileIndex,
      port: this.port
    })

    torrent.on('done', () => {
      this.phase = 'done'
      this.emitStats()
    })

    // Live stats + stall detection at a calm 4 Hz.
    this.statsTimer = setInterval(() => {
      if (this.stopping) return
      const t = this.torrent
      if (!t) return
      const quiet = t.numPeers === 0 || t.downloadSpeed < 1
      if (quiet && this.phase !== 'done') {
        this.quietSince ??= Date.now()
        const quietFor = Date.now() - this.quietSince
        if (quietFor > 25_000 && !this.deadWarned) {
          this.deadWarned = true
          this.addWarning('swarm is quiet — no peers or data for 25s; this torrent may be dead')
        }
      } else {
        this.quietSince = null
      }

      // turbo telemetry → honest "buffering" feedback in the TUI
      let snap: TurboSnapshot | null = null
      try {
        snap = this.turboServer?.getSnapshot() ?? null
      } catch {
        snap = null
      }
      if (snap) {
        this.bufferAheadSecs = snap.bufferAheadSecs
        if (snap.bufferAheadSecs !== null && snap.bufferAheadSecs < 10 && this.phase === 'streaming') {
          if (!this.stallWarned) {
            this.stallWarned = true
            this.addWarning('buffer ahead is low — the swarm is slower than playback right now')
          }
        } else if (snap.bufferAheadSecs !== null && snap.bufferAheadSecs > 25) {
          this.stallWarned = false
        }
      } else {
        this.bufferAheadSecs = null
      }

      this.emitStats()
    }, 250)
  }

  /**
   * Tear everything down: stats timer, HTTP server, torrent (the shared
   * client survives — the next stream reuses warm DHT/tracker state),
   * and (unless configured otherwise) the on-disk piece cache.
   *
   * With `keepDir` set, the streamed file is hoisted out of the cache and
   * moved there before the wipe — the disk still ends up clean, but the
   * movie survives in the user's media folder.
   */
  async stop(): Promise<KeptFile | null> {
    if (this.stopping) return null
    this.stopping = true
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    const torrentName = this.torrent?.name
    // Snapshot what --keep needs before destroyInternals() nulls the refs.
    const keepInfo =
      this.opts.keepDir && this.torrent && this.targetFile
        ? {
            src: path.resolve(this.opts.cacheDir, this.targetFile.path),
            fileName: this.targetFile.name,
            sizeBytes: this.targetFile.length,
            progress: this.targetFile.progress ?? 0
          }
        : null

    // Rescue the file BEFORE the destroy gauntlet: a rename completes in
    // microseconds on POSIX even while the store still has the file open,
    // so the movie is safe even if the process exits mid-teardown. Windows
    // can block renames of open files, so retry after destroy releases them.
    let kept = keepInfo ? await this.moveKeptFile(keepInfo, true) : null

    await this.destroyInternals()
    if (keepInfo && kept === null) {
      kept = await this.moveKeptFile(keepInfo, false)
    }
    if (!this.opts.keepCache && torrentName && torrentName.length > 0) {
      await this.wipeTorrentCache(torrentName)
    }
    this.phase = 'stopped'
    this.bufferAheadSecs = null
    this.emitStats()
    this.emitEvent('stopped', kept)
    return kept
  }

  /** Move the just-streamed file into opts.keepDir; never throws. */
  private async moveKeptFile(
    info: { src: string; fileName: string; sizeBytes: number; progress: number },
    quiet: boolean
  ): Promise<KeptFile | null> {
    try {
      const destPath = await moveFileToKeepDir(info.src, this.opts.keepDir!)
      if (!destPath) return null // nothing ever hit the disk
      return {
        fileName: info.fileName,
        destPath,
        sizeBytes: info.sizeBytes,
        progress: info.progress
      }
    } catch (err) {
      // quiet = first attempt, before destroy: a lock failure here is
      // expected on Windows and gets one retry after handles release.
      if (!quiet) {
        const message = err instanceof Error ? err.message : String(err)
        this.addWarning(`could not keep ${info.fileName}: ${message}`)
      }
      return null
    }
  }

  private async destroyInternals(): Promise<void> {
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    const turbo = this.turboServer
    const server = this.server
    const client = this.client
    const torrent = this.torrent
    this.turboServer = null
    this.server = null
    this.client = null
    this.torrent = null

    // Close the HTTP layer first — the player loses its source either way.
    if (turbo) {
      await Promise.race([turbo.close().catch(() => {}), delay(1500)])
    }
    if (server) {
      await new Promise<void>(resolve => {
        try {
          server.destroy(() => resolve())
          setTimeout(resolve, 2000).unref?.()
        } catch {
          resolve()
        }
      })
    }
    if (client && torrent) {
      // Remove only this torrent from the shared client. destroyStore: false
      // closes the store handles (unblocking Windows deletes) without
      // deleting data — the cache policy below handles that, and the DHT
      // routing table stays warm for the next stream.
      await new Promise<void>(resolve => {
        try {
          void Promise.resolve(client.remove(torrent, { destroyStore: false })).then(
            () => resolve(),
            () => resolve()
          )
          setTimeout(resolve, 3000).unref?.()
        } catch {
          resolve()
        }
      })
    }
  }

  /** Remove this torrent's cache folder, guarding against path escape. */
  private async wipeTorrentCache(torrentName: string): Promise<void> {
    try {
      const cacheRoot = path.resolve(this.opts.cacheDir)
      const target = path.resolve(cacheRoot, torrentName)
      if (target !== cacheRoot && target.startsWith(cacheRoot + path.sep)) {
        await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
      }
    } catch {
      // Windows file locks can briefly hold store files — non-fatal.
    }
  }
}
