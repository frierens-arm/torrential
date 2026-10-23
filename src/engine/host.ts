import WebTorrent from 'webtorrent'

export interface EngineHostOptions {
  /** Max simultaneous peer connections per torrent (webtorrent default is 55). */
  maxConns?: number
  /** Upload cap in bytes per second; -1 / undefined = unlimited. */
  uploadLimitBytesPerSec?: number
}

/**
 * Owns the process-wide WebTorrent client.
 *
 * The client is constructed eagerly (at CLI boot) so the DHT bootstrap and the
 * first tracker announces happen while the user is still picking a result — by
 * the time a magnet reaches the engine, peer discovery is already warm. The
 * same client is reused for every stream in the session; only torrents come
 * and go (`client.remove` on teardown keeps the DHT routing table hot, which
 * makes every stream after the first noticeably faster to start).
 */
export class EngineHost {
  readonly client: WebTorrent
  private destroyed = false

  constructor(opts: EngineHostOptions = {}) {
    this.client = new WebTorrent({
      dht: true,
      maxConns: opts.maxConns ?? 200,
      // -1 = unlimited (throttling disabled). Bytes per second otherwise.
      uploadLimit: opts.uploadLimitBytesPerSec ?? -1
    })
    // webtorrent re-emits torrent errors on the client when no torrent-level
    // listener exists; an unhandled 'error' event would crash the process.
    // Torrent-level failures are surfaced by StreamEngine — client-level ones
    // are non-fatal by design (webtorrent's own docs), so they are absorbed.
    this.client.on('error', () => {
      /* absorbed: torrent errors surface through StreamEngine */
    })
  }

  get destroyed$(): boolean {
    return this.destroyed
  }

  /** Gracefully destroy the client (used on app exit only, not per-stream). */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    await new Promise<void>(resolve => {
      try {
        this.client.destroy(() => resolve())
        setTimeout(resolve, 3000).unref?.()
      } catch {
        resolve()
      }
    })
  }
}
