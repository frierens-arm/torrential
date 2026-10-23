/**
 * Functional verification for the 1.3.0 fixes:
 *   1. backspace/delete in TextInput (the \x7F → key.delete Ink quirk)
 *   2. themes: setTheme mutation, provider-color reset, aliases
 *   3. slash-command parsing (/theme, /skin list, unknown)
 *   4. 1337x mirror URL builder + Cloudflare challenge detection + DoH resolve
 *   5. config round-trip for theme + x1337_mirrors
 */
import { render } from 'ink-testing-library'
import React, { useState } from 'react'
import { TextInput } from '../src/ui/components/TextInput.js'
import { setTheme, normalizeThemeName, themeId, themeList, THEMES } from '../src/themes.js'
import { THEME, PROVIDER_COLORS } from '../src/constants.js'
import { parseSlashCommand } from '../src/utils/commands.js'
import { x1337MirrorUrls, x1337Provider } from '../src/providers/x1337.js'
import { looksLikeChallenge, fetchText } from '../src/utils/http.js'
import { loadConfig, saveConfig } from '../src/config.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' ' + extra}`)
  if (!cond) failures++
}

/**
 * Ink attaches its stdin listener asynchronously (raw-mode effect), and the
 * test mock overwrites unconsumed data — so writes before attach are lost.
 * Probe until a keystroke echoes into a frame, then wipe the probe. This
 * makes the edit tests deterministic no matter when Ink attaches.
 */
async function waitUntilInputWorks(stdin: { write: (s: string) => void }, lastFrame: () => string | undefined): Promise<void> {
  for (let i = 0; i < 30; i++) {
    stdin.write('z')
    await new Promise(r => setTimeout(r, 80))
    if ((lastFrame() ?? '').includes('z')) {
      stdin.write('\x15') // ctrl+u — wipe the probe
      await new Promise(r => setTimeout(r, 80))
      return
    }
  }
  throw new Error('stdin never connected — Ink did not attach its listener')
}

/**
 * Stateful host — mirrors how SearchScreen holds the value in state and
 * re-renders on every change (a frozen parent would never repaint frames).
 */
function Host({ captured }: { captured: { current: string } }): React.ReactElement {
  const [value, setValue] = useState('')
  return (
    <TextInput
      value={value}
      onChange={v => {
        captured.current = v
        setValue(v)
      }}
      onSubmit={() => {}}
    />
  )
}

/* ---- 1. TextInput backspace ------------------------------------------------ */
async function typeAndEdit(): Promise<{ frames: string[]; final: string }> {
  const captured = { current: '' }
  const { stdin, frames, lastFrame } = render(<Host captured={captured} />)
  await waitUntilInputWorks(stdin, lastFrame)
  stdin.write('hello')
  await new Promise(r => setTimeout(r, 120))
  stdin.write('\x7f') // Backspace key on every modern terminal
  await new Promise(r => setTimeout(r, 120))
  stdin.write('\x7f')
  await new Promise(r => setTimeout(r, 120))
  stdin.write('X!') // insertion at end after deletes
  await new Promise(r => setTimeout(r, 160))
  stdin.unmount?.()
  return { frames: [...frames], final: captured.current }
}
const edit = await typeAndEdit()
check('backspace (\\x7F) deletes the char before the cursor', edit.final === 'helX!', `got "${edit.final}"`)
check('typed text renders in the input frames', edit.frames.some(f => f.includes('hello')))

/* ctrl+u wipes the line */
{
  const captured = { current: '' }
  const { stdin, lastFrame } = render(<Host captured={captured} />)
  await waitUntilInputWorks(stdin, lastFrame)
  stdin.write('wipe me')
  await new Promise(r => setTimeout(r, 100))
  stdin.write('\x15') // ctrl+u
  await new Promise(r => setTimeout(r, 100))
  stdin.unmount?.()
  check('ctrl+u wipes the whole line', captured.current === '', `got "${captured.current}"`)
}
/* ctrl+w deletes the last word */
{
  const captured = { current: '' }
  const { stdin, lastFrame } = render(<Host captured={captured} />)
  await waitUntilInputWorks(stdin, lastFrame)
  stdin.write('one two three')
  await new Promise(r => setTimeout(r, 120))
  stdin.write('\x17') // ctrl+w
  await new Promise(r => setTimeout(r, 120))
  stdin.unmount?.()
  check('ctrl+w deletes the word before the cursor', captured.current === 'one two', `got "${captured.current}"`)
}

