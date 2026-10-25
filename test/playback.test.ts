import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planPlaybackReturn } from '../src/utils/playback.js'

const LAST = { seriesKey: 'breaking bad', season: 1, episode: 3 }

describe('planPlaybackReturn', () => {
  it('returns a finished episode to the episode grid on the next one', () => {
    const plan = planPlaybackReturn({
      finished: true,
      last: LAST,
      seriesKey: 'breaking bad',
      episodes: [1, 2, 3, 4, 5],
      gridSeason: 1
    })
    assert.equal(plan.toEpisodes, true)
    assert.equal(plan.next, 4)
    assert.equal(plan.cursorEpisode, 4)
    assert.equal(plan.note, 'finished E03 — next up E04 · ⏎ to play')
  })

  it('keeps the cursor on the finished episode when the season ends', () => {
    const plan = planPlaybackReturn({
      finished: true,
      last: LAST,
      seriesKey: 'breaking bad',
      episodes: [1, 2, 3],
      gridSeason: 1
    })
    assert.equal(plan.toEpisodes, true)
    assert.equal(plan.next, null)
    assert.equal(plan.cursorEpisode, 3)
    assert.match(plan.note ?? '', /last episode here/)
  })

  it('handles season-less (absolute numbering) shows', () => {
    const plan = planPlaybackReturn({
      finished: true,
      last: { seriesKey: 'frieren', season: null, episode: 7 },
      seriesKey: 'frieren',
      episodes: [6, 7, 8],
      gridSeason: null
    })
    assert.equal(plan.toEpisodes, true)
    assert.equal(plan.cursorEpisode, 8)
  })

  it('stays on the pre-flight card when playback was abandoned early', () => {
    const plan = planPlaybackReturn({
      finished: false,
      last: LAST,
      seriesKey: 'breaking bad',
      episodes: [1, 2, 3, 4],
      gridSeason: 1
    })
    assert.equal(plan.toEpisodes, false)
    assert.equal(plan.note, null)
  })

  it('stays put for movies, magnets and pack streams', () => {
    assert.equal(
      planPlaybackReturn({
        finished: true,
        last: null,
        seriesKey: 'breaking bad',
        episodes: [1, 2],
        gridSeason: 1
      }).toEpisodes,
      false
    )
  })

  it('refuses to jump grids when the open season or series does not match', () => {
    const base = {
      finished: true,
      last: LAST,
      seriesKey: 'breaking bad',
      episodes: [1, 2, 3, 4]
    }
    assert.equal(planPlaybackReturn({ ...base, gridSeason: 2 }).toEpisodes, false)
    assert.equal(planPlaybackReturn({ ...base, gridSeason: undefined }).toEpisodes, false)
    assert.equal(
      planPlaybackReturn({ ...base, seriesKey: 'severance', gridSeason: 1 }).toEpisodes,
      false
    )
    assert.equal(planPlaybackReturn({ ...base, episodes: null, gridSeason: 1 }).toEpisodes, false)
  })
})
