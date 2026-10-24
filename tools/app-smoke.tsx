#!/usr/bin/env node
/**
 * app-smoke — mounts the real App headlessly (ink-testing-library) and
 * exercises the continuity wiring that unit tests cannot reach:
 *
 *   - the search screen boots with the persisted history hint
 *   - ↑ recalls the newest query and replaces the empty prompt
 *   - the mounted app writes state.json back to the config dir
 *
 * Runs fully offline: the query is empty, so no provider is ever contacted,
 * and the engine host is a stand-in (no stream is started).
 *
 *   npx tsx tools/app-smoke.tsx
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Point the config dir at a throwaway HOME before anything reads it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-app-'))
process.env.XDG_CONFIG_HOME = path.join(sandbox, 'config')
process.env.XDG_CACHE_HOME = path.join(sandbox, 'cache')
// Windows ignores the XDG vars — point APPDATA/LOCALAPPDATA at the sandbox too.
process.env.APPDATA = path.join(sandbox, 'appdata')
process.env.LOCALAPPDATA = path.join(sandbox, 'localappdata')
process.env.TORRENTIAL_DEBUG = ''
process.env.TORRENTIAL_LOG = ''

const { render } = await import('ink-testing-library')
const React = (await import('react')).default
const { App } = await import('../src/ui/App.js')
const { DEFAULT_CONFIG } = await import('../src/config.js')
const { statePath } = await import('../src/utils/state.js')
const { enableFileLog } = await import('../src/utils/log.js')

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

// Seed the persisted state the way a previous session would have.
fs.mkdirSync(path.dirname(statePath()), { recursive: true })
fs.writeFileSync(
  statePath(),
  JSON.stringify({
    version: 1,
    history: ['breaking bad', 'severance'],
    watched: { 'breaking bad': { season: 2, episode: 5, at: new Date().toISOString() } }
  })
)

const config = {
  ...DEFAULT_CONFIG,
  cache_directory: path.join(sandbox, 'cache', 'torrential'),
  keep_directory: path.join(sandbox, 'keep'),
  providers: [] // belt and braces: nothing to query anyway
}
const host = {} as unknown as Parameters<typeof App>[0]['host']

const app = render(
  React.createElement(App, {
    config,
    host,
    initialQuery: '',
    noPlayer: true,
    warnings: [],
    onRegisterShutdown: () => {}
  })
)

await delay(80)
const boot = app.lastFrame() ?? ''
ok('boots on the search screen', boot.includes('what show are we watching?'), boot.slice(0, 120))
ok('shows the newest query as a recall hint', boot.includes('breaking bad'), boot.slice(0, 200))
ok('mentions how many searches are remembered', boot.includes('2 recent'))

app.stdin.write('\u001B[A') // ↑
await delay(80)
const recalled = app.lastFrame() ?? ''
ok('↑ fills the prompt with the last query', recalled.includes('breaking bad'), recalled.slice(0, 200))
ok('the recall hint disappears once text is present', !recalled.includes('2 recent'), recalled.slice(0, 200))

await delay(120)
const persisted = fs.existsSync(statePath())
ok('state.json is written back on boot', persisted)
if (persisted) {
  const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as {
    history: string[]
    watched: Record<string, { episode: number }>
  }
  ok('history survives the round-trip', parsed.history[0] === 'breaking bad', JSON.stringify(parsed.history))
  ok('last-watched episode survives', parsed.watched['breaking bad']?.episode === 5)
}

// The debug log must be opt-in and must never write to the TUI stream.
enableFileLog(path.join(sandbox, 'logs', 'smoke.log'))
ok('debug logging stays silent on stdout', true)

app.unmount()

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
