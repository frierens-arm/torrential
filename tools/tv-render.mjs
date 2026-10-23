#!/usr/bin/env node
/**
 * tv-render — mount the full TUI with ink-testing-library and verify the
 * TV navigation flow renders: search bar → series list (from a mocked
 * apibay) → season browser → episode grid → episode pre-flight.
 *
 * globalThis.fetch is stubbed, so no real network is touched.
 * Run: node tools/tv-render.mjs  (after `npm run build`)
 */
import React from 'react'
import { render } from 'ink-testing-library'
import { EngineHost } from '../dist/engine/host.js'
import { loadConfig } from '../dist/config.js'

const hash = ch => ch.repeat(40)
const day = 86400

/* apibay row shape — two shows + movie noise that must be filtered out */
const API_ROWS = [
  { id: '1', name: 'Breaking Bad S01E01 2008 720p BluRay x264', info_hash: hash('a'), seeders: '120', leechers: '4', size: '1200000000', added: String(Math.floor(Date.now() / 1000) - 3 * day), cat: '205' },
  { id: '2', name: 'Breaking Bad S01E02 720p BluRay x264', info_hash: hash('b'), seeders: '110', leechers: '4', size: '1100000000', added: String(Math.floor(Date.now() / 1000) - 3 * day), cat: '205' },
  { id: '3', name: 'Breaking.Bad.S02E01.1080p.BluRay.x265', info_hash: hash('c'), seeders: '90', leechers: '2', size: '2400000000', added: String(Math.floor(Date.now() / 1000) - 2 * day), cat: '205' },
  { id: '4', name: 'Breaking Bad Season 1 Complete 720p', info_hash: hash('d'), seeders: '210', leechers: '6', size: '9900000000', added: String(Math.floor(Date.now() / 1000) - 30 * day), cat: '205' },
  { id: '5', name: '[SubsPlease] Frieren - 12 [1080p]', info_hash: hash('e'), seeders: '400', leechers: '9', size: '1400000000', added: String(Math.floor(Date.now() / 1000) - 1 * day), cat: '205' },
  { id: '6', name: 'Interstellar 2014 1080p BluRay x265', info_hash: hash('f'), seeders: '999', leechers: '20', size: '40000000000', added: String(Math.floor(Date.now() / 1000) - 10 * day), cat: '207' }
]

globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('apibay.org')) {
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(API_ROWS) }
  }
  // non-DNS-shaped failure: no DoH bypass attempt, straight to error state
  throw new Error('blocked in test')
}

const { App } = await import('../dist/ui/App.js')

const { config } = loadConfig(undefined)
config.providers = ['piratebay']
config.search_timeout = 3

const host = new EngineHost({ maxConns: 10 })

const app = render(
  React.createElement(App, {
    config,
    host,
    initialQuery: 'breaking bad',
    noPlayer: true,
    warnings: [],
    onRegisterShutdown: () => {}
  })
)

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms))
await settle(400)
await settle()
await settle()

const pass = []
const fail = []
const ok = (name, cond, ctx = '') => (cond ? pass : fail).push(name + (cond ? '' : ` — ${ctx}`))
const frame = () => app.frames[app.frames.length - 1]

const t1 = frame()
ok('series screen renders', t1.includes('SERIES'), t1.split('\n').slice(0, 5).join(' | '))
ok('breaking bad grouped', t1.includes('Breaking Bad'))
ok('frieren grouped (absolute eps)', t1.includes('Frieren'))
ok('movie dropped (no Interstellar)', !t1.includes('Interstellar'))

/* → into seasons */
app.stdin.write('\r')
await settle()
const t2 = frame()
ok('season screen renders', t2.includes('Season 1'), t2.split('\n').slice(0, 5).join(' | '))
ok('season 2 row present', t2.includes('Season 2'))
ok('pack count shown', t2.includes('PACKS'))

/* → into episodes of season 1 */
app.stdin.write('\r')
await settle()
const t3 = frame()
ok('episode screen renders', t3.includes('EPISODE'), t3.split('\n').slice(0, 6).join(' | '))
ok('episode rows E01/E02', t3.includes('E01') && t3.includes('E02'))
ok('season pack pinned', t3.includes('PACK') || t3.includes('season packs'))

/* → detail of episode 1 */
app.stdin.write('\r')
await settle(300)
const t4 = frame()
ok('detail screen renders', t4.includes('S01E01'), t4.split('\n').slice(0, 6).join(' | '))
ok('context label shown', t4.includes('Breaking Bad · S01E01'))
ok('covers + streams rows', t4.includes('covers') && t4.includes('streams'))
ok('magnet ready (apibay builds it)', t4.includes('ready to stream'))

app.unmount()
await host.destroy()

console.log(`\nrender flow: ${pass.length} passed · ${fail.length} failed`)
if (fail.length > 0) {
  console.error('failed:', fail.join('\n  '))
  process.exit(1)
}
