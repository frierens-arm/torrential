/**
 * `torrential --doctor` — one plain-text pass over everything that has to be
 * true for a stream to work, in the order it usually breaks.
 *
 * The TUI hides diagnostics by design (alternate screen, one frame at a
 * time), so the everyday failures — a blocked indexer, a missing player, a
 * read-only cache dir, a port already taken, the wrong Node — used to need a
 * screenshot and a guess. This command answers them directly, is safe to paste
 * into a bug report, and never enters the TUI or touches the network for more
 * than a single tiny probe query per source.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { VERSION } from './version.js'
import {
  configPath,
  defaultCacheDir,
  defaultKeepDir,
  type LoadConfigResult,
  type TorrentialConfig
} from './config.js'
import { ALL_PROVIDERS, providerById } from './providers/index.js'
import { cachedInstalledPlayers, systemOpener } from './utils/players.js'
import { metaCacheDir } from './utils/cache.js'
import { formatBytes } from './utils/format.js'
import { logFile } from './utils/log.js'

export interface DoctorOptions {
  config: TorrentialConfig
  /** loadConfig() result, so its warnings can be echoed verbatim. */
  loaded?: LoadConfigResult
  /** Skip the indexer probes (offline runs, CI). */
  skipProviders?: boolean
  /** Per-provider probe budget in milliseconds. */
  providerTimeoutMs?: number
  /** Injected for tests: the command prints through this instead of stdout. */
  print?: (line?: string) => void
}

export interface DoctorResult {
  ok: boolean
  failures: string[]
  warnings: string[]
}

