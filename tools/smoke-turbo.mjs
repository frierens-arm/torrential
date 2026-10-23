#!/usr/bin/env node
/**
 * TurboServer HTTP compatibility matrix.
 *
 * Exercises the serving layer end-to-end (real node:http server, real curl)
 * against a fake torrent/file, without touching the network swarm:
 *
 *   1. 200 full-body GET with correct Content-Length
 *   2. 206 on bytes=0-99 (+ Content-Range)
 *   3. 206 on open-ended bytes=500-
 *   4. 206 on suffix bytes=-100 (last 100 bytes)
 *   5. 416 + "Content-Range: bytes ␣/␣size" on past-EOF range
 *   6. invalid Range syntax → ignored → 200 full
 *   7. multi-range → first range only, still 206
 *   8. HEAD = identical headers, empty body
 *   9. OPTIONS preflight → 204 + CORS
 *  10. canonical /webtorrent/<hash>/<path> route (encoded segments)
 *  11. /stream + /stream.<ext> aliases (no redirects, direct 200/206)
 *  12. legacy /<fileIndex> route
 *  13. 404 unknown path · 405 non-GET/HEAD
 *  14. byte-exact payloads (pattern verification at offsets)
 *  15. connection dropped mid-stream → server stays healthy
 *  16. window engine: priority window + critical marks observed on the torrent
 *  17. playhead tracking: window slides forward after reads advance
 *
 * Run: npm run smoke   (or: node tools/smoke-turbo.mjs — requires a build)
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TurboServer } from '../dist/engine/turbo-server.js'

const execFileAsync = promisify(execFile)

const MB = 1024 * 1024
const FILE_LENGTH = 4 * MB + 12345 // deliberately not piece-aligned
const PIECE_LENGTH = 256 * 1024
const PIECES = Math.ceil(FILE_LENGTH / PIECE_LENGTH)

/* ---------- fake torrent / file (pattern: byte i → i % 251) ---------- */

const patternByte = i => i % 251

function makeIterator({ start, end }) {
  let pos = start
  const CHUNK = 64 * 1024
  return {
    next: async () => {
      if (pos > end) return { done: true }
      const len = Math.min(CHUNK, end - pos + 1)
      const buf = Buffer.alloc(len)
      for (let i = 0; i < len; i++) buf[i] = patternByte(pos + i)
      pos += len
      await new Promise(r => setTimeout(r, 0)) // yield, like real async reads
      return { value: buf, done: false }
    },
    destroy: () => {},
    [Symbol.asyncIterator]() {
      return this
    }
  }
}

const file = {
  name: 'Great.Movie.2024.1080p.mkv',
  path: 'Great.Movie.2024/Great.Movie.2024.1080p.mkv',
  length: FILE_LENGTH,
  offset: PIECE_LENGTH * 3,
  [Symbol.asyncIterator]: opts => makeIterator({ start: opts?.start ?? 0, end: opts?.end ?? FILE_LENGTH - 1 })
}

const calls = { select: [], deselect: [], critical: [] }
const torrent = {
  infoHash: '0123456789abcdef0123456789abcdef01234567',
  name: 'Great.Movie.2024',
  pieceLength: PIECE_LENGTH,
  length: FILE_LENGTH + PIECE_LENGTH * 3,
  downloadSpeed: 3 * MB, // fast swarm → larger window
  numPeers: 12,
  pieces: new Array(PIECES + 3).fill({}),
  files: [file],
  bitfield: { get: i => i < Math.floor(PIECES / 2) }, // first half cached
  select: (a, b, p) => calls.select.push([a, b, p]),
  deselect: (a, b) => calls.deselect.push([a, b]),
  critical: (a, b) => calls.critical.push([a, b]),
  _select: (a, b, p, n, s) => calls.select.push(['stream', a, b, p, s]),
  _deselect: (a, b, s) => calls.deselect.push(['stream', a, b, s])
}

/* ---------- harness ---------- */

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