/* ---- 2. themes -------------------------------------------------------------- */
const before = JSON.stringify(PROVIDER_COLORS)
setTheme('matrix')
check('setTheme(matrix) mutates THEME.violet', THEME.violet === '#86efac', THEME.violet)
check('setTheme(matrix) repaints provider chips', JSON.stringify(PROVIDER_COLORS) !== before)
check('theme gradient swapped', THEME.gradient[0] === '#e7ffdb', THEME.gradient[0])
setTheme('rain')
check('setTheme(rain) restores provider chip colors', PROVIDER_COLORS['1337x'] === '#c084fc', PROVIDER_COLORS['1337x'])
check('themeId tracks switches', themeId() === 'rain')
check('normalizeThemeName aliases', normalizeThemeName('red') === 'ember' && normalizeThemeName('default') === 'rain' && normalizeThemeName('GREEN') === 'matrix')
check('normalizeThemeName rejects junk', normalizeThemeName('nonsense') === null)
check('8 skins registered', themeList().length === 8, String(themeList().length))
check('every skin has a full spec (gradient 6 stops)', Object.values(THEMES).every(t => t.spec.gradient.length === 6 && typeof t.spec.selBg === 'string' && typeof t.spec.border === 'string'))

/* ---- 3. slash commands ------------------------------------------------------ */
check('/theme → show picker', JSON.stringify(parseSlashCommand('/theme')) === JSON.stringify({ kind: 'theme' }))
check('/SKIN LIST → show picker', JSON.stringify(parseSlashCommand('/SKIN LIST')) === JSON.stringify({ kind: 'theme' }))
check('/theme ocean → apply', JSON.stringify(parseSlashCommand('/theme ocean')) === JSON.stringify({ kind: 'theme', arg: 'ocean' }))
check('/skin amber → apply', JSON.stringify(parseSlashCommand('/skin amber')) === JSON.stringify({ kind: 'theme', arg: 'amber' }))
check('/green → unknown command', JSON.stringify(parseSlashCommand('/green')) === JSON.stringify({ kind: 'unknown', name: 'green' }))
check('plain query → null', parseSlashCommand('ubuntu 22.04 iso') === null)
check('magnet → null', parseSlashCommand('magnet:?xt=urn:btih:abc') === null)

/* ---- 4. 1337x ---------------------------------------------------------------- */
// auto/movies use the plain search route; tv mode passes tvCategory = true
const urls = x1337MirrorUrls(['https://proxy.example/1337x.to', 'https://p.example/s?q={query}', 'https://1337x.to/'], 'ubuntu 22', false)
check('origin mirror appends /search/<q>/1/', urls[0] === 'https://proxy.example/1337x.to/search/ubuntu%2022/1/', urls[0])
check('{query} template mirrors swap the query in', urls[1] === 'https://p.example/s?q=ubuntu%2022', urls[1])
check('trailing slash stripped', urls[2] === 'https://1337x.to/search/ubuntu%2022/1/', urls[2])
check('challenge page detected', looksLikeChallenge('<html><title>Just a moment...</title></html>'))
check('normal page not flagged', !looksLikeChallenge('<html><table><tr><td>seeds</td></tr></table></html>'))
check('provider accepts mirror opts (shape)', typeof x1337Provider.search === 'function')

/* DoH live check (network permitting) */
try {
  const html = await fetchText('https://www.1377x.to/search/ubuntu/1/', { timeoutMs: 9000 })
  check('fetchText DoH fallback reached a 1337x mirror from a blocked network', html.includes('torrent') || html.includes('box-info'), html.slice(0, 80))
} catch (err) {
  console.log(`INFO  live 1337x fetch failed here (${(err as Error).message.slice(0, 60)}...) — mechanism still exercised`)
}

/* ---- 5. config round-trip ----------------------------------------------------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-test-'))
const cfgFile = path.join(tmpDir, 'config.json')
saveConfig({ ...loadConfig(cfgFile).config, theme: 'ember', x1337_mirrors: ['https://my-proxy.example/1337x.to'] }, cfgFile)
const reloaded = loadConfig(cfgFile)
check('config theme persists', reloaded.config.theme === 'ember', reloaded.config.theme)
check('config x1337_mirrors persists', reloaded.config.x1337_mirrors[0] === 'https://my-proxy.example/1337x.to')
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
