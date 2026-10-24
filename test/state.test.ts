import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EMPTY_STATE,
  HISTORY_LIMIT,
  lastWatchedFor,
  loadState,
  normalizeState,
  pushHistory,
  recordWatched,
  saveState
} from '../src/utils/state.js'

describe('normalizeState', () => {
  it('degrades garbage to an empty state', () => {
    for (const raw of [null, undefined, 42, 'nope', [], { history: 'x', watched: 5 }]) {
      assert.deepEqual(normalizeState(raw), EMPTY_STATE)
    }
  })

  it('keeps valid entries, dedupes and caps history', () => {
    const raw = {
      history: ['a', 'a', 'b', ' ', 7],
      watched: {
        bb: { season: 2, episode: 5, at: '2026-01-01T00:00:00.000Z' },
        anime: { season: null, episode: 28, at: '2026-01-02T00:00:00.000Z' },
        broken: { season: 'two', episode: 1, at: 'x' }
      }
    }
    const state = normalizeState(raw)
    assert.deepEqual(state.history, ['a', 'b'])
    assert.equal(state.watched.bb?.season, 2)
    assert.equal(state.watched.anime?.season, null)
    assert.ok(!('broken' in state.watched))
  })
})

describe('pushHistory', () => {
  it('puts the newest query first and dedupes', () => {
    let state = pushHistory(EMPTY_STATE, 'the bear')
    state = pushHistory(state, 'severance')
    state = pushHistory(state, 'the bear')
    assert.deepEqual(state.history, ['the bear', 'severance'])
  })

  it('ignores blank queries', () => {
    assert.equal(pushHistory(EMPTY_STATE, '   '), EMPTY_STATE)
  })

  it('caps the list and keeps the newest entries', () => {
    let state = EMPTY_STATE
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) state = pushHistory(state, `query ${i}`)
    assert.equal(state.history.length, HISTORY_LIMIT)
    assert.equal(state.history[0], `query ${HISTORY_LIMIT + 4}`)
  })
})

describe('recordWatched', () => {
  it('stores and overwrites a series entry', () => {
    const at = new Date('2026-10-24T12:00:00.000Z')
    let state = recordWatched(EMPTY_STATE, 'breaking bad', { season: 2, episode: 5 }, at)
    state = recordWatched(state, 'breaking bad', { season: 2, episode: 6 }, at)
    const entry = lastWatchedFor(state, 'breaking bad')
    assert.equal(entry?.episode, 6)
    assert.equal(entry?.season, 2)
    assert.equal(entry?.at, at.toISOString())
    assert.equal(lastWatchedFor(state, 'unknown'), null)
  })

  it('ignores empty keys and accepts absolute numbering', () => {
    assert.equal(recordWatched(EMPTY_STATE, '  ', { season: null, episode: 1 }), EMPTY_STATE)
    const state = recordWatched(EMPTY_STATE, 'frieren', { season: null, episode: 28 })
    assert.equal(lastWatchedFor(state, 'frieren')?.season, null)
  })

  it('caps the ledger at 200 series', () => {
    let state = EMPTY_STATE
    for (let i = 0; i < 205; i++) {
      state = recordWatched(state, `show ${i}`, { season: 1, episode: 1 }, new Date(2026, 0, 1, 0, 0, i))
    }
    assert.equal(Object.keys(state.watched).length, 200)
  })
})

describe('disk round-trip', () => {
  it('saves, reloads and leaves no temp file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-state-'))
    const file = path.join(dir, 'state.json')
    const state = pushHistory(recordWatched(EMPTY_STATE, 'bb', { season: 1, episode: 2 }), 'breaking bad')
    assert.equal(saveState(state, file), true)

    const loaded = loadState(file)
    assert.deepEqual(loaded.history, ['breaking bad'])
    assert.equal(loaded.watched.bb?.episode, 2)
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
  })

  it('returns an empty state for a missing or corrupt file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-state-'))
    const missing = path.join(dir, 'missing.json')
    assert.deepEqual(loadState(missing), EMPTY_STATE)

    const corrupt = path.join(dir, 'corrupt.json')
    fs.writeFileSync(corrupt, 'not json')
    assert.deepEqual(loadState(corrupt), EMPTY_STATE)
  })

  it('reports a failed write instead of throwing', () => {
    // A directory where the file should be makes the write fail reliably.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-state-'))
    const file = path.join(dir, 'state.json')
    fs.mkdirSync(file)
    assert.equal(saveState(EMPTY_STATE, file), false)
  })
})