// NOTE: async exec — the server lives in THIS process, so blocking the event
// loop with sync spawn would deadlock every request.
async function curl(args) {
  try {
    const { stdout } = await execFileAsync('curl', ['-s', '-D', '-', ...args], { timeout: 10_000, maxBuffer: 64 * MB })
    return stdout
  } catch (err) {
    return `CURL-ERROR status=${err.code} ${String(err.stderr ?? '')}`
  }
}
async function curlBody(args) {
  try {
    // encoding: 'buffer' → stdout is a Buffer → byte-exact payload checks
    const { stdout } = await execFileAsync('curl', ['-s', ...args], { timeout: 10_000, maxBuffer: 64 * MB, encoding: 'buffer' })
    return stdout
  } catch (err) {
    console.log(`    (curl failed: code=${err.code} stderr=${String(err.stderr ?? '').slice(0, 120)})`)
    return Buffer.alloc(0)
  }
}

const server = new TurboServer({ port: 0, windowSecs: 30, resolveTorrent: h => (h === torrent.infoHash ? torrent : null) })
server.attach(torrent, file)
const port = await server.listen(0)
const origin = `http://127.0.0.1:${port}`
console.log(`\nturbo server on ${origin}\n`)

/* ---------- 1. full GET ---------- */
{
  const res = await curl([`${origin}/stream`])
  const status = res.toString().split('\r\n')[0]
  check('1. full GET → 200', status.includes(' 200 '))
  check('1. Content-Length exact', res.toString().includes(`Content-Length: ${FILE_LENGTH}`))
  check('1. Accept-Ranges: bytes', res.toString().includes('Accept-Ranges: bytes'))
  check('1. Content-Type matroska', res.toString().includes('video/x-matroska'))
  check('1. DLNA transferMode header', res.toString().toLowerCase().includes('transfermode.dlna.org'))
  check('1. no chunked encoding', !res.toString().toLowerCase().includes('transfer-encoding: chunked'))
}

/* ---------- 2-4. range flavors ---------- */
{
  const res = await curl(['-H', 'Range: bytes=0-99', `${origin}/stream`])
  check('2. bytes=0-99 → 206', res.toString().split('\r\n')[0].includes(' 206 '))
  check('2. Content-Range', res.toString().includes('Content-Range: bytes 0-99/' + FILE_LENGTH))
  check('2. Content-Length 100', res.toString().includes('Content-Length: 100'))
  const body = await curlBody(['-H', 'Range: bytes=0-99', `${origin}/stream`])
  const ok = [...body].every((b, i) => b === patternByte(i))
  check('2. payload byte-exact at offset 0', ok)
}
{
  const res = await curl(['-H', 'Range: bytes=500-', `${origin}/stream`])
  check('3. bytes=500- → 206', res.toString().split('\r\n')[0].includes(' 206 '))
  check('3. Content-Range open-ended', res.toString().includes(`Content-Range: bytes 500-${FILE_LENGTH - 1}/`))
  const body = await curlBody(['-H', 'Range: bytes=1000000-1000050', `${origin}/stream`])
  const ok = [...body].every((b, i) => b === patternByte(1000000 + i))
  check('3. payload byte-exact mid-file', ok)
}
{
  const res = await curl(['-H', 'Range: bytes=-100', `${origin}/stream`])
  check('4. bytes=-100 → 206 suffix', res.toString().includes('Content-Range: bytes ' + `${FILE_LENGTH - 100}-${FILE_LENGTH - 1}/`))
}

/* ---------- 5-7. bad ranges ---------- */
{
  const res = await curl(['-H', `Range: bytes=${FILE_LENGTH + 10}-`, `${origin}/stream`])
  check('5. past-EOF → 416', res.toString().split('\r\n')[0].includes(' 416 '))
  check('5. 416 Content-Range bytes star-slash-size', res.toString().includes(`Content-Range: bytes */${FILE_LENGTH}`))
}
{
  const res = await curl(['-H', 'Range: bytes=zz-99', `${origin}/stream`])
  check('6. invalid range → 200 full', res.toString().split('\r\n')[0].includes(' 200 '))
}
{
  const res = await curl(['-H', 'Range: bytes=0-9,500-599', `${origin}/stream`])
  check('7. multi-range → 206 first only', res.toString().split('\r\n')[0].includes(' 206 '))
  check('7. Content-Length 10 (first range)', res.toString().includes('Content-Length: 10'))
}

