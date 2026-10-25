import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { isLoopbackAddress } from '../utils/lan.js'

const MB = 1024 * 1024

/* ------------------------------------------------------------------ *
 * Minimal structural types — deliberately decoupled from webtorrent
 * so the server can be exercised with fakes in tests.
 * ------------------------------------------------------------------ */

export interface TurboFile {
  name: string
  path: string
  length: number
  /** Byte offset of this file inside the torrent. */
  offset: number
  [Symbol.asyncIterator](opts?: { start?: number; end?: number }): AsyncIterableIterator<Uint8Array>
}

export interface TurboTorrent {
  infoHash: string
  name: string
  pieceLength: number
  length: number
  downloadSpeed: number
  numPeers: number
  pieces: unknown[]
  files: TurboFile[]
  bitfield: { get(index: number): boolean } | null
  select(start: number, end: number, priority?: number): void
  deselect(start: number, end: number): void
  critical(start: number, end: number): void
  /**
   * webtorrent ≥ 3 internals used for sliding "stream" windows. Stream
   * selections are removed by exact match and never clip other selections,
   * which makes them the only safe way to move a priority window around
   * while a whole-file selection stays alive. Guarded at runtime.
   */
  _select?(start: number, end: number, priority?: number, notify?: () => void, isStreamSelection?: boolean): void
  _deselect?(start: number, end: number, isStreamSelection?: boolean): void
}

export interface TurboServerOptions {
  /** Preferred local port; nearby ports (then an OS-assigned one) are tried. */
  port: number
  /** Seconds of video to keep downloaded ahead of the playhead. */
  windowSecs?: number
  /**
   * Bind all interfaces first instead of loopback. Set for --phone so the
   * server is reachable from the LAN from the very first request; the phone
   * URL itself stays token-gated either way.
   */
  preferLan?: boolean
  /** Resolve a torrent by infoHash for /webtorrent/<hash>/… URLs. */
  resolveTorrent?: (infoHash: string) => TurboTorrent | null
}

export interface TurboSnapshot {
  /** Byte offset the player is most likely consuming next. */
  playheadByte: number
  /** Size of the high-priority rolling window in bytes. */
  windowBytes: number
  /** Contiguous verified bytes from the playhead forward. */
  bufferAheadBytes: number
  /** Estimated seconds of playback ready in cache (null = still measuring). */
  bufferAheadSecs: number | null
  /** Active (recently reading) player connections. */
  connections: number
}

/* ------------------------------------------------------------------ *
 * MIME — extension-driven, no deps. Players sniff format from the
 * Content-Type and (older ones) from the URL extension, so both stay
 * truthful.
 * ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  srt: 'text/plain; charset=utf-8',
  vtt: 'text/vtt',
  ass: 'text/plain; charset=utf-8',
  ssa: 'text/plain; charset=utf-8'
}

function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/* ------------------------------------------------------------------ *
 * Range header parsing (RFC 7233 §3.1) — implemented by hand so the
 * behavior is deterministic across every client quirk:
 *   bytes=0-99 | bytes=500- | bytes=-250 | multi-range (first wins) |
 *   invalid syntax → header ignored (200 full) | past-EOF → 416.
 * ------------------------------------------------------------------ */

type ParsedRange = { start: number; end: number } | 'invalid' | 'unsatisfiable'

export function parseRangeHeader(header: string | undefined, size: number): ParsedRange | null {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header)
  if (!m || size <= 0) return null // unknown unit or empty file → ignore header

  const parts = m[1].split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return 'invalid'

  // Serve the first satisfiable range. Multipart/byteranges is deliberately
  // avoided: media players and DLNA renderers universally prefer 206 single.
  for (const part of parts) {
    const pm = /^(\d*)\s*-\s*(\d*)$/.exec(part)
    if (!pm) continue
    const [, first, last] = pm
    if (first === '' && last === '') continue

    if (first === '') {
      // suffix-byte-range-spec: bytes=-N
      const n = Number.parseInt(last, 10)
      if (!Number.isFinite(n)) continue
      if (n === 0) return 'unsatisfiable'
      const len = Math.min(n, size)
      return { start: size - len, end: size - 1 }
    }

    const start = Number.parseInt(first, 10)
    if (!Number.isFinite(start)) continue
    if (start >= size) return 'unsatisfiable'
    let end: number
    if (last === '') {
      end = size - 1
    } else {
      const parsedEnd = Number.parseInt(last, 10)
      if (!Number.isFinite(parsedEnd)) continue
      end = Math.min(parsedEnd, size - 1)
      if (end < start) continue // invalid range → try next part
    }
    return { start, end }
  }
  return 'invalid'
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

