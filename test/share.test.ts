import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { TurboServer, remotePathAllowed } from '../src/engine/turbo-server.js'
import type { TurboFile, TurboTorrent } from '../src/engine/turbo-server.js'

const BODY = Buffer.from('0123456789abcdefghij')
const TOKEN = 'abcd2345'

function fakeFile(): TurboFile {
  return {
    name: 'episode.mkv',
    path: 'Show/episode.mkv',
    length: BODY.length,
    async *[Symbol.asyncIterator](opts?: { start?: number; end?: number }) {
      const start = Math.max(0, opts?.start ?? 0)
      const end = Math.min(BODY.length - 1, opts?.end ?? BODY.length - 1)
      yield BODY.subarray(start, end + 1)
    }
  }
}

function fakeTorrent(file: TurboFile): TurboTorrent {
  return {
    infoHash: 'a'.repeat(40),
    name: 'Show',
    pieceLength: 0,
    length: BODY.length,
    downloadSpeed: 0,
    numPeers: 0,
    pieces: [],
    files: [file],
    bitfield: null,
    select() {},
    deselect() {},
    critical() {}
  }
}

interface Fetched {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  port: number,
  pathname: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: init.method ?? 'GET', headers: init.headers },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('remotePathAllowed', () => {
  it('always allows the local machine', () => {
    assert.equal(remotePathAllowed('/', null, '127.0.0.1'), true)
    assert.equal(remotePathAllowed('/webtorrent/abc/file.mkv', null, '::1'), true)
  })

  it('refuses every route from the LAN while sharing is off', () => {
    assert.equal(remotePathAllowed('/', null, '192.168.1.50'), false)
    assert.equal(remotePathAllowed(`/p/${TOKEN}`, null, '192.168.1.50'), false)
  })

  it('opens only the tokenized page and its media route to the LAN', () => {
    assert.equal(remotePathAllowed(`/p/${TOKEN}`, TOKEN, '192.168.1.50'), true)
    assert.equal(remotePathAllowed(`/p/${TOKEN}/`, TOKEN, '192.168.1.50'), true)
    assert.equal(remotePathAllowed(`/p/${TOKEN}/media.mkv`, TOKEN, '::ffff:192.168.1.50'), true)
    assert.equal(remotePathAllowed('/', TOKEN, '192.168.1.50'), false)
    assert.equal(remotePathAllowed('/stream.mkv', TOKEN, '192.168.1.50'), false)
    assert.equal(remotePathAllowed(`/webtorrent/${'a'.repeat(40)}/file.mkv`, TOKEN, '192.168.1.50'), false)
    assert.equal(remotePathAllowed('/p/othertoken', TOKEN, '192.168.1.50'), false)
  })
})

describe('TurboServer phone share', () => {
  const file = fakeFile()
  const torrent = fakeTorrent(file)
  const server = new TurboServer({ port: 0 })
  let port = 0

  after(async () => {
    await server.close()
  })

  it('binds and starts with sharing off', async () => {
    port = await server.listen(0)
    assert.ok(port > 0)
    server.attach(torrent, file)
    assert.equal(server.sharePageUrl, null)
    const res = await request(port, `/p/${TOKEN}`)
    assert.equal(res.status, 404)
  })

  it('serves a mobile page that streams the attached file', async () => {
    const url = server.enableSharing('127.0.0.1', TOKEN)
    assert.equal(url, `http://127.0.0.1:${port}/p/${TOKEN}`)

    const res = await request(port, `/p/${TOKEN}`)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'] ?? '', /text\/html/)
    assert.match(res.body, new RegExp(`/p/${TOKEN}/media\\.mkv`))
    assert.match(res.body, /playsinline/)
    assert.match(res.body, /vlc-x-callback:\/\//)
    assert.match(res.body, /Nothing is saved on this phone/)
    // Streaming only: the page must never offer the media as a download.
    assert.equal(res.headers['content-disposition'], undefined)
    assert.doesNotMatch(res.body, /download/)
  })

  it('honours Range requests on the tokenized media route', async () => {
    const res = await request(port, `/p/${TOKEN}/media.mkv`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers['content-range'], `bytes 0-3/${BODY.length}`)
    assert.equal(res.body, '0123')
  })

  it('does not count a loopback reader as a phone', () => {
    // Connection records are created per served request; the ones above came
    // from 127.0.0.1, so the "phone connected" counter must stay at zero.
    assert.equal(server.getSnapshot().remoteConnections, 0)
  })

  it('answers HEAD without a body', async () => {
    const res = await request(port, `/p/${TOKEN}`, { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(res.body, '')
  })

  it('404s an unknown token and any non-share route', async () => {
    assert.equal((await request(port, '/p/nosuchtoken')).status, 404)
    assert.equal((await request(port, '/')).status, 200) // local listing still works
    assert.equal((await request(port, `/p/${TOKEN}/secret.txt`)).status, 404)
  })

  it('revokes the page when sharing is disabled', async () => {
    server.disableSharing()
    assert.equal(server.sharePageUrl, null)
    assert.equal((await request(port, `/p/${TOKEN}`)).status, 404)
  })
})