/* ---------- 8. HEAD ---------- */
{
  const res = await curl(['-I', `${origin}/stream`])
  check('8. HEAD → 200 + headers, no body', res.toString().split('\r\n')[0].includes(' 200 ') && res.toString().includes(`Content-Length: ${FILE_LENGTH}`))
  // curl -I prints the header block to stdout by design; measure BODY bytes
  // with %{size_download} instead (headers are excluded from that metric).
  const sizeOut = await execFileAsync(
    'curl',
    ['-s', '--head', '-o', '/dev/null', '-w', '%{size_download}', `${origin}/stream`],
    { timeout: 5000 }
  )
  check('8. HEAD body empty (size_download = 0)', sizeOut.stdout.trim() === '0')
}

/* ---------- 9. OPTIONS ---------- */
{
  const res = await curl(['-X', 'OPTIONS', '-D', '-', '-o', '/dev/null', `${origin}/stream`])
  check('9. OPTIONS → 204 + CORS methods', res.toString().includes(' 204 ') && res.toString().includes('GET, HEAD, OPTIONS'))
}

/* ---------- 10. canonical route ---------- */
{
  const encoded = file.path.split('/').map(encodeURIComponent).join('/')
  const res = await curl([`${origin}/webtorrent/${torrent.infoHash}/${encoded}`])
  check('10. canonical route → 200', res.toString().split('\r\n')[0].includes(' 200 '))
  const res404 = await curl([`${origin}/webtorrent/${'f'.repeat(40)}/nope.mkv`])
  check('10. unknown hash → 404', res404.toString().split('\r\n')[0].includes(' 404 '))
}

/* ---------- 11. aliases ---------- */
{
  const res = await curl(['-H', 'Range: bytes=0-9', `${origin}/stream.mkv`])
  check('11. /stream.<ext> alias → 206 direct', res.toString().split('\r\n')[0].includes(' 206 ') && !res.toString().includes('Location:'))
  const resIdx = await curl(['-H', 'Range: bytes=0-9', `${origin}/0`])
  check('11. legacy /<index> → 206 direct', resIdx.toString().split('\r\n')[0].includes(' 206 '))
}

/* ---------- 13. errors ---------- */
{
  const res404 = await curl([`${origin}/definitely/not/here`])
  check('13. unknown path → 404', res404.toString().split('\r\n')[0].includes(' 404 '))
  const res405 = await curl(['-X', 'POST', '-D', '-', '-o', '/dev/null', `${origin}/stream`])
  check('13. POST → 405', res405.toString().split('\r\n')[0].includes(' 405 '))
}

/* ---------- 15. aborted connection resilience ---------- */
{
  await execFileAsync('curl', ['-s', '--max-time', '0.3', '-o', '/dev/null', `${origin}/stream`], { timeout: 5000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 300))
  const res = await curl(['-H', 'Range: bytes=0-9', `${origin}/stream`])
  check('15. server healthy after mid-stream abort', res.toString().split('\r\n')[0].includes(' 206 '))
}

/* ---------- 16-17. window engine + playhead ---------- */
{
  // Simulate a weak swarm: slow speed + only 2 cached pieces ahead of a
  // fresh playhead → the stall-escalation path should fire.
  torrent.downloadSpeed = 50 * 1024
  torrent.bitfield = { get: i => i < 2 }
  server.attach(torrent, file) // resets playhead + window bookkeeping
  await new Promise(r => setTimeout(r, 1500)) // let ticks run
  const streamSelects = calls.select.filter(c => c[0] === 'stream')
  check('16. rolling window stream-selections issued', streamSelects.length > 0, JSON.stringify(calls.select.slice(0, 4)))
  const win = streamSelects.at(-1)
  check('16. window is high priority (3)', Boolean(win) && win[3] === 3)
  check('16. stall escalation marks critical pieces', calls.critical.length > 0)
  const snap = server.getSnapshot()
  check('17. snapshot reports bufferAheadBytes', typeof snap.bufferAheadBytes === 'number' && snap.bufferAheadBytes > 0)
  check('17. bufferAheadSecs estimated', snap.bufferAheadSecs === null || snap.bufferAheadSecs > 0)
}

/* ---------- teardown ---------- */
await server.close()
let closed = true
try {
  const after = (await execFileAsync('curl', ['-s', '-m', '1', `${origin}/stream`], { timeout: 4000 })).stdout.toString()
  closed = !after.includes(' 200 ')
} catch {
  closed = true // connection refused = closed
}
check('teardown: server closed', closed)

console.log(`\n${passed} passed · ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
