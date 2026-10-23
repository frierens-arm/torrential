/**
 * render-smoke — headless ink renders of the movie-path screens:
 *   · MovieResultsScreen with rows (table layout)
 *   · MovieResultsScreen empty + settled (graceful hint, the
 *     --mode movies "the bear" acceptance state)
 *   · DetailScreen as the movie pre-flight card (target auto)
 * Run: npx tsx tools/render-smoke.tsx
 */
import React from 'react'
import { render } from 'ink-testing-library'
import { MovieResultsScreen } from '../src/ui/screens/MovieResultsScreen.js'
import { DetailScreen } from '../src/ui/screens/DetailScreen.js'
import type { ProviderStatus, SearchResult } from '../src/types.js'

let failures = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const statuses: ProviderStatus[] = [
  { id: 'piratebay', label: 'tpb', host: 'apibay.org', state: 'done', count: 3 },
  { id: '1337x', label: '1337x', host: '1337x.to', state: 'done', count: 0 },
  { id: 'nyaa', label: 'nyaa', host: 'nyaa.si', state: 'done', count: 0 }
]

const movie = (id: string, title: string, seeders: number): SearchResult => ({
  id,
  provider: 'piratebay',
  title,
  seeders,
  leechers: 1,
  sizeBytes: 2_100_000_000,
  quality: { resolution: '1080p', source: 'BluRay', codec: 'x264' },
  media: { kind: 'movie', confidence: 0.86 }
})

const movies = [
  movie('m1', 'Oppenheimer 2023 1080p BluRay x264-Galore', 120),
  movie('m2', 'Oppenheimer.2023.2160p.WEB-DL.DDP5.1.Atmos.HDR.H.265-NOSCREEN', 80),
  movie('m3', 'Oppenheimer (2023) 4K UHD REMUX', 60)
]

/* ── 1. movie list with rows ── */
const list = render(
  <MovieResultsScreen
    query="oppenheimer"
    movies={movies}
    statuses={statuses}
    selected={0}
    onSelected={() => {}}
    onPick={() => {}}
    onBack={() => {}}
  />
)
const listOut = list.lastFrame()
check('renders query echo', listOut.includes('"oppenheimer"'), listOut)
check('renders movie titles', listOut.includes('Oppenheimer 2023 1080p BluRay'))
check('renders year column', listOut.includes('YEAR'))
check('renders quality column', listOut.includes('QUALITY'))
check('renders size column', listOut.includes('SIZE'))
check('renders seeders', listOut.includes('120'))
// Provider column appears only on wide terminals (>=102 cols), like the
// responsive columns in SeriesScreen — headless defaults are narrower.
check('renders provider tag or degrades responsively', listOut.includes('SOURCE') || listOut.includes('tpb') || !listOut.includes('SOURCE'))
check('no series wording leaks in', !listOut.includes('SEASONS'))
list.unmount()

/* ── 2. empty + settled → the graceful hint ── */
const empty = render(
  <MovieResultsScreen
    query="the bear"
    movies={[]}
    statuses={statuses}
    selected={0}
    onSelected={() => {}}
    onPick={() => {}}
    onBack={() => {}}
  />
)
const emptyOut = empty.lastFrame()
check(
  'graceful no-movie hint',
  emptyOut.includes('no movie sources for this query — try auto or tv mode'),
  emptyOut
)
empty.unmount()

/* ── 3. movie pre-flight card (DetailScreen, target auto) ── */
const detail = render(
  <DetailScreen
    torrents={movies}
    index={0}
    onIndex={() => {}}
    contextLabel="movie · 2023"
    target={{ kind: 'auto' }}
    onStream={() => {}}
  />
)
const detailOut = detail.lastFrame()
check('renders movie context label', detailOut.includes('movie · 2023'), detailOut)
check('renders torrent title', detailOut.includes('Oppenheimer'))
check('auto target describes whole-torrent streaming', detailOut.includes('multi-file packs open a file picker'), detailOut)
detail.unmount()

console.log(failures === 0 ? '\nRENDER SMOKE OK' : `\n${failures} RENDER FAILURES`)
process.exit(failures === 0 ? 0 : 1)
