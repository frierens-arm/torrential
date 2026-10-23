#!/usr/bin/env node
/**
 * tv-smoke — offline assertions for the episodic pipeline:
 *   parseTvTitle · toTvResult · buildSeriesIndex · buildSeasonRows ·
 *   buildEpisodeRows · episodeQueries/seasonQueries · describeFiles ·
 *   pickEpisodeFile · x1337MirrorUrls (TV category path)
 *
 * Run: node tools/tv-smoke.mjs   (after `npm run build`)
 */
import {
  parseTvTitle,
  toTvResult,
  buildSeriesIndex,
  seriesSummaries,
  buildSeasonRows,
  buildEpisodeRows,
  packsForSeason,
  torrentsForEpisode,
  episodeQueries,
  seasonQueries,
  scopeLabel,
  showKey
} from '../dist/utils/tv.js'
import { describeFiles, pickEpisodeFile } from '../dist/engine/stream.js'
import { x1337MirrorUrls } from '../dist/providers/x1337.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

/* ── 1. parseTvTitle ─────────────────────────────────────────────── */
console.log('parseTvTitle')
{
  const p1 = parseTvTitle('Breaking Bad S02E05 1080p BluRay x264')
  ok('SxxExx: show', p1.show === 'Breaking Bad', p1.show)
  ok('SxxExx: scope', p1.scope?.kind === 'episode' && p1.scope.season === 2 && p1.scope.episode === 5)

  const p2 = parseTvTitle('Mr. Robot - S04E01-E04 (720p)')
  ok('range: episodes list', p2.scope?.kind === 'episode' && p2.scope.episodes?.length === 4, JSON.stringify(p2.scope))

  const p3 = parseTvTitle('The Last of Us 108 2023 WEB-DL')
  ok('1xx: season 1 ep 8', p3.scope?.kind === 'episode' && p3.scope.season === 1 && p3.scope.episode === 8)

  const p4 = parseTvTitle('Show Name 2023 S01 COMPLETE 720p')
  ok('year does not eat 1xx', p4.scope !== null && p4.scope.kind === 'pack', JSON.stringify(p4.scope))

  const p5 = parseTvTitle('CSI Vegas 2x05 HDTV')
  ok('2x05 fan notation', p5.scope?.kind === 'episode' && p5.scope.season === 2 && p5.scope.episode === 5)

  const p6 = parseTvTitle('Frieren - Beyond Journey.s End - 28 [1080p][SubsPlease]')
  ok('absolute episode 28', p6.scope?.kind === 'episode' && p6.scope.episode === 28, JSON.stringify(p6.scope))

  const p7 = parseTvTitle('[Erai-raws] Frieren - 01-12 [Batch][1080p]')
  ok('absolute batch range', p7.scope?.kind === 'episode' && p7.scope.episodes?.length === 12, JSON.stringify(p7.scope))

  const p8 = parseTvTitle('Better Call Saul Season 3 720p')
  ok('season pack words', p8.scope?.kind === 'pack' && p8.scope.seasons[0] === 3)

  const p9 = parseTvTitle('Friends Complete Series 1080p')
  ok('complete series', p9.scope?.kind === 'pack' && p9.scope.complete === true)

  const p10 = parseTvTitle('Dune Part Two 2021 1080p BluRay x265')
  ok('movie → no scope', p10.scope === null)

  const p11 = parseTvTitle('Kaiji 2nd Season - 07 [720p]')
  ok('anime 2nd season + ep', p11.scope?.kind === 'episode' && p11.scope.season === 2 && p11.scope.episode === 7, JSON.stringify(p11.scope))

  const p12 = parseTvTitle('Ted Lasso S03 1080p ATVP WEB-DL')
  ok('bare S03 pack', p12.scope?.kind === 'pack' && p12.scope.seasons[0] === 3)

  ok('scopeLabel episode', scopeLabel({ kind: 'episode', season: 2, episode: 5 }) === 'S02E05')
  ok('scopeLabel season', scopeLabel({ kind: 'pack', seasons: [2] }) === 'Season 2')
}

/* ── 2. toTvResult row tagging (generic rows survive) ────────────── */
console.log('toTvResult')
{
  const row = { id: 'x', provider: 'tpb', title: 'Breaking Bad S01E01 720p', seeders: 40, leechers: 2, sizeBytes: 1, quality: {} }
  const movie = { id: 'y', provider: 'tpb', title: 'Sintel 2010 1080p', seeders: 90, leechers: 2, sizeBytes: 1, quality: {} }
  const tv = toTvResult(row)
  const generic = toTvResult(movie)
  ok('TV row shaped', tv !== null && tv.show === 'Breaking Bad' && tv.scopeLabel === 'S01E01')
  ok('movie row survives (scope undefined)', generic !== null && generic.scope === undefined && generic.show === undefined)
  ok('generic row keeps its own fields', generic !== null && generic.id === 'y' && generic.title === 'Sintel 2010 1080p' && generic.seeders === 90)
}

