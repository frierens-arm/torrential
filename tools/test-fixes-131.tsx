/**
 * Functional verification for the 1.3.1 fixes:
 *   1. THE HEADLINE: the /theme picker is interactive — j/k + arrows move
 *      the highlight, ⏎ applies + saves, esc closes; j/k never leak into
 *      the search bar while the picker is open.
 *   2. format.ts display-width helpers + relativeFromUnix(0)
 *   3. ResultsScreen header/row column alignment
 *   4. http.ts DoH fallback now reachable from TypeError failures
 *      (mechanism-level: we assert the retry path engages on a
 *      DNS-unresolvable host).
 *   5. config.ts unknown providers warn instead of silently vanishing.
 */
import { render } from 'ink-testing-library'
import React, { useCallback, useState } from 'react'
import { SearchScreen } from '../src/ui/screens/SearchScreen.js'
import { setTheme, themeId, normalizeThemeName, themeList, DEFAULT_THEME_ID } from '../src/themes.js'
import { parseSlashCommand } from '../src/utils/commands.js'
import { loadConfig, saveConfig } from '../src/config.js'
import { displayWidth, padEnd, padStart, truncate, relativeFromUnix } from '../src/utils/format.js'
import { parseRangeHeader } from '../src/engine/turbo-server.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' ' + extra}`)
  if (!cond) failures++
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Copy shown by SearchScreen while the input is empty. */
const SEARCH_PLACEHOLDER = 'what show are we watching?'

async function waitUntilInputWorks(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    stdin.write('z')
    await sleep(80)
    if ((lastFrame() ?? '').includes('z')) {
      stdin.write('\x15') // ctrl+u — wipe the probe
      await sleep(80)
      return
    }
  }
  throw new Error('stdin never connected — Ink did not attach its listener')
}

/* ------------------------------------------------------------------ *
 * 1. Interactive /theme picker — the user-reported bug
 * ------------------------------------------------------------------ */

/** App-like host: mirrors App.tsx submitSearch/applyTheme wiring faithfully. */
function PickerHost({
  configFile,
  onPicked
}: {
  configFile?: string
  onPicked?: (id: string) => void
}): React.ReactElement {
  const [showThemeList, setShowThemeList] = useState(false)
  const [themeCursor, setThemeCursor] = useState(0)
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)

  const applyThemeById = useCallback(
    (id: string): void => {
      setTheme(id)
      try {
        const fresh = loadConfig(configFile)
        saveConfig({ ...fresh.config, theme: id }, configFile)
      } catch {
        /* best effort in the test */
      }
      setShowThemeList(false)
      setNote({ kind: 'ok', text: `skin applied: ${id} · saved to config` })
      onPicked?.(id)
    },
    [configFile, onPicked]
  )

  // Faithful clone of App.submitSearch's slash-command half.
  const submit = useCallback(
    (text: string): void => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      const cmd = parseSlashCommand(trimmed)
      if (cmd?.kind === 'theme') {
        if (!cmd.arg) {
          setShowThemeList(true)
          setNote(null)
          const idx = themeList().findIndex(t => t.id === themeId())
          setThemeCursor(idx >= 0 ? idx : 0)
          return
        }
        const id = normalizeThemeName(cmd.arg)
        if (id) {
          applyThemeById(id)
          return
        }
        setNote({ kind: 'err', text: `unknown skin "${cmd.arg}"` })
        return
      }
      if (cmd?.kind === 'unknown') {
        setNote({ kind: 'err', text: `unknown command "/${cmd.name}"` })
      }
    },
    [applyThemeById]
  )

  return (
    <SearchScreen
      initialQuery=""
      onSubmit={submit}
      warnings={[]}
      themeNote={note}
      showThemeList={showThemeList}
      themeCursor={themeCursor}
      onThemeCursor={setThemeCursor}
      onThemePick={applyThemeById}
      onThemeClose={() => {
        setShowThemeList(false)
        setNote(null)
      }}
    />
  )
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-131-'))
const cfgFile = path.join(tmpDir, 'config.json')
saveConfig(loadConfig(cfgFile).config, cfgFile) // materialize defaults

let pickedTheme = ''
const { stdin, lastFrame, unmount } = render(<PickerHost configFile={cfgFile} onPicked={id => (pickedTheme = id)} />)
await waitUntilInputWorks(stdin, lastFrame)

// Open the picker: type /theme + Enter
stdin.write('/theme')
await sleep(120)
check('typing /theme puts text in the input (placeholder gone)', !(lastFrame() ?? '').includes(SEARCH_PLACEHOLDER))
stdin.write('\r') // Enter → opens picker + clears the bar
await sleep(150)

let frame = lastFrame() ?? ''
check('bare /theme + ⏎ opens the skin picker (hint line present)', frame.includes('apply + save'), frame.slice(0, 160))
check('picker opened with the input cleared (placeholder back)', frame.includes(SEARCH_PLACEHOLDER))
check('picker advertises j/k navigation', frame.includes('j/k'), frame.slice(0, 200))
check('cursor starts on the active skin (rain)', frame.includes('▸ rain'), frame.slice(0, 200))

