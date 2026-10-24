import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyQuery, classifyTitle, voteKind } from '../src/utils/classify.js'

const kindOf = (title: string): string => classifyTitle(title).kind
const tag = (title: string) => classifyTitle(title)

describe('classifyTitle', () => {
  it('recognises movies from stacked release tags', () => {
    assert.equal(kindOf('Oppenheimer 2023 1080p BluRay x264-Galore'), 'movie')
    assert.equal(kindOf('Oppenheimer.2023.2160p.WEB-DL.DDP5.1.Atmos.HDR.H.265-NOSCREEN'), 'movie')
    assert.equal(kindOf('Oppenheimer (2023) 4K UHD REMUX'), 'movie')
    assert.equal(kindOf('Oppenheimer - 2023 1080p BluRay x264'), 'movie')
  })

  it('lets an explicit episode marker beat movie-looking words', () => {
    assert.equal(kindOf('Oppenheimer S01E04'), 'episode')
  })

  it('recognises episodes, ranges, packs and date episodes', () => {
    assert.equal(kindOf('The Bear S02E01 1080p WEB-DL'), 'episode')
    assert.equal(kindOf('Friends.S01E01-E03.720p'), 'episode')
    assert.equal(kindOf('Breaking Bad S05 Complete 720p'), 'season-pack')
    assert.equal(kindOf('The Daily Show 2023.10.12 720p WEB-DL'), 'episode')
    assert.equal(kindOf('[SubsPlease] Jujutsu Kaisen - 28 [1080p]'), 'episode')
  })

  it('stays unsure without corroborating signals', () => {
    const unknown = tag('Weird Movie 4K HDR')
    assert.equal(unknown.kind, 'unknown')
    assert.ok(unknown.confidence <= 0.3)
  })

  it('biases ambiguous absolute numbering toward episodes on nyaa', () => {
    const neutral = tag('Some Thing - 07 [720p]')
    const nyaa = classifyTitle('Some Thing - 07 [720p]', 'nyaa')
    assert.equal(neutral.kind, 'episode')
    assert.equal(nyaa.kind, 'episode')
    assert.ok(nyaa.confidence >= neutral.confidence)
  })

  it('never lets the nyaa prior override strong movie signals', () => {
    assert.equal(classifyTitle('Kono Movie 2023 1080p BluRay x264', 'nyaa').kind, 'movie')
  })
})

describe('classifyQuery', () => {
  it('only leans movie when the query carries a year', () => {
    assert.equal(classifyQuery('oppenheimer').kind, 'unknown')
    assert.equal(classifyQuery('the bear').kind, 'unknown')
    assert.equal(classifyQuery('oppenheimer 2023').kind, 'movie')
  })

  it('reads an explicit SxxExx query as an episode', () => {
    assert.equal(classifyQuery('breaking bad s02e05').kind, 'episode')
  })
})

describe('voteKind', () => {
  const movieRow = 'Oppenheimer 2023 1080p BluRay x264-Galore'
  const epRow = 'The Bear S02E01 1080p WEB-DL'

  it('routes a movie-majority set to the flat list', () => {
    const rows = [...Array.from({ length: 12 }, () => tag(movieRow)), tag(epRow)]
    assert.equal(voteKind(rows).kind, 'movie')
  })

  it('routes an episode-majority set to the series tiers', () => {
    const rows = Array.from({ length: 8 }, (_, i) => tag(`The Bear S02E0${(i % 8) + 1} 1080p`))
    assert.equal(voteKind(rows).kind, 'episode')
  })

  it('returns unknown on a tie or an uninformative set', () => {
    assert.equal(voteKind([tag(epRow), tag(epRow), tag(movieRow), tag(movieRow)]).kind, 'unknown')
    assert.equal(voteKind([tag('Weird Movie 4K HDR'), tag('Another Unknown 720p')]).kind, 'unknown')
    assert.equal(voteKind([]).kind, 'unknown')
  })
})