/* ── 3. index + rows ─────────────────────────────────────────────── */
console.log('series index')
{
  const mk = (id, title, seeders) => ({ id, provider: 'tpb', title, seeders, leechers: 0, sizeBytes: 1e9, quality: {}, ...(toTvResult({ id, provider: 'tpb', title, seeders, leechers: 0, sizeBytes: 1e9, quality: {} }) ?? {}) })
  const rows = [
    mk('a', 'Breaking Bad S01E01 720p', 100),
    mk('b', 'Breaking Bad S01E02 720p', 90),
    mk('c', 'Breaking Bad S01E03 720p', 80),
    mk('d', 'Breaking.Bad.S02E01.1080p', 70),
    mk('e', 'Breaking Bad Season 1 Complete 720p', 200),
    mk('f', 'Frieren - 12 [1080p]', 300),
    mk('g', 'Frieren - 13 [1080p]', 280)
  ]
  const index = buildSeriesIndex(rows)
  const summaries = seriesSummaries(index)
  ok('two series grouped', summaries.length === 2, JSON.stringify(summaries.map(s => s.show)))
  const bb = index.get(showKey('Breaking Bad'))
  ok('BB seasons found', bb !== undefined && bb.seasons.size === 2)
  const s1 = bb.seasons.get(1)
  ok('BB S1 episodes', s1 !== undefined && s1.episodes.size === 3)
  ok('BB S1 pack present', s1.packs.length === 1)
  const seasonRows = buildSeasonRows(bb)
  ok('season rows built', seasonRows.length === 2 && seasonRows[0].label === 'Season 1')
  const epRows = buildEpisodeRows(s1)
  ok('episode rows 1..3', epRows.length === 3 && epRows[0].episode === 1)
  const eps = torrentsForEpisode(s1, 2)
  ok('episode 2 torrents', eps.length === 1 && eps[0].seeders === 90)
  const packs = packsForSeason(bb, { kind: 'season', season: 1 })
  ok('packs for S1', packs.length === 1 && packs[0].seeders === 200)
  const frieren = index.get(showKey('Frieren'))
  ok('frieren unsorted bucket', frieren !== undefined && frieren.unsorted.episodes.size === 2)
}

/* ── 4. query generation ─────────────────────────────────────────── */
console.log('smart queries')
{
  const q = episodeQueries('Breaking Bad', 2, 5)
  ok('episode queries', q[0] === 'Breaking Bad S02E05' && q[1] === 'Breaking Bad 205', JSON.stringify(q))
  const sq = seasonQueries('Breaking Bad', 2)
  ok('season queries', sq[0] === 'Breaking Bad S02' && sq[1] === 'Breaking Bad season 2', JSON.stringify(sq))
  const aq = episodeQueries('Frieren', null, 28)
  ok('absolute queries', aq[0] === 'Frieren - 28', JSON.stringify(aq))
}

/* ── 5. engine file matching ─────────────────────────────────────── */
console.log('engine file matching')
{
  const files = [
    { name: 'Show S02E01.mkv', path: 'pack/Show S02E01.mkv', length: 2e9 },
    { name: 'Show S02E02.mkv', path: 'pack/Show S02E02.mkv', length: 2e9 },
    { name: 'Show S02E03.mkv', path: 'pack/Show S02E03.mkv', length: 2e9 },
    { name: 'poster.jpg', path: 'pack/poster.jpg', length: 200_000 },
    { name: 'sample.mkv', path: 'pack/sample.mkv', length: 5e6 }
  ]
  const infos = describeFiles(files)
  ok('five files described', infos.length === 5)
  ok('video detection', infos.filter(i => i.isVideo).length === 4)
  ok('file scope parsed', infos[1].scopeLabel === 'S02E02')
  const hit = pickEpisodeFile(infos, 2, 3)
  ok('episode 3 matched', hit !== null && hit.name === 'Show S02E03.mkv')
  const miss = pickEpisodeFile(infos, 2, 9)
  ok('episode 9 → picker', miss === null)
  const anime = [
    { name: '[Group] Show - 05 [1080p].mkv', path: 'x', length: 1e9 },
    { name: '[Group] Show - 06 [1080p].mkv', path: 'x', length: 1e9 }
  ]
  const ai = describeFiles(anime)
  const ahit = pickEpisodeFile(ai, null, 6)
  ok('absolute 6 matched', ahit !== null && ahit.name.includes('- 06'))
}

/* ── 6. 1337x TV category path ───────────────────────────────────── */
console.log('1337x TV category')
{
  const urls = x1337MirrorUrls(['https://1337x.to'], 'breaking bad', true)
  ok('category-search path (tv mode)', urls[0] === 'https://1337x.to/category-search/breaking%20bad/TV/1/', urls[0])
  const plain = x1337MirrorUrls(['https://1337x.to'], 'breaking bad', false)
  ok('plain path (movies/auto + mirror fallback)', plain[0] === 'https://1337x.to/search/breaking%20bad/1/', plain[0])
  const tmpl = x1337MirrorUrls(['https://proxy.example/s?q={query}'], 'x', true)
  ok('template mirror untouched', tmpl[0] === 'https://proxy.example/s?q=x', tmpl[0])
}

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
