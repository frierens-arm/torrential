#!/usr/bin/env node
/**
 * classify-smoke — offline assertions for the auto-mode classifier:
 *   classifyTitle · classifyQuery · voteKind
 * plus the parser regressions the fixtures flushed out (year guards on
 * the absolute-dash forms, year-shaped 1xx tokens) and the movie/TV
 * separation contract of the series index.
 *
 * Run: node tools/classify-smoke.mjs   (after `npm run build`)
 */
import { classifyTitle, classifyQuery, voteKind } from '../dist/utils/classify.js'
import { parseTvTitle, toTvResult, buildSeriesIndex, showKey } from '../dist/utils/tv.js'

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
const kindOf = title => classifyTitle(title).kind
const tag = title => classifyTitle(title)

/* ── 1. classifyTitle fixtures ───────────────────────────────────── */
console.log('classifyTitle')
{
  ok(
    'movie: year+source+codec',
    kindOf('Oppenheimer 2023 1080p BluRay x264-Galore') === 'movie',
    JSON.stringify(tag('Oppenheimer 2023 1080p BluRay x264-Galore'))
  )
  ok(
    'movie: web-dl stack',
    kindOf('Oppenheimer.2023.2160p.WEB-DL.DDP5.1.Atmos.HDR.H.265-NOSCREEN') === 'movie',
    JSON.stringify(tag('Oppenheimer.2023.2160p.WEB-DL.DDP5.1.Atmos.HDR.H.265-NOSCREEN'))
  )
  ok(
    'movie: 4K UHD REMUX',
    kindOf('Oppenheimer (2023) 4K UHD REMUX') === 'movie',
    JSON.stringify(tag('Oppenheimer (2023) 4K UHD REMUX'))
  )
  ok(
    'movie: dash-year form is NOT episode E2023 (parser regression)',
    kindOf('Oppenheimer - 2023 1080p BluRay x264') === 'movie',
    JSON.stringify(tag('Oppenheimer - 2023 1080p BluRay x264'))
  )
  ok(
    'episode: SxxExx',
    kindOf('The Bear S02E01 1080p WEB-DL') === 'episode',
    JSON.stringify(tag('The Bear S02E01 1080p WEB-DL'))
  )
  ok(
    'episode: range',
    kindOf('Friends.S01E01-E03.720p') === 'episode',
    JSON.stringify(tag('Friends.S01E01-E03.720p'))
  )
  ok(
    'season-pack: Sxx + Complete',
    kindOf('Breaking Bad S05 Complete 720p') === 'season-pack',
    JSON.stringify(tag('Breaking Bad S05 Complete 720p'))
  )
  ok(
    'episode: date form',
    kindOf('The Daily Show 2023.10.12 720p WEB-DL') === 'episode',
    JSON.stringify(tag('The Daily Show 2023.10.12 720p WEB-DL'))
  )
  ok(
    'episode: nyaa absolute',
    kindOf('[SubsPlease] Jujutsu Kaisen - 28 [1080p]') === 'episode',
    JSON.stringify(tag('[SubsPlease] Jujutsu Kaisen - 28 [1080p]'))
  )
  ok(
    'episode: explicit marker beats movie-looking title',
    kindOf('Oppenheimer S01E04') === 'episode',
    JSON.stringify(tag('Oppenheimer S01E04'))
  )
  const unknown = tag('Weird Movie 4K HDR')
  ok(
    'unknown: no year, no source/codec tags',
    unknown.kind === 'unknown' && unknown.confidence <= 0.3,
    JSON.stringify(unknown)
  )
}

/* ── 2. provider prior ───────────────────────────────────────────── */
console.log('provider prior')
{
  const neutral = classifyTitle('Some Thing - 07 [720p]')
  const nyaa = classifyTitle('Some Thing - 07 [720p]', 'nyaa')
  ok('neutral absolute episode', neutral.kind === 'episode', JSON.stringify(neutral))
  ok('nyaa biases ambiguous → episode', nyaa.kind === 'episode' && nyaa.confidence >= neutral.confidence, JSON.stringify(nyaa))
  // Strong movie evidence must survive the prior.
  const strong = classifyTitle('Kono Movie 2023 1080p BluRay x264', 'nyaa')
  ok('nyaa never overrides strong movie signals', strong.kind === 'movie', JSON.stringify(strong))
}

/* ── 3. classifyQuery (mild prior) ───────────────────────────────── */
console.log('classifyQuery')
{
  ok('bare title → unknown', classifyQuery('oppenheimer').kind === 'unknown', JSON.stringify(classifyQuery('oppenheimer')))
  ok(
    'bare title + year leans movie',
    classifyQuery('oppenheimer 2023').kind === 'movie',
    JSON.stringify(classifyQuery('oppenheimer 2023'))
  )
  ok('SxxExx query → episode', classifyQuery('breaking bad s02e05').kind === 'episode', JSON.stringify(classifyQuery('breaking bad s02e05')))
  ok('show query → unknown', classifyQuery('the bear').kind === 'unknown', JSON.stringify(classifyQuery('the bear')))
}

