/**
 * Minimal ambient typings for the `webtorrent` npm package (v3.x).
 *
 * The package ships no TypeScript declarations of its own; these describe
 * exactly the surface torrential uses. Verified against webtorrent 3.0.21:
 *   - client.add(id | .torrent data, { path, deselect: true })
 *   - file.select(priority?) / file.deselect() / file async iteration
 *   - torrent.select/deselect/critical piece-range APIs (+ _select stream
 *     selections used by the turbo rolling window; guarded at runtime)
 *   - client.remove(torrent, { destroyStore: false }) on a shared client
 *   - client.createServer() → NodeServer (no-turbo fallback path)
 */

declare module 'webtorrent' {
  export interface WebTorrentFile {
    name: string
    path: string
    length: number
    /** Byte offset of this file inside the torrent. */
    offset: number
    downloaded: number
    progress: number
    select(priority?: number | boolean): void
    deselect(): void
    createReadStream(opts?: { start?: number; end?: number }): unknown
    [Symbol.asyncIterator](opts?: { start?: number; end?: number }): AsyncIterableIterator<Uint8Array>
  }

  export interface WebTorrentTorrent {
    name: string
    infoHash: string
    magnetURI: string
    length: number
    pieceLength: number
    lastPieceLength: number
    downloaded: number
    progress: number
    downloadSpeed: number
    uploadSpeed: number
    numPeers: number
    timeRemaining: number
    metadata: unknown | null
    /** The full .torrent file (info dict + announce list) once metadata lands. */
    torrentFile: Uint8Array
    files: WebTorrentFile[]
    pieces: { length: number }[]
    bitfield: { get(index: number): boolean } | null
    on(event: 'metadata', cb: () => void): this
    on(event: 'ready', cb: () => void): this
    on(event: 'done', cb: () => void): this
    on(event: 'download', cb: () => void): this
    on(event: 'upload', cb: () => void): this
    on(event: 'wire', cb: (wire: unknown) => void): this
    on(event: 'noPeers', cb: (announceType: string) => void): this
    on(event: 'error', cb: (err: Error) => void): this
    once(event: string, cb: (...args: any[]) => void): this
    removeListener(event: string, cb: (...args: any[]) => void): this
    select(start: number, end: number, priority?: number | boolean, notify?: () => void): void
    deselect(start: number, end: number): void
    critical(start: number, end: number): void
    /** webtorrent ≥3 stream-selection internals (guarded at runtime). */
    _select?(
      start: number,
      end: number,
      priority?: number,
      notify?: () => void,
      isStreamSelection?: boolean
    ): void
    _deselect?(start: number, end: number, isStreamSelection?: boolean): void
    destroy(opts?: { destroyStore?: boolean }, cb?: () => void): void
  }

  export interface WebTorrentServer {
    listen(...args: unknown[]): unknown
    close(cb?: () => void): void
    destroy(cb?: () => void): void
    address(): { port: number; address: string; family?: string } | null
  }

  export default class WebTorrent {
    torrents: WebTorrentTorrent[]
    constructor(opts?: {
      dht?: boolean
      tracker?: boolean | object
      maxConns?: number
      uploadLimit?: number
      downloadLimit?: number
      [key: string]: unknown
    })
    add(
      torrentId: string | Uint8Array,
      opts?: { path?: string; deselect?: boolean; storeCacheSlots?: number; announce?: string[]; [key: string]: unknown },
      ontorrent?: (torrent: WebTorrentTorrent) => void
    ): WebTorrentTorrent
    remove(torrentId: unknown, opts?: { destroyStore?: boolean }, cb?: () => void): unknown
    createServer(opts?: { pathname?: string; origin?: string | false; hostname?: string }): WebTorrentServer
    destroy(cb?: (err?: Error) => void): void
    on(event: 'error', cb: (err: Error) => void): this
    on(event: 'torrent', cb: (torrent: WebTorrentTorrent) => void): this
  }
}

declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string
    name?: string
    private?: boolean
    announce?: string[]
    urlList?: string[]
    length?: number
    [key: string]: unknown
  }
  export default function parseTorrent(id: string | Uint8Array): Promise<ParsedTorrent>
}