interface ServedConnection {
  id: number
  /** Byte position just past the last byte served on this connection. */
  position: number
  lastActivity: number
  open: boolean
}

interface WindowSelection {
  from: number
  to: number
}

/** What one served connection says about playback progress. */
export interface PlayheadSample {
  position: number
  lastActivity: number
  open: boolean
}

/** A connection that moved bytes this recently counts as actively reading. */
export const PLAYHEAD_HOT_MS = 10_000
/** Longer than this without a byte and the connection is ignored entirely. */
export const PLAYHEAD_IDLE_MS = 45_000

export interface PlayheadOptions {
  hotMs?: number
  idleMs?: number
}

/**
 * Pick the read position the piece window should follow.
 *
 * Two activity tiers, because both failure modes are real:
 *
 *  - a PAUSED player keeps its connection open but stops reading. Counting
 *    it for the full idle window drags the window backwards (and starves the
 *    player that is actually watching) — so only "hot" connections, which
 *    served bytes within `hotMs`, get to set the playhead.
 *  - if nothing is hot (the player is buffering, or the app just re-attached),
 *    fall back to the least-recently-idle reader rather than snapping to 0.
 *
 * The minimum across the chosen tier keeps VLC-style EOF/index probes from
 * parking the window at the end of the file. Returns null when no connection
 * qualifies, so callers can hold the previous playhead steady.
 */
export function selectPlayhead(
  samples: Iterable<PlayheadSample>,
  now: number,
  opts: PlayheadOptions = {}
): number | null {
  const hotMs = opts.hotMs ?? PLAYHEAD_HOT_MS
  const idleMs = opts.idleMs ?? PLAYHEAD_IDLE_MS
  let hot = Infinity
  let recent = Infinity
  for (const sample of samples) {
    if (!sample.open) continue
    const age = now - sample.lastActivity
    if (age > idleMs) continue
    if (sample.position < recent) recent = sample.position
    if (age <= hotMs && sample.position < hot) hot = sample.position
  }
  if (hot !== Infinity) return hot
  if (recent !== Infinity) return recent
  return null
}

/**
 * Is `pathname` reachable from this peer?
 *
 * Loopback sees every route. A LAN peer sees nothing unless a phone share is
 * live, and even then only the tokenized page and its media route. Exported
 * so the gate can be tested without a second network interface.
 */
