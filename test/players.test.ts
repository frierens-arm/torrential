import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPlayerLaunch, findOnPath, resolveLaunchChain, killPlayer } from '../src/utils/players.js'
import type { InstalledPlayer } from '../src/utils/players.js'

const URL = 'http://127.0.0.1:8000/webtorrent/abc/episode.mkv'

const mpv: InstalledPlayer = { name: 'mpv', command: '/usr/bin/mpv', how: 'PATH' }
const vlc: InstalledPlayer = { name: 'vlc', command: '/usr/bin/vlc', how: 'PATH' }
const iina: InstalledPlayer = {
  name: 'iina',
  command: '/Applications/IINA.app/Contents/MacOS/iina-cli',
  how: 'standard-location'
}
const custom: InstalledPlayer = { name: 'myplayer', command: '/opt/bin/myplayer', how: 'custom' }

describe('buildPlayerLaunch', () => {
  it('gives mpv buffering defaults when the user configured no flags', () => {
    const launch = buildPlayerLaunch(mpv, URL, [])
    assert.equal(launch.name, 'mpv')
    assert.equal(launch.args[0], URL)
    assert.ok(launch.args.includes('--cache-secs=90'))
    assert.equal(launch.detached, false)
  })

  it('never overrides explicit player_flags with the injected defaults', () => {
    const launch = buildPlayerLaunch(mpv, URL, ['--no-audio'])
    assert.deepEqual(launch.args, [URL, '--no-audio'])
  })

  it('appends --play-and-exit for VLC after the user flags', () => {
    const launch = buildPlayerLaunch(vlc, URL, ['--fullscreen'])
    assert.equal(launch.name, 'VLC')
    assert.deepEqual(launch.args, [URL, '--fullscreen', '--play-and-exit'])
  })

  it('does not repeat --play-and-exit when the user already passed it', () => {
    const launch = buildPlayerLaunch(vlc, URL, ['--play-and-exit'])
    assert.deepEqual(launch.args, [URL, '--play-and-exit'])
  })

  it('passes the URL positionally for iina-cli', () => {
    const launch = buildPlayerLaunch(iina, URL, [])
    assert.deepEqual(launch.args, ['--no-stdin', '--keep-running', URL])
    assert.equal(launch.name, 'IINA')
  })

  it('treats a custom binary as a plain url + flags command', () => {
    const launch = buildPlayerLaunch(custom, URL, ['-fs'])
    assert.deepEqual(launch.args, [URL, '-fs'])
    assert.equal(launch.name, 'myplayer')
  })
})

describe('resolveLaunchChain', () => {
  it('reports a configured binary that does not exist', () => {
    const { chain, note } = resolveLaunchChain('/nonexistent/torrential-player', [], URL, [])
    assert.deepEqual(chain, [])
    assert.match(note ?? '', /does not exist/)
  })

  it('reports a configured player that is not installed', () => {
    const { chain, note } = resolveLaunchChain('definitely-not-installed', [], URL, [])
    assert.deepEqual(chain, [])
    assert.match(note ?? '', /not installed/)
  })
})

describe('findOnPath', () => {
  const savedPath = process.env.PATH
  after(() => {
    process.env.PATH = savedPath
  })

  it('finds an executable on PATH and ignores unknown names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-path-'))
    const name = process.platform === 'win32' ? 'torrential-tool.exe' : 'torrential-tool'
    const file = path.join(dir, name)
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(file, 0o755)
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`
    assert.equal(findOnPath('torrential-tool'), file)
    assert.equal(findOnPath('torrential-tool-missing'), null)
  })

  it('refuses a path-shaped argument that is not executable', () => {
    assert.equal(findOnPath('/nope/definitely/missing'), null)
  })
})

describe('killPlayer', () => {
  it('resolves immediately for a player that already exited', async () => {
    await assert.doesNotReject(killPlayer(null))
  })
})