const PROBE_QUERY = 'sintel'

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const out = opts.print ?? ((line = ''): void => void process.stdout.write(line + '\n'))
  const failures: string[] = []
  const warnings: string[] = []
  const { config } = opts

  const section = (title: string): void => {
    out('')
    out(`  ${title}`)
  }
  const ok = (label: string, detail = ''): void => out(`    ✓ ${label}${detail ? '  ' + detail : ''}`)
  const warn = (label: string, detail = ''): void => {
    warnings.push(label)
    out(`    ⚠ ${label}${detail ? '  ' + detail : ''}`)
  }
  const bad = (label: string, detail = ''): void => {
    failures.push(label)
    out(`    ✗ ${label}${detail ? '  ' + detail : ''}`)
  }

  out(`torrential ${VERSION} — doctor`)
  out(`  ${process.platform} ${os.release()} · ${os.arch()} · node ${process.version}`)

  /* ── runtime ─────────────────────────────────────────────────── */
  section('runtime')
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  if (nodeMajor >= 22) ok('Node.js', `v${process.versions.node}`)
  else bad('Node.js is too old', `v${process.versions.node} — webtorrent@3 needs ≥ 22 (nvm install 22)`)

  /* ── paths ───────────────────────────────────────────────────── */
  section('paths')
  const cacheDir = path.resolve(config.cache_directory || defaultCacheDir())
  const keepDir = path.resolve(config.keep_directory || defaultKeepDir())
  out(`    config   ${configPath()}`)
  out(`    cache    ${cacheDir}`)
  out(`    keep     ${keepDir}`)

  if (fs.existsSync(configPath())) ok('config file present')
  else warn('no config file yet', 'it is created with defaults on first run')

  for (const warning of opts.loaded?.warnings ?? []) warn(`config: ${warning}`)

  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    const probe = path.join(cacheDir, `.doctor-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    ok('cache directory is writable')
  } catch (err) {
    bad('cache directory is not writable', (err as Error).message)
  }

  try {
    const statfs = fs.statfsSync(cacheDir)
    const free = Number(statfs.bavail) * Number(statfs.bsize)
    const line = `free ${formatBytes(free)}`
    if (free < 1_000_000_000) warn('less than 1 GB free on the cache volume', line)
    else ok('disk space', line)
  } catch {
    /* statfs is not available everywhere — not worth a warning */
  }

  const metaDir = metaCacheDir(cacheDir)
  let metaCount = 0
  let metaBytes = 0
  try {
    for (const name of fs.readdirSync(metaDir)) {
      try {
        const stat = fs.statSync(path.join(metaDir, name))
        metaCount++
        metaBytes += stat.size
      } catch {
        /* skip */
      }
    }
    out(`    meta     ${metaCount} torrents · ${formatBytes(metaBytes)}`)
  } catch {
    out('    meta     (empty — nothing streamed yet)')
  }

  /* ── players ─────────────────────────────────────────────────── */
  section('player')
  const players = cachedInstalledPlayers()
  if (players.length > 0) {
    for (const p of players) out(`    ✓ ${p.name.padEnd(6)} ${p.command}  [${p.how}]`)
  } else {
    warn('no standalone player detected', 'install mpv or vlc, or set default_player')
  }
  out(`    preference ${config.default_player}${config.player_flags.length > 0 ? ` · flags ${config.player_flags.join(' ')}` : ''}`)
  const opener = systemOpener()
  out(`    URL opener ${opener ? opener.command : 'unavailable'}`)

  const preferred = config.default_player.trim()
  if (preferred && preferred !== 'system') {
    const known = players.some(p => p.name.toLowerCase() === preferred.toLowerCase())
    const looksLikePath = preferred.includes('/') || preferred.includes('\\')
    if (!known && !looksLikePath) {
      warn(`default_player "${preferred}" is not installed here`, 'run --list-players')
    }
  }

  /* ── stream server ───────────────────────────────────────────── */
  section('stream server')
  const port = config.port
  const v4Free = await probePort(port, '127.0.0.1')
  const dualFree = await probePort(port, '::')
  if (v4Free || dualFree) ok(`port ${port} is free`, `(${dualFree ? 'dual-stack' : 'loopback only'} bind)`)
  else warn(`port ${port} is in use`, 'torrential probes nearby ports automatically; pin another with --port')
  if (config.turbo) ok('turbo serving layer enabled')
  else out('    turbo disabled (--no-turbo) — using the plain webtorrent server')

  /* ── indexers ────────────────────────────────────────────────── */
  section('indexers')
  const enabled = config.providers
  for (const id of enabled) {
    if (!providerById(id)) {
      warn(`unknown source "${id}"`, `valid: ${ALL_PROVIDERS.map(p => p.info.id).join(', ')}`)
    }
  }
  if (opts.skipProviders) {
    out('    skipped (--doctor --offline)')
  } else {
    const timeout = opts.providerTimeoutMs ?? Math.max(5000, config.search_timeout * 1000)
    const results = await Promise.all(
      enabled.map(async id => {
        const provider = providerById(id)
        if (!provider) return { id, state: 'unknown' as const, rows: 0, ms: 0, error: 'unknown id' }
        const startedAt = Date.now()
        try {
          const rows = await provider.search(PROBE_QUERY, {
            timeoutMs: timeout,
            x1337Mirrors: config.x1337_mirrors,
            mode: config.mode
          })
          return { id, state: 'ok' as const, rows: rows.length, ms: Date.now() - startedAt, error: null }
        } catch (err) {
          return {
            id,
            state: 'error' as const,
            rows: 0,
            ms: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err)
          }
        }
      })
    )
    for (const r of results) {
      const label = providerById(r.id)?.info.label ?? r.id
      if (r.state === 'ok') {
        ok(`${label.padEnd(10)} answered in ${r.ms} ms`, `${r.rows} row${r.rows === 1 ? '' : 's'}`)
      } else {
        warn(`${label.padEnd(10)} failed after ${r.ms} ms`, r.error ?? 'unknown error')
      }
    }
    if (results.length > 0 && results.every(r => r.state === 'error')) {
      bad('no indexer is reachable', 'check your connection / VPN, or try --sources')
    }
  }

  /* ── hints ───────────────────────────────────────────────────── */
  section('next steps')
  const log = logFile()
  if (log) out(`    debug log goes to ${log}`)
  else out('    no debug log this run — start with --debug to write one')
  out('    bugs: include the output above (and the debug log) in the report')

  out('')
  if (failures.length > 0) {
    out(`  ${failures.length} problem${failures.length === 1 ? '' : 's'} found — see the ✗ lines above`)
  } else if (warnings.length > 0) {
    out(`  usable, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`)
  } else {
    out('  all clear — everything a stream needs is in place')
  }
  out('')

  return { ok: failures.length === 0, failures, warnings }
}

/** Can we bind this port on this host? A success closes it immediately. */
function probePort(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    let done = false
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      try {
        server.close()
      } catch {
        /* already closed */
      }
      resolve(value)
    }
    server.once('error', () => finish(false))
    server.once('listening', () => finish(true))
    try {
      server.listen({ port, host })
    } catch {
      finish(false)
    }
  })
}