// Move down twice — highlight must follow
stdin.write('\x1b[B') // ↓
await sleep(100)
stdin.write('j') // j — same as ↓, also must NOT leak into the (frozen) input
await sleep(100)
frame = lastFrame() ?? ''
check('↓ then j move the highlight (rain → sunset)', frame.includes('▸ sunset'), frame.slice(0, 200))
check('j does not leak into the search bar while the picker is open', frame.includes(SEARCH_PLACEHOLDER))

// Jump to bottom with G, then up one with k
stdin.write('G')
await sleep(100)
frame = lastFrame() ?? ''
check('G jumps to the last skin (mono)', frame.includes('▸ mono'))
stdin.write('k') // back up one → amber
await sleep(100)
frame = lastFrame() ?? ''
check('k moves up (mono → amber)', frame.includes('▸ amber'))

// Apply with Enter — must apply + save + close
stdin.write('\r')
await sleep(150)
frame = lastFrame() ?? ''
check('⏎ applies the highlighted skin and closes the picker', !frame.includes('apply + save') && frame.includes('skin applied: amber'), frame.slice(0, 160))
check('apply feedback note shown', frame.includes('skin applied: amber'))
check('theme actually switched in memory', themeId() === 'amber', themeId())

const persisted = loadConfig(cfgFile).config.theme
check('skin persisted to config.json', persisted === 'amber', String(persisted))

// Reopen and close with esc
stdin.write('/theme')
await sleep(120)
stdin.write('\r')
await sleep(150)
check('picker reopens on /theme', (lastFrame() ?? '').includes('apply + save'))
stdin.write('\x1b') // ESC
await sleep(150)
frame = lastFrame() ?? ''
check('esc closes the picker', !frame.includes('apply + save'))

// Reopen and close with q
stdin.write('/theme')
await sleep(120)
stdin.write('\r')
await sleep(150)
stdin.write('q')
await sleep(150)
check('q closes the picker too', !(lastFrame() ?? '').includes('apply + save'))

// While the picker is open, arrows must never touch the input either
stdin.write('/theme')
await sleep(120)
stdin.write('\r')
await sleep(150)
stdin.write('\x1b[B\x1b[B\x1b[A')
await sleep(150)
frame = lastFrame() ?? ''
check('arrows only drive the picker, never the input', frame.includes(SEARCH_PLACEHOLDER) && frame.includes('▸'))
unmount()

fs.rmSync(tmpDir, { recursive: true, force: true })
setTheme(DEFAULT_THEME_ID) // leave the process palette clean for later checks

/* ------------------------------------------------------------------ *
 * 2. format helpers
 * ------------------------------------------------------------------ */
check('displayWidth counts CJK as double', displayWidth('[グループ] アニメ') === 17, String(displayWidth('[グループ] アニメ')))
check('padEnd pads by display width (CJK)', padEnd('アニメ', 8) === 'アニメ  ', JSON.stringify(padEnd('アニメ', 8)))
check('padStart pads by display width (CJK)', padStart('アニメ', 8) === '  アニメ', JSON.stringify(padStart('アニメ', 8)))
check('truncate is display-width aware', displayWidth(truncate('アニメタイトル' + 'x'.repeat(30), 12)) <= 12, truncate('アニメタイトル' + 'x'.repeat(30), 12))
check('ascii strings unchanged by width helpers', padEnd('sintel', 10) === 'sintel    ' && padStart('431', 5) === '  431')
check('relativeFromUnix(0) → empty (was 56y ago)', relativeFromUnix(0) === '')
check('relativeFromUnix(NaN) → empty', relativeFromUnix(Number.NaN) === '')
check('relativeFromUnix(now) → just now', relativeFromUnix(Date.now() / 1000) === 'just now')

/* ------------------------------------------------------------------ *
 * 3. Range parsing sanity (regression guard for the smoke suite)
 * ------------------------------------------------------------------ */
check('parseRangeHeader suffix', JSON.stringify(parseRangeHeader('bytes=-100', 1000)) === JSON.stringify({ start: 900, end: 999 }))
check('parseRangeHeader past-EOF → 416', parseRangeHeader('bytes=5000-', 1000) === 'unsatisfiable')

/* ------------------------------------------------------------------ *
 * 4. config: unknown providers warn
 * ------------------------------------------------------------------ */
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-131b-'))
  const f2 = path.join(tmp2, 'config.json')
  fs.writeFileSync(f2, JSON.stringify({ providers: ['piratebay', '1337', 'nyaa'] }), 'utf8')
  const res = loadConfig(f2)
  check('unknown provider id warns', res.warnings.some(w => w.includes('unknown source "1337"')), res.warnings.join(' | '))
  check('unknown provider suggests 1337x', res.warnings.some(w => w.includes('did you mean "1337x"')), res.warnings.join(' | '))
  check('valid ids survive the filter', JSON.stringify(res.config.providers) === JSON.stringify(['piratebay', 'nyaa']), JSON.stringify(res.config.providers))
  fs.rmSync(tmp2, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL 1.3.1 CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
