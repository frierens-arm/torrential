import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLAYHEAD_HOT_MS, PLAYHEAD_IDLE_MS, parseRangeHeader, selectPlayhead } from '../src/engine/turbo-server.js'

const SIZE = 1000

describe('parseRangeHeader', () => {
  it('ignores a missing or non-bytes unit header', () => {
    assert.equal(parseRangeHeader(undefined, SIZE), null)
    assert.equal(parseRangeHeader('', SIZE), null)
    assert.equal(parseRangeHeader('items=0-10', SIZE), null)
    assert.equal(parseRangeHeader('bytes=0-10', 0), null)
  })

  it('parses closed, open-ended and suffix ranges', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-99', SIZE), { start: 0, end: 99 })
    assert.deepEqual(parseRangeHeader('bytes=500-', SIZE), { start: 500, end: 999 })
    assert.deepEqual(parseRangeHeader('bytes=-250', SIZE), { start: 750, end: 999 })
  })

  it('clamps an end past EOF instead of failing', () => {
    assert.deepEqual(parseRangeHeader('bytes=900-5000', SIZE), { start: 900, end: 999 })
  })

  it('clamps a suffix longer than the file to the whole file', () => {
    assert.deepEqual(parseRangeHeader('bytes=-5000', SIZE), { start: 0, end: 999 })
  })

  it('reports unsatisfiable ranges', () => {
    assert.equal(parseRangeHeader('bytes=1000-', SIZE), 'unsatisfiable')
    assert.equal(parseRangeHeader('bytes=5000-6000', SIZE), 'unsatisfiable')
    assert.equal(parseRangeHeader('bytes=-0', SIZE), 'unsatisfiable')
  })

  it('marks malformed ranges invalid (caller falls back to 200)', () => {
    assert.equal(parseRangeHeader('bytes=abc-def', SIZE), 'invalid')
    assert.equal(parseRangeHeader('bytes=-', SIZE), 'invalid')
    assert.equal(parseRangeHeader('bytes=300-200', SIZE), 'invalid')
  })

  it('serves the first range of a multi-range request', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-9, 50-59', SIZE), { start: 0, end: 9 })
  })

  it('416s a multi-range request whose leading part is past EOF', () => {
    // Documented quirk: the parser stops at the first unsatisfiable part
    // rather than hunting for a later satisfiable one. Clients that send
    // sorted ranges (every media player) never hit this path.
    assert.equal(parseRangeHeader('bytes=5000-5001, 20-29', SIZE), 'unsatisfiable')
  })
})

describe('selectPlayhead', () => {
  const now = 1_000_000

  it('follows the minimum position of actively reading connections', () => {
    const playhead = selectPlayhead(
      [
        { position: 40_000, lastActivity: now - 100, open: true },
        { position: 500_000, lastActivity: now - 100, open: true }
      ],
      now
    )
    assert.equal(playhead, 40_000)
  })

  it('does not let a paused connection hold the window back', () => {
    const playhead = selectPlayhead(
      [
        // paused a minute ago: beyond the hot window, inside the idle window
        { position: 1_000, lastActivity: now - PLAYHEAD_HOT_MS - 1, open: true },
        { position: 800_000, lastActivity: now - 50, open: true }
      ],
      now
    )
    assert.equal(playhead, 800_000)
  })

  it('falls back to recently idle readers when nothing is hot', () => {
    const playhead = selectPlayhead(
      [
        { position: 250_000, lastActivity: now - PLAYHEAD_IDLE_MS + 1, open: true },
        { position: 900_000, lastActivity: now - PLAYHEAD_IDLE_MS + 1, open: true }
      ],
      now
    )
    assert.equal(playhead, 250_000)
  })

  it('ignores closed and fully idle connections', () => {
    assert.equal(
      selectPlayhead(
        [
          { position: 0, lastActivity: now - 100, open: false },
          { position: 10, lastActivity: now - PLAYHEAD_IDLE_MS - 1, open: true }
        ],
        now
      ),
      null
    )
  })

  it('treats an EOF index probe and the real reader correctly', () => {
    // VLC opens a second connection at EOF to read the index; the minimum
    // keeps the window near the playhead instead of jumping to the file end.
    const playhead = selectPlayhead(
      [
        { position: 120_000_000, lastActivity: now - 10, open: true },
        { position: 900_000, lastActivity: now - 10, open: true }
      ],
      now
    )
    assert.equal(playhead, 900_000)
  })
})
