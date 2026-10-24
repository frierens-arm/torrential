import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEpisodeRows,
  buildSeasonRows,
  buildSeriesIndex,
  episodeQueries,
  parseTvTitle,
  packsForSeason,
  scopeLabel,
  seasonQueries,
  seriesSummaries,
  showKey,
  toTvResult,
  torrentsForEpisode
} from '../src/utils/tv.js'
import type { SearchResult } from '../src/types.js'

function row(id: string, title: string, seeders = 10): SearchResult {
  const base: SearchResult = {
    id,
    provider: 'tpb',
    title,
    seeders,
    leechers: 0,
    sizeBytes: 1_000_000_000,
    quality: {}
  }
  return toTvResult(base)
}

describe('parseTvTitle', () => {
  it('parses SxxExx and cleans the show name', () => {
    const parsed = parseTvTitle('Breaking Bad S02E05 1080p BluRay x264')
    assert.equal(parsed.show, 'Breaking Bad')
    assert.deepEqual(parsed.scope, { kind: 'episode', season: 2, episode: 5 })
  })

  it('expands episode ranges', () => {
    const parsed = parseTvTitle('Mr. Robot - S04E01-E04 (720p)')
    assert.equal(parsed.scope?.kind, 'episode')
    assert.equal(parsed.scope?.kind === 'episode' ? parsed.scope.episodes?.length : 0, 4)
  })

  it('understands 1xx numbering', () => {
    const parsed = parseTvTitle('The Last of Us 108 2023 WEB-DL')
    assert.deepEqual(parsed.scope, { kind: 'episode', season: 1, episode: 8 })
  })

  it('understands fan 2x05 notation', () => {
    const parsed = parseTvTitle('CSI Vegas 2x05 HDTV')
    assert.deepEqual(parsed.scope, { kind: 'episode', season: 2, episode: 5 })
  })

  it('understands absolute anime numbering', () => {
    const parsed = parseTvTitle('[SubsPlease] Jujutsu Kaisen - 28 [1080p]')
    assert.equal(parsed.scope?.kind, 'episode')
    assert.equal(parsed.scope?.kind === 'episode' ? parsed.scope.episode : -1, 28)
    assert.equal(parsed.scope?.kind === 'episode' ? parsed.scope.season : 1, null)
  })

  it('understands absolute batch ranges', () => {
    const parsed = parseTvTitle('[Erai-raws] Frieren - 01-12 [Batch][1080p]')
    assert.equal(parsed.scope?.kind, 'episode')
    assert.equal(parsed.scope?.kind === 'episode' ? parsed.scope.episodes?.length : 0, 12)
  })

  it('parses "Season N" packs and 2nd-season anime', () => {
    const words = parseTvTitle('Better Call Saul Season 3 720p')
    assert.equal(words.scope?.kind, 'pack')
    assert.deepEqual(words.scope?.kind === 'pack' ? words.scope.seasons : [], [3])

    const anime = parseTvTitle('Kaiji 2nd Season - 07 [720p]')
    assert.deepEqual(anime.scope, { kind: 'episode', season: 2, episode: 7 })
  })

  it('parses complete-series packs', () => {
    const parsed = parseTvTitle('Friends Complete Series 1080p')
    assert.equal(parsed.scope?.kind, 'pack')
    assert.equal(parsed.scope?.kind === 'pack' ? parsed.scope.complete : false, true)
  })

  it('never reads a release year as an episode', () => {
    for (const title of [
      'Oppenheimer - 2023 1080p BluRay x264',
      'Oppenheimer - 2023 [1080p]',
      'Collection - 2023-2024 [BluRay]',
      'Blade Runner 2049 2160p',
      'Dune Part Two 2021 1080p BluRay x265'
    ]) {
      assert.equal(parseTvTitle(title).scope, null, title)
    }
  })

  it('labels scopes compactly', () => {
    assert.equal(scopeLabel({ kind: 'episode', season: 2, episode: 5 }), 'S02E05')
    assert.equal(scopeLabel({ kind: 'pack', seasons: [2] }), 'Season 2')
  })
})

describe('series index', () => {
  const rows = [
    row('a', 'Breaking Bad S01E01 720p', 100),
    row('b', 'Breaking Bad S01E02 720p', 90),
    row('c', 'Breaking Bad S01E03 720p', 80),
    row('d', 'Breaking.Bad.S02E01.1080p', 70),
    row('e', 'Breaking Bad Season 1 Complete 720p', 200),
    row('f', 'Frieren - 12 [1080p]', 300),
    row('g', 'Frieren - 13 [1080p]', 280)
  ]

  it('groups episodic rows and leaves movies out', () => {
    const index = buildSeriesIndex([...rows, row('m', 'Oppenheimer 2023 1080p BluRay x264')])
    assert.equal(seriesSummaries(index).length, 2)
    assert.ok(index.has(showKey('Breaking Bad')))
    assert.ok(!index.has(showKey('Oppenheimer')))
  })

  it('builds seasons, episode rows and pack lookups', () => {
    const index = buildSeriesIndex(rows)
    const bb = index.get(showKey('Breaking Bad'))
    assert.ok(bb)
    assert.equal(bb!.seasons.size, 2)
    assert.equal(buildSeasonRows(bb!).length, 2)

    const season1 = bb!.seasons.get(1)!
    const episodes = buildEpisodeRows(season1)
    assert.deepEqual(episodes.map(e => e.episode), [1, 2, 3])
    assert.equal(torrentsForEpisode(season1, 2)[0]?.seeders, 90)

    const packs = packsForSeason(bb!, { kind: 'season', season: 1 })
    assert.equal(packs.length, 1)
    assert.equal(packs[0]?.seeders, 200)
  })

  it('keeps absolute-numbered shows in the unsorted bucket', () => {
    const frieren = buildSeriesIndex(rows).get(showKey('Frieren'))
    assert.ok(frieren)
    assert.equal(frieren!.unsorted.episodes.size, 2)
  })

  it('tags generic rows instead of dropping them', () => {
    const movie = row('m', 'Sintel 2010 1080p')
    assert.equal(movie.scope, undefined)
    assert.equal(movie.show, undefined)
    assert.equal(movie.id, 'm')
  })
})

describe('smart query builders', () => {
  it('emits SxxExx and 1xx forms', () => {
    assert.deepEqual(episodeQueries('Breaking Bad', 2, 5), ['Breaking Bad S02E05', 'Breaking Bad 205'])
  })

  it('emits season pack forms', () => {
    assert.deepEqual(seasonQueries('Breaking Bad', 2), ['Breaking Bad S02', 'Breaking Bad season 2'])
  })

  it('emits absolute forms with no season', () => {
    const queries = episodeQueries('Frieren', null, 28)
    assert.equal(queries[0], 'Frieren - 28')
    assert.ok(queries.includes('Frieren 28'))
  })
})