export function remotePathAllowed(
  pathname: string,
  shareToken: string | null,
  remoteAddress: string | undefined
): boolean {
  if (isLoopbackAddress(remoteAddress)) return true
  if (!shareToken) return false
  const base = `/p/${shareToken}`
  return pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/`)
}

const CLAMP = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export class TurboServer {
  private readonly opts: Required<Pick<TurboServerOptions, 'port' | 'windowSecs'>> &
    TurboServerOptions
  private readonly server: http.Server
  private readonly sockets = new Set<Socket>()

  private torrent: TurboTorrent | null = null
  private file: TurboFile | null = null

  private readonly connections = new Map<number, ServedConnection>()
  private connSeq = 0

  private port = 0
  private boundHost = '127.0.0.1'
  private printHost = '127.0.0.1'
  private closed = false

  /** Non-null while a phone share is live: /p/<token> is the only LAN route. */
  private shareToken: string | null = null
  private shareHost: string | null = null

  // telemetry
  private speedEwma: number | null = null
  private velocityEwma: number | null = null
  private bitrateFloor = 96 * 1024
  private prevPlayhead: number | null = null
  private prevPlayheadAt = 0
  private lastPlayhead = 0
  private lastEscalation = 0
  private stalledSince: number | null = null

  // rolling window bookkeeping (stream selection — exact-match removable)
  private window: WindowSelection | null = null

  private bufferAheadBytes = 0
  private bufferAheadSecs: number | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: TurboServerOptions) {
    this.opts = { windowSecs: 30, ...opts }
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    // Socket hygiene: no Nagle (small 206 responses matter), keep-alive long
    // enough for players that idle between seeks, generous header time.
    this.server.on('connection', (socket: Socket) => {
      try {
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 15_000)
      } catch {
        /* already destroyed */
      }
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.keepAliveTimeout = 30_000
    this.server.headersTimeout = 65_000
  }

  get runningPort(): number {
    return this.port
  }

  /** True when the socket accepts LAN connections (not loopback-only). */
  get lanCapable(): boolean {
    return this.boundHost === '0.0.0.0' || this.boundHost === '::'
  }

  /** True while the phone page is exposed on the LAN. */
  get sharing(): boolean {
    return this.shareToken !== null
  }

  /**
   * Expose the current stream to the LAN behind a random token. Requests
   * from other devices are refused outside /p/<token> — see handleRequest.
   */
  enableSharing(host: string, token: string): string {
    this.shareHost = host
    this.shareToken = token
    return this.sharePageUrl ?? ''
  }

  /** Revoke LAN access and forget the token. */
  disableSharing(): void {
    this.shareToken = null
    this.shareHost = null
  }

  /** URL the QR encodes: the mobile landing page, never the raw media path. */
  get sharePageUrl(): string | null {
    if (!this.shareToken || !this.shareHost) return null
    return `http://${this.shareHost}:${this.port}/p/${this.shareToken}`
  }

  /** Direct media URL behind the share token (what the phone page plays). */
  private shareMediaPath(): string | null {
    if (!this.shareToken || !this.file) return null
    return `/p/${this.shareToken}/media${extOf(this.file.path || this.file.name)}`
  }

  /* -------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------- */

  /**
   * Bind the server. Tries the preferred port and its neighbors on a
   * dual-stack socket first (`::` with ipv6Only off accepts both v4-mapped
   * and v6), falling back to plain 127.0.0.1, then an OS-assigned port.
   */
  async listen(preferred: number): Promise<number> {
    const ports: number[] = [preferred]
    for (let i = 1; i <= 10; i++) ports.push(preferred + i)
    ports.push(0) // OS choice as last resort
    // --phone binds IPv4 wildcard first: maximally portable across home
    // routers, and it is the address family phones actually dial.
    const hosts = this.opts.preferLan ? ['0.0.0.0', '::', '127.0.0.1'] : ['::', '127.0.0.1']
    for (const host of hosts) {
      for (const port of ports) {
        const bound = await this.tryListen(port, host)
        if (bound !== null) {
          this.port = bound
          // Record the host that actually bound: `lanCapable` and the phone
          // hand-off depend on it, and detectPrintHost probes accordingly.
          this.boundHost = host
          this.printHost = await this.detectPrintHost(bound)
          return bound
        }
        if (this.closed) throw new Error('turbo server closed while starting')
      }
    }
    throw new Error('could not bind the stream server on any local port')
  }

  private tryListen(port: number, host: string): Promise<number | null> {
    return new Promise(resolve => {
      let settled = false
      const finish = (value: number | null): void => {
        if (settled) return
        settled = true
        this.server.removeListener('error', onError)
        this.server.removeListener('listening', onListening)
        resolve(value)
      }
      const onError = (): void => finish(null)
      const onListening = (): void => {
        const addr = this.server.address()
        finish(typeof addr === 'object' && addr !== null ? addr.port : port)
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      try {
        // '::' + default ipv6Only:false = dual-stack on every modern OS;
        // the 127.0.0.1 host pass covers exotic IPv6-less setups.
        this.server.listen({ port, host })
      } catch {
        finish(null)
      }
    })
  }

  /** Verify what host string actually answers locally, for the printed URL. */
  private async detectPrintHost(port: number): Promise<string> {
    const candidates = this.boundHost === '::' ? ['127.0.0.1', '[::1]'] : ['127.0.0.1']
    for (const host of candidates) {
      const ok = await new Promise<boolean>(resolve => {
        try {
          const req = http.request(`http://${host}:${port}/`, { method: 'HEAD' }, res => {
            res.resume()
            resolve((res.statusCode ?? 0) < 500)
          })
          req.on('error', () => resolve(false))
          req.setTimeout(500, () => {
            req.destroy()
            resolve(false)
          })
          req.end()
        } catch {
          resolve(false)
        }
      })
      if (ok) return host
    }
    return this.boundHost === '::' ? '[::1]' : '127.0.0.1'
  }

  /**
   * Point the server at the torrent/file being streamed. Safe to call once
   * per stream; resets playhead + window bookkeeping for the new media.
   */
  attach(torrent: TurboTorrent, file: TurboFile): void {
    this.torrent = torrent
    this.file = file
    this.connections.clear()
    this.lastPlayhead = 0
    this.prevPlayhead = null
    this.speedEwma = null
    this.velocityEwma = null
    this.window = null
    this.bufferAheadBytes = 0
    this.bufferAheadSecs = null
    this.stalledSince = null
    // Conservative bitrate floor: half a typical movie over 90 minutes,
    // raised to 96 kB/s so short clips still estimate sanely.
    this.bitrateFloor = Math.max(96 * 1024, Math.round(file.length / 5400))

    this.moveWindow(0) // prime the window immediately, don't wait a tick
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.tick(), 500)
      this.tickTimer.unref?.()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.disableSharing()
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.torrent = null
    this.file = null
    this.window = null
    await new Promise<void>(resolve => {
      let done = false
      const finish = (): void => {
        if (!done) {
          done = true
          resolve()
        }
      }
      for (const socket of this.sockets) {
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
      }
      this.sockets.clear()
      try {
        this.server.close(() => finish())
        this.server.once('close', finish)
      } catch {
        finish()
      }
      setTimeout(finish, 1500).unref?.()
    })
  }

  /* -------------------------------------------------------------- *
   * URLs
   * -------------------------------------------------------------- */

  /** Canonical media URL — keeps the real file extension (WMP & TVs sniff it). */
  canonicalUrl(infoHash: string, file: TurboFile): string {
    const segments = (file.path ?? file.name).split(/[\\/]/).map(encodeURIComponent).join('/')
    return `http://${this.printHost}:${this.port}/webtorrent/${infoHash}/${segments}`
  }

  /** Extension-carrying stable alias for the currently attached file. */
  get streamAliasUrl(): string {
    const ext = this.file ? extOf(this.file.path || this.file.name) : ''
    return `http://${this.printHost}:${this.port}/stream${ext}`
  }

  /* -------------------------------------------------------------- *
   * HTTP handling
   * -------------------------------------------------------------- */

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = (req.url ?? '/').split('?')[0]
    const pathname = rawUrl
      .split('/')
      .map(seg => {
        try {
          return decodeURIComponent(seg)
        } catch {
          return seg
        }
      })
      .join('/')

    try {
      // ── LAN gate ──────────────────────────────────────────────────────
      // Every route belongs to the local machine unless a phone share is
      // live — and even then only the tokenized page + media routes open.
      // The canonical /webtorrent/<hash>/<file> URL never leaves loopback,
      // so a shared stream cannot be reached by guessing a torrent path.
      const shareBase = this.shareToken ? `/p/${this.shareToken}` : null
      if (!remotePathAllowed(pathname, this.shareToken, req.socket.remoteAddress)) {
        res.writeHead(404, { 'Content-Length': 0 })
        res.end()
        return
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': (req.headers['access-control-request-headers'] as string) ?? 'Range',
          'Access-Control-Max-Age': '600'
        })
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', 'Content-Length': 0 })
        res.end()
        return
      }
      if (pathname === '/' || pathname === '') {
        this.serveListing(res)
        return
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(404, { 'Content-Length': 0 })
        res.end()
        return
      }

      // ── phone share: landing page + token-scoped media ──
      if (shareBase && (pathname === shareBase || pathname === `${shareBase}/`)) {
        this.servePhonePage(req, res)
        return
      }
      if (shareBase && pathname.startsWith(`${shareBase}/`)) {
        const leaf = pathname.slice(shareBase.length + 1)
        if (leaf === 'media' || /^media\.[a-z0-9]+$/i.test(leaf)) {
          if (this.torrent && this.file) {
            await this.serveMedia(req, res, this.torrent, this.file)
          } else {
            res.writeHead(503, { 'Content-Length': 0, 'Retry-After': '1' })
            res.end()
          }
          return
        }
        res.writeHead(404, { 'Content-Length': 0 })
        res.end()
        return
      }

      // stable aliases for the attached media (served directly — never a
      // redirect, which would drop Range semantics on dumb clients)
      if (pathname === '/stream' || /^\/stream(\.[a-z0-9]+)?$/i.test(pathname) || pathname.startsWith('/stream/')) {
        if (this.torrent && this.file) {
          await this.serveMedia(req, res, this.torrent, this.file)
        } else {
          res.writeHead(503, { 'Content-Length': 0, 'Retry-After': '1' })
          res.end()
        }
        return
      }

      // canonical webtorrent v2 route: /webtorrent/<infoHash>/<file path>
      const v2 = /^\/webtorrent\/([a-f0-9]{40})(\/(.*))?$/i.exec(pathname)
      if (v2) {
        const hash = v2[1].toLowerCase()
        const torrent = this.opts.resolveTorrent?.(hash) ?? null
        if (!torrent) {
          res.writeHead(404, { 'Content-Length': 0 })
          res.end()
          return
        }
        const rest = v2[3] ?? ''
        if (rest === '') {
          this.serveListing(res, torrent)
          return
        }
        const file = findFileByPath(torrent, rest)
        if (!file) {
          res.writeHead(404, { 'Content-Length': 0 })
          res.end()
          return
        }
        await this.serveMedia(req, res, torrent, file)
        return
      }

      // legacy webtorrent 1.x route: /<fileIndex> (direct 200/206, no redirect)
      const legacy = /^\/(\d{1,5})$/.exec(pathname)
      if (legacy && this.torrent && this.file) {
        const index = Number.parseInt(legacy[1], 10)
        const file = Number.isInteger(index) ? this.torrent.files[index] : undefined
        if (file) {
          await this.serveMedia(req, res, this.torrent, file)
          return
        }
      }

      res.writeHead(404, { 'Content-Length': 0 })
      res.end()
    } catch {
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': 0 })
        res.destroy()
      } catch {
        /* socket already gone */
      }
    }
  }

  /**
   * The mobile landing page: an inline web player plus a hand-off to a
   * native player for containers a browser cannot decode. Served only while
   * a share token is live; it never lists the torrent's other files.
   */
  private servePhonePage(req: IncomingMessage, res: ServerResponse): void {
    const mediaPath = this.shareMediaPath()
    const file = this.file
    if (!mediaPath || !file) {
      res.writeHead(503, { 'Content-Length': 0, 'Retry-After': '1' })
      res.end()
      return
    }
    const payload = Buffer.from(
      renderPhonePage({ fileName: file.name, fileSize: file.length, mediaPath }),
      'utf8'
    )
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(reqless(res) ? undefined : payload)
  }

  private serveListing(res: ServerResponse, torrent?: TurboTorrent): void {
    const t = torrent ?? this.torrent
    let body = '<!doctype html><html><body><h1>torrential</h1>'
    if (t) {
      body += `<p>${escapeHtml(t.name)}</p><ol>`
      for (const f of t.files) {
        const href = `/webtorrent/${t.infoHash}/${(f.path ?? f.name).split(/[\\/]/).map(encodeURIComponent).join('/')}`
        body += `<li><a href="${href}">${escapeHtml(f.name)}</a></li>`
      }
      body += '</ol>'
    } else {
      body += '<p>no active stream — pick a torrent in the app first</p>'
    }
    body += '</body></html>'
    const payload = Buffer.from(body, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': payload.length,
      'Access-Control-Allow-Origin': '*'
    })
    res.end(reqless(res) ? undefined : payload)
  }

  /* -------------------------------------------------------------- *
   * Media serving
   * -------------------------------------------------------------- */

  private async serveMedia(req: IncomingMessage, res: ServerResponse, torrent: TurboTorrent, file: TurboFile): Promise<void> {
    const size = file.length
    const baseHeaders: Record<string, string | number> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeFor(file.path || file.name),
      Expires: '0',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      // DLNA renderers look for this marker
      'transferMode.dlna.org': 'Streaming',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    }

    const range = size > 0 ? parseRangeHeader(req.headers.range as string | undefined, size) : null
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        ...baseHeaders,
        'Content-Range': `bytes */${size}`,
        'Content-Length': 0
      })
      res.end()
      return
    }

    const effective = range && range !== 'invalid' ? range : null
    const start = effective ? effective.start : 0
    const end = effective ? effective.end : Math.max(0, size - 1)
    const headers: Record<string, string | number> = {
      ...baseHeaders,
      'Content-Length': effective ? end - start + 1 : size
    }
    if (effective) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(effective ? 206 : 200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    // ---- playhead bookkeeping (one record per served connection) ----
    const conn: ServedConnection = { id: ++this.connSeq, position: start, lastActivity: Date.now(), open: true }
    this.connections.set(conn.id, conn)
    let aborted = false
    const abort = (): void => {
      aborted = true
      conn.open = false
    }
    res.once('close', abort)
    req.once('aborted', abort)
    const iterator = file[Symbol.asyncIterator]({ start, end })
    let served = 0
    try {
      for (;;) {
        if (aborted) break
        const { value, done } = await iterator.next()
        if (done || aborted) break
        const chunk = value as Uint8Array
        if (!chunk || chunk.byteLength === 0) continue
        served += chunk.byteLength
        conn.position = start + served
        conn.lastActivity = Date.now()
        if (!res.write(chunk)) {
          await new Promise<void>(resolve => {
            const drainDone = (): void => {
              res.removeListener('drain', drainDone)
              res.removeListener('close', drainDone)
              resolve()
            }
            res.once('drain', drainDone)
            res.once('close', drainDone)
          })
        }
      }
      if (aborted) res.destroy()
      else res.end()
    } catch {
      try {
        res.destroy()
      } catch {
        /* already gone */
      }
    } finally {
      this.connections.delete(conn.id)
      conn.open = false
      res.removeListener('close', abort)
      req.removeListener('aborted', abort) // v1.3.1: was never removed — listener leak
      const itAny = iterator as AsyncIterableIterator<Uint8Array> & {
        return?: () => unknown
        destroy?: (err?: Error) => void
      }
      try {
        itAny.destroy?.()
      } catch {
        /* FileIterator cleanup is best effort */
      }
      try {
        void itAny.return?.()
      } catch {
        /* generator cleanup is best effort */
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Playhead + rolling window engine
   * -------------------------------------------------------------- */

  /**
   * The playhead comes from selectPlayhead(): the minimum read position
   * across connections that are still consuming bytes. A secondary "index
   * probe" connection sitting at EOF (VLC/MKV-style) therefore never drags
   * the window to the end of the file, while a real seek (old connection
   * closed, new one opened) takes over immediately.
   */
  private computePlayhead(): number {
    const playhead = selectPlayhead(this.connections.values(), Date.now())
    if (playhead === null) return this.lastPlayhead
    this.lastPlayhead = playhead
    return playhead
  }

  private tick(): void {
    const torrent = this.torrent
    const file = this.file
    if (!torrent || !file) return
    const now = Date.now()

    // prune dead connections
    for (const [id, conn] of this.connections) {
      if (!conn.open || now - conn.lastActivity > 120_000) this.connections.delete(id)
    }

    const speed = torrent.downloadSpeed ?? 0
    this.speedEwma = this.speedEwma === null ? speed : this.speedEwma * 0.7 + speed * 0.3

    const pieceLength = torrent.pieceLength > 0 ? torrent.pieceLength : 0
    const lastPiece = Array.isArray(torrent.pieces) ? torrent.pieces.length - 1 : -1
    if (pieceLength <= 0 || lastPiece < 0) return

    const playhead = CLAMP(this.computePlayhead(), 0, Math.max(0, file.length - 1))
    const playheadPiece = CLAMP(Math.floor(playhead / pieceLength), 0, lastPiece)

    // contiguous verified bytes from the playhead forward
    let buffered = 0
    const bitfield = torrent.bitfield
    if (bitfield) {
      const scanCap = Math.min(lastPiece - playheadPiece + 1, 8192)
      while (buffered < scanCap && bitfield.get(playheadPiece + buffered)) buffered++
    }
    this.bufferAheadBytes = buffered * pieceLength

    // consumption velocity (bytes of media consumed per second)
    if (this.prevPlayhead !== null && now > this.prevPlayheadAt) {
      const v = (playhead - this.prevPlayhead) / ((now - this.prevPlayheadAt) / 1000)
      if (v >= 0) this.velocityEwma = this.velocityEwma === null ? v : this.velocityEwma * 0.8 + v * 0.2
    }
    this.prevPlayhead = playhead
    this.prevPlayheadAt = now

    const denominator = Math.max(this.velocityEwma ?? 0, this.bitrateFloor)
    this.bufferAheadSecs = denominator > 0 ? this.bufferAheadBytes / denominator : null

    this.moveWindow(playheadPiece)
    this.maybeEscalate(torrent, playheadPiece, lastPiece, pieceLength, now)
  }

  /**
   * Keep a high-priority (3) "stream" window anchored at the playhead,
   * sized from the measured swarm speed (≈ windowSecs of video, clamped to
   * 8–192 MB). Stream selections never clip the whole-file selection and
   * are exact-match removable, so sliding is clean.
   */
  private moveWindow(playheadPiece: number): void {
    const torrent = this.torrent
    if (!torrent) return
    if (typeof torrent._select !== 'function' || typeof torrent._deselect !== 'function') return
    const pieceLength = torrent.pieceLength > 0 ? torrent.pieceLength : 0
    const lastPiece = Array.isArray(torrent.pieces) ? torrent.pieces.length - 1 : -1
    if (pieceLength <= 0 || lastPiece < 0) return

    const windowSecs = this.opts.windowSecs ?? 30
    const winBytes = CLAMP(Math.round((this.speedEwma ?? 0) * windowSecs), 8 * MB, 192 * MB)
    const winPieces = Math.max(1, Math.ceil(winBytes / pieceLength))
    const to = Math.min(lastPiece, playheadPiece + winPieces)
    const slack = Math.max(1, Math.floor(winPieces / 4))

    const w = this.window
    const needsMove =
      !w ||
      playheadPiece > w.from + slack ||
      playheadPiece < w.from || // v1.3.1: backward seek — playhead left the window
      Math.abs(to - w.to) > slack
    if (!needsMove) return

    if (w) {
      try {
        torrent._deselect(w.from, w.to, true)
      } catch {
        /* window already gone — fine */
      }
    }
    try {
      torrent._select(playheadPiece, to, 3, undefined, true)
      this.window = { from: playheadPiece, to }
    } catch {
      this.window = null
    }
  }

  /**
   * When the swarm can't keep up with playback, hard-prioritize the next
   * ~8 MB after the playhead so whatever bandwidth exists is spent on the
   * frames the player needs next.
   */
  private maybeEscalate(
    torrent: TurboTorrent,
    playheadPiece: number,
    lastPiece: number,
    pieceLength: number,
    now: number
  ): void {
    const slow = (this.speedEwma ?? 0) < this.bitrateFloor * 1.5
    const hungry = this.bufferAheadSecs !== null && this.bufferAheadSecs < 12
    if (slow && hungry && now - this.lastEscalation > 2000) {
      this.lastEscalation = now
      this.stalledSince ??= now
      const to = Math.min(lastPiece, playheadPiece + Math.ceil((8 * MB) / pieceLength))
      try {
        torrent.critical(playheadPiece, to)
      } catch {
        /* best effort */
      }
    }
    if (this.bufferAheadSecs !== null && this.bufferAheadSecs > 30) {
      this.stalledSince = null
    }
  }

  getSnapshot(): TurboSnapshot {
    const torrent = this.torrent
    return {
      playheadByte: this.lastPlayhead,
      windowBytes:
        this.window && torrent && torrent.pieceLength > 0
          ? (this.window.to - this.window.from + 1) * torrent.pieceLength
          : 0,
      bufferAheadBytes: this.bufferAheadBytes,
      bufferAheadSecs: this.bufferAheadSecs,
      connections: [...this.connections.values()].filter(c => c.open).length
    }
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Compact size label for the phone page (no dependencies, no locale drift). */
function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/**
 * Self-contained phone page.
 *
 * Deliberately dependency-free: no framework, no build step, no external
 * request. It is a web player first (tap once to satisfy the mobile autoplay
 * rule) and a hand-off to VLC second, for containers — mkv, HEVC, AC3 — a
 * mobile browser refuses to decode. Nothing here saves the file: playback is
 * an ordinary HTTP Range stream from the computer.
 */
function renderPhonePage(info: {
  fileName: string
  fileSize: number
  mediaPath: string
}): string {
  const name = escapeHtml(info.fileName)
  const size = humanBytes(info.fileSize)
  const mediaJson = JSON.stringify(info.mediaPath)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0f14">
<title>${name} · torrential</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: #0b0f14; color: #e6edf3;
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { min-height: 100vh; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 14px; padding: 16px; }
video { width: 100%; max-width: 960px; max-height: 68vh; background: #000; border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0,0,0,.55); }
#tap { position: fixed; left: 50%; top: 38%; transform: translate(-50%, -50%); z-index: 2;
  border: 0; border-radius: 999px; padding: 14px 26px; font-size: 17px; font-weight: 600;
  color: #04120c; background: #6ee7a8; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
#tap[hidden] { display: none; }
.meta { width: 100%; max-width: 960px; display: flex; flex-direction: column; gap: 6px; }
.name { font-weight: 600; word-break: break-word; }
.sub, .hint { color: #8b98a5; font-size: 13px; }
.note { color: #f0c674; font-size: 13px; }
.note.warn { color: #ff7b72; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
.btn { appearance: none; border: 1px solid #2b333d; border-radius: 10px; padding: 11px 16px;
  font-size: 14px; font-weight: 600; text-decoration: none; color: #e6edf3; background: #161d25; }
.btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.hint { margin: 8px 0 0; }
</style>
</head>
<body>
<main>
  <video id="player" src="${info.mediaPath}" controls autoplay playsinline webkit-playsinline preload="auto"></video>
  <button id="tap" type="button">▶ tap to play</button>
  <div class="meta">
    <div class="name">${name}</div>
    <div class="sub">${size} · streaming from your computer over Wi-Fi</div>
    <div class="note" id="note">mkv, HEVC or AC3 files may not decode in a browser — use a player below.</div>
    <div class="actions">
      <a id="vlc" class="btn primary" href="#" rel="noreferrer">Open in VLC</a>
      <button id="copy" class="btn" type="button">Copy stream link</button>
    </div>
    <p class="hint">Nothing is saved on this phone. The file streams from the computer until you close this page.</p>
  </div>
</main>
<script>
(function () {
  var MEDIA = ${mediaJson};
  var video = document.getElementById('player');
  var tap = document.getElementById('tap');
  var note = document.getElementById('note');
  var raw = location.origin + MEDIA;
  var ua = navigator.userAgent;
  var vlc = document.getElementById('vlc');

  if (/Android/i.test(ua)) {
    vlc.textContent = 'Open in a player';
    vlc.href = 'intent://' + location.host + MEDIA +
      '#Intent;scheme=http;type=video/*;action=android.intent.action.VIEW;end';
  } else if (/iPad|iPhone|iPod/i.test(ua)) {
    vlc.href = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(raw);
  } else {
    vlc.hidden = true;
  }

  function hideTap() { tap.hidden = true; }
  tap.addEventListener('click', function () {
    hideTap();
    video.play().catch(function () {});
  });
  video.addEventListener('playing', hideTap);
  video.addEventListener('error', function () {
    hideTap();
    note.textContent = 'This browser cannot decode the file — open it in a player instead.';
    note.className = 'note warn';
  });

  document.getElementById('copy').addEventListener('click', function () {
    var button = this;
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(raw).then(function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy stream link'; }, 1600);
    }).catch(function () {});
  });

  if ('wakeLock' in navigator) {
    video.addEventListener('playing', function () {
      navigator.wakeLock.request('screen').catch(function () {});
    });
  }
  setTimeout(function () { if (!video.paused) hideTap(); }, 500);
})();
</script>
</body>
</html>`
}

function reqless(res: ServerResponse): boolean {
  // HEAD responses must not carry a body; end() after headers only.
  return res.req?.method === 'HEAD'
}

function findFileByPath(torrent: TurboTorrent, filePath: string): TurboFile | null {
  const wanted = filePath.replace(/\\/g, '/')
  const files = torrent.files ?? []
  const exact = files.find(f => (f.path ?? '').replace(/\\/g, '/') === wanted)
  if (exact) return exact
  const lower = wanted.toLowerCase()
  return files.find(f => (f.path ?? '').replace(/\\/g, '/').toLowerCase() === lower) ?? null
}
