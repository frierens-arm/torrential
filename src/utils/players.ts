import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { log, logError } from './log.js'

/** A player we found installed on this machine. */
export interface InstalledPlayer {
  name: string // 'mpv' | 'vlc' | 'iina' | custom label
  command: string // resolved executable to spawn
  how: 'PATH' | 'standard-location' | 'custom'
}

/** A fully-resolved launch attempt (URL + flags baked into argv). */
export interface PlayerLaunch {
  name: string // display name, e.g. 'mpv', 'VLC', 'system default'
  kind: 'player' | 'opener'
  command: string
  args: string[]
  /** Openers (xdg-open/open/start) exit immediately — no exit event drives teardown. */
  detached: boolean
}

const WINDOWS_EXTS = ['.exe', '.com']

function isWindows(): boolean {
  return process.platform === 'win32'
}

function isMac(): boolean {
  return process.platform === 'darwin'
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Locate `name` on PATH (respecting PATHEXT on Windows; only directly spawnable extensions). */
export function findOnPath(name: string): string | null {
  if (name.includes('/') || name.includes('\\')) {
    return isExecutable(name) ? name : null
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const candidates = isWindows()
    ? WINDOWS_EXTS.map(ext => name + ext)
    : [name]
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate)
      if (isExecutable(full)) return full
    }
  }
  return null
}

/** Well-known install locations that PATH lookups can miss. */
const STANDARD_LOCATIONS: Array<{ name: string; platform: NodeJS.Platform; paths: string[] }> = [
  { name: 'vlc', platform: 'darwin', paths: ['/Applications/VLC.app/Contents/MacOS/VLC'] },
  {
    name: 'iina',
    platform: 'darwin',
    paths: ['/Applications/IINA.app/Contents/MacOS/iina-cli']
  },
  {
    name: 'vlc',
    platform: 'win32',
    paths: [
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
    ]
  },
  {
    name: 'mpv',
    platform: 'win32',
    paths: ['C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe']
  }
]

/** Detect every stream-capable player we can find, in quality order. */
export function detectInstalledPlayers(): InstalledPlayer[] {
  const found: InstalledPlayer[] = []
  const seen = new Set<string>()
  const push = (p: InstalledPlayer) => {
    if (!seen.has(p.command)) {
      seen.add(p.command)
      found.push(p)
    }
  }

  for (const name of ['mpv', 'vlc', 'iina-cli', 'iina']) {
    const cmd = findOnPath(name)
    if (cmd) {
      push({
        name: name === 'iina-cli' ? 'iina' : name,
        command: cmd,
        how: 'PATH'
      })
    }
  }
  for (const loc of STANDARD_LOCATIONS) {
    if (loc.platform !== process.platform) continue
    for (const p of loc.paths) {
      if (isExecutable(p)) push({ name: loc.name, command: p, how: 'standard-location' })
    }
  }
  return found
}

let detectionCache: InstalledPlayer[] | null = null

/**
 * Memoized player detection. Filesystem scans used to run on every stream
 * start; they now run once per session so the ready path never pays for
 * them. `--list-players` still calls the uncached variant for truth.
 */
export function cachedInstalledPlayers(): InstalledPlayer[] {
  if (detectionCache === null) detectionCache = detectInstalledPlayers()
  return detectionCache
}

/** The OS URL opener used for default_player: "system". */
export function systemOpener(): PlayerLaunch | null {
  if (isMac()) {
    return { name: 'system default (open)', kind: 'opener', command: 'open', args: [], detached: true }
  }
  if (isWindows()) {
    return {
      name: 'system default (start)',
      kind: 'opener',
      command: 'cmd',
      args: [],
      detached: true
    }
  }
  const xdg = findOnPath('xdg-open')
  if (xdg) {
    return { name: 'system default (xdg-open)', kind: 'opener', command: xdg, args: [], detached: true }
  }
  return null
}

/**
 * Per-player buffering defaults for slow links. Players are happy to buffer
 * minutes of readahead — they just need to be told. Applied ONLY when the
 * user has not configured their own player_flags (those always win), and
 * only for players these flags are verified to accept.
 */
const MPV_SMOOTH_DEFAULTS = [
  '--cache=yes',
  '--cache-secs=90',
  '--demuxer-readahead-secs=90',
  '--demuxer-max-bytes=1GiB',
  '--force-window=immediate',
  '--network-timeout=60'
]
const VLC_SMOOTH_DEFAULTS = ['--network-caching=10000']