/* ── 4. set votes ────────────────────────────────────────────────── */
console.log('voteKind')
{
  const movieRow = 'Oppenheimer 2023 1080p BluRay x264-Galore'
  const epRow = 'The Bear S02E01 1080p WEB-DL'
  const dozen = Array.from({ length: 12 }, () => tag(movieRow))
  const vote12to1 = voteKind([...dozen, tag(epRow)])
  ok('12 movie rows + 1 episode row → movie', vote12to1.kind === 'movie', JSON.stringify(vote12to1))

  const bear = Array.from({ length: 8 }, (_, i) => tag(`The Bear S02E0${(i % 8) + 1} 1080p`))
  const mostlyTv = voteKind(bear)
  ok('mostly SxxExx rows → episode/TV', mostlyTv.kind === 'episode', JSON.stringify(mostlyTv))

  const tie = voteKind([tag(epRow), tag(epRow), tag(movieRow), tag(movieRow)])
  ok('split vote → unknown', tie.kind === 'unknown', JSON.stringify(tie))
  const silent = voteKind([tag('Weird Movie 4K HDR'), tag('Another Unknown 720p')])
  ok('mostly-unknown set → unknown', silent.kind === 'unknown', JSON.stringify(silent))
  ok('empty set → unknown', voteKind([]).kind === 'unknown')
}

/* ── 5. parser regressions in tv.ts (fixtures flushed these out) ─── */
console.log('parser regressions')
{
  const r1 = parseTvTitle('Oppenheimer - 2023 1080p BluRay x264')
  ok('dash-year space form → no scope', r1.scope === null, JSON.stringify(r1))

  const r1b = parseTvTitle('Oppenheimer - 2023 [1080p]')
  ok('dash-year bracket form → no scope (was E2023)', r1b.scope === null, JSON.stringify(r1b))

  const r1c = parseTvTitle('Collection - 2023-2024 [BluRay]')
  ok('dash-year RANGE → no scope (was E2023-E2024)', r1c.scope === null, JSON.stringify(r1c))

  const r2 = parseTvTitle('Oppenheimer 2023 1080p')
  ok('findNnn skips the year', r2.scope === null, JSON.stringify(r2))

  const r3 = parseTvTitle('The Last of Us 108 2023 WEB-DL')
  ok('1xx still parses beside a year', r3.scope?.kind === 'episode' && r3.scope.season === 1 && r3.scope.episode === 8, JSON.stringify(r3))

  const r4 = parseTvTitle('Blade Runner 2049 2160p')
  ok('2049 is a year, not S20E49', r4.scope === null, JSON.stringify(r4))

  const r5 = parseTvTitle('[Erai-raws] Frieren - 01-12 [Batch][1080p]')
  ok('absolute batch range still parses', r5.scope?.kind === 'episode' && r5.scope.episodes?.length === 12, JSON.stringify(r5))

  const r6 = parseTvTitle('[SubsPlease] Jujutsu Kaisen - 28 [1080p]')
  ok('nyaa absolute 28 still parses', r6.scope?.kind === 'episode' && r6.scope.episode === 28, JSON.stringify(r6))

  const generic = toTvResult({ id: 'm', provider: 'tpb', title: 'Oppenheimer 2023 1080p BluRay x264', seeders: 5, leechers: 0, sizeBytes: 1, quality: {} })
  ok('movie row survives as generic (tagged, not dropped)', generic.scope === undefined && generic.show === undefined, JSON.stringify(generic))
}

/* ── 6. movie rows never leak into the series index ──────────────── */
console.log('index separation')
{
  const mk = (id, title) => {
    const base = { id, provider: 'tpb', title, seeders: 10, leechers: 0, sizeBytes: 1e9, quality: {} }
    return toTvResult(base)
  }
  const rows = [
    mk('a', 'Breaking Bad S01E01 720p'),
    mk('b', 'Breaking Bad S01E02 720p'),
    mk('c', 'Oppenheimer 2023 1080p BluRay x264'),
    mk('d', 'Oppenheimer (2023) 4K UHD REMUX')
  ]
  const index = buildSeriesIndex(rows)
  ok('movie rows absent from series index', !index.has(showKey('Oppenheimer')), [...index.keys()].join(','))
  ok('tv rows still grouped', index.has(showKey('Breaking Bad')))
  const bb = index.get(showKey('Breaking Bad'))
  ok('tv row count intact', bb !== undefined && bb.torrents.length === 2)
}

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
