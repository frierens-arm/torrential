import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { qrWidth, renderQr } from '../src/utils/qr.js'

const URL = 'http://192.168.1.42:8000/p/abcd2345'

describe('renderQr', () => {
  it('renders a half-block matrix that fits a standard terminal', () => {
    const lines = renderQr(URL)
    assert.ok(lines.length > 8, `only ${lines.length} rows`)
    assert.ok(lines.length < 24, `${lines.length} rows will not fit an 80x24 terminal`)
    assert.ok(qrWidth(lines) <= 45, `QR is ${qrWidth(lines)} columns wide`)
    for (const line of lines) {
      assert.match(line, /^[▀▄█ ]*$/u)
      assert.equal(line.length, qrWidth(lines), 'every row must be the same width')
    }
  })

  it('uses no ANSI escapes (Ink measures the raw strings)', () => {
    const lines = renderQr(URL)
    for (const line of lines) assert.doesNotMatch(line, /\u001b\[/)
  })

  it('is memoized per payload', () => {
    assert.equal(renderQr(URL), renderQr(URL))
    assert.notEqual(renderQr(URL), renderQr(`${URL}-other`))
  })

  it('grows the matrix for longer payloads', () => {
    const short = renderQr(URL)
    const long = renderQr(`http://192.168.100.200:65535/p/abcd2345/${'x'.repeat(120)}`)
    assert.ok(qrWidth(long) > qrWidth(short))
  })
})