/** Build the argv for a known player about to receive our stream URL. */
export function buildPlayerLaunch(player: InstalledPlayer, url: string, flags: string[]): PlayerLaunch {
  const args: string[] = []
  let name = player.name
  if (player.how === 'custom') {
    name = path.basename(player.command)
    args.push(url, ...flags)
  } else if (player.name === 'iina') {
    // iina-cli takes the URL as a POSITIONAL argument. Unknown --flags are
    // forwarded to mpv as raw options and abort loading, so only pass real
    // iina-cli flags:
    //   --no-stdin      we never pipe media through stdin
    //   --keep-running  keeps the CLI process alive until the IINA app quits,
    //                   which is the exit event that drives our teardown
    // (Verified against iina-cli main.swift + webtorrent-cli's player table.)
    // Buffering tuning for IINA is intentionally left to player_flags.
    args.push('--no-stdin', '--keep-running', url, ...flags)
    name = 'IINA'
  } else if (player.name === 'vlc') {
    // Exit when playback ends so teardown fires immediately.
    const base = flags.length > 0 ? flags : VLC_SMOOTH_DEFAULTS
    const all = base.includes('--play-and-exit') ? base : [...base, '--play-and-exit']
    args.push(url, ...all)
    name = 'VLC'
  } else {
    // mpv — plays the HTTP stream directly, honors --cache style flags.
    args.push(url, ...(flags.length > 0 ? flags : MPV_SMOOTH_DEFAULTS))
  }
  return { name, kind: 'player', command: player.command, args, detached: false }
}

function openerLaunch(opener: PlayerLaunch, url: string): PlayerLaunch {
  if (isWindows() && opener.command === 'cmd') {
    return { ...opener, args: ['/c', 'start', '', url] }
  }
  return { ...opener, args: [url] }
}

/**
 * Resolve the ordered chain of launch attempts:
 *   1. CLI/config preference (system opener, known player, or custom path)
 *   2. configured fallbacks (default: mpv → vlc → iina)
 * If nothing resolves, the chain is empty and the caller should surface the URL.
 */
export function resolveLaunchChain(
  preference: string,
  fallbacks: string[],
  url: string,
  flags: string[]
): { chain: PlayerLaunch[]; note?: string } {
  const installed = cachedInstalledPlayers()
  const byName = new Map(installed.map(p => [p.name, p]))
  const chain: PlayerLaunch[] = []
  let note: string | undefined

  const pref = (preference ?? '').trim()
  if (!pref || pref === 'system') {
    const opener = systemOpener()
    if (opener) {
      chain.push(openerLaunch(opener, url))
    } else {
      note = 'no system opener found (xdg-open missing) — falling back to detected players'
    }
  } else if (byName.has(pref)) {
    chain.push(buildPlayerLaunch(byName.get(pref)!, url, flags))
  } else if (pref.includes('/') || pref.includes('\\')) {
    if (isExecutable(pref)) {
      chain.push(buildPlayerLaunch({ name: path.basename(pref), command: pref, how: 'custom' }, url, flags))
    } else {
      note = `configured player "${pref}" does not exist — falling back`
    }
  } else {
    note = `configured player "${pref}" is not installed — falling back`
  }

  for (const fb of fallbacks) {
    const player = byName.get(fb)
    if (player) {
      const launch = buildPlayerLaunch(player, url, flags)
      if (!chain.some(c => c.command === launch.command)) chain.push(launch)
    }
  }
  return { chain, note }
}

export interface SpawnResult {
  child: ChildProcess | null
  launch: PlayerLaunch | null
  error: string | null
}

/**
 * Try every launch in the chain until one spawns cleanly (handles ENOENT
 * races and half-installed players). Returns null child when all failed.
 */
export function trySpawnPlayer(chain: PlayerLaunch[]): Promise<SpawnResult> {
  return new Promise(resolve => {
    const attempts = [...chain]
    const attemptNext = (): void => {
      const launch = attempts.shift()
      if (!launch) {
        log('player:none-launchable')
        resolve({ child: null, launch: null, error: 'no launchable player found' })
        return
      }
      let settled = false
      let child: ChildProcess
      log('player:spawn', {
        name: launch.name,
        command: launch.command,
        args: launch.args,
        detached: launch.detached
      })
      try {
        child = spawn(launch.command, launch.args, {
          stdio: 'ignore',
          windowsHide: true,
          detached: false
        })
      } catch (err) {
        logError('player:spawn-threw', err, { name: launch.name })
        attemptNext()
        return
      }
      const onError = (err: Error): void => {
        if (settled) return
        settled = true
        logError('player:spawn-failed', err, { name: launch.name }) // ENOENT etc. — try the next candidate
        attemptNext()
      }
      child.on('error', onError)
      // Give the loop a beat: spawn failures surface on the next ticks.
      setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ child, launch, error: null })
      }, 60)
    }
    attemptNext()
  })
}

/** Best-effort graceful kill; force-escalates after a grace period. */
export function killPlayer(child: ChildProcess | null | undefined): Promise<void> {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let done = false
    const finish = (): void => {
      if (!done) {
        done = true
        resolve()
      }
    }
    child.once('exit', finish)
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        // v1.3.1: Windows used to taskkill /T /F immediately after SIGTERM,
        // which nullified the whole grace period. Force the tree only after
        // the player has had a real chance to close itself.
        if (isWindows() && child.pid) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true
            })
          } catch {
            /* best effort */
          }
        }
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      setTimeout(finish, 200)
    }, 1500)
  })
}
