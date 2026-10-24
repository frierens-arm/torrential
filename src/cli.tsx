#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { render } from 'ink'
import React from 'react'
import { App } from './ui/App.js'
import { loadConfig, saveConfig, configPath, configDir, defaultCacheDir, defaultKeepDir, normalizeModeName, type TorrentialConfig } from './config.js'
import { VERSION, NAME, TAGLINE } from './version.js'
import { detectInstalledPlayers, cachedInstalledPlayers, systemOpener, findOnPath } from './utils/players.js'
import { looksLikeTorrentId } from './utils/magnet.js'
import { parseSourcesFlag } from './utils/sources.js'
import { setTheme, normalizeThemeName, themeList, DEFAULT_THEME_ID } from './themes.js'
import { MODE_IDS } from './constants.js'
import type { SearchMode } from './types.js'
import { EngineHost } from './engine/host.js'
import { runDoctor } from './doctor.js'
import { enableFileLog, log, resolveLogPath } from './utils/log.js'
import { pruneMetadataCache } from './utils/cache.js'

/* ------------------------------------------------------------------ *
 * Argument parsing (hand-rolled, zero deps)
 * ------------------------------------------------------------------ */

interface CliArgs {
  query: string
  magnet?: string
  player?: string
  port?: number
  sources?: string
  sourceList?: string[]
  keep: boolean
  keepDir?: string
  noPlayer: boolean
  listPlayers: boolean
  config?: string
  keepCache: boolean
  clearCache: boolean
  turbo?: boolean
  maxConns?: number
  uploadLimit?: number
  ramCache?: number
  theme?: string
  mode?: SearchMode
  /** --default-player / -df: '' = flag given without a value (show mode). */
  defaultPlayer?: string
  /** --debug[=<path>]: '' = default log path, undefined = logging off. */
  debug?: string
  /** --doctor: print the environment report and exit. */
  doctor: boolean
  /** --offline: skip the network probes (doctor). */
  offline: boolean
  help: boolean
  version: boolean
}

const HELP = `
  torrential ${VERSION} — ${TAGLINE}

  USAGE
    torrential [query] [options]

  Search a show & stream episodes (TUI):
    torrential                       # dive straight into the search bar
    torrential "breaking bad"        # start a show hunt immediately
    # results group into series → seasons → episodes / season packs

  Stream without searching:
    torrential --magnet "magnet:?xt=urn:btih:…"
    torrential --magnet <40-char info-hash>

  OPTIONS
    -m, --magnet <uri>      stream this magnet / info-hash directly
    -p, --player <name>     player for this session: system | mpv | vlc | iina | /path/to/binary
        --port <1-65535>    local streaming port (default 8000)
    -k, --keep[=<dir>]      save the streamed episode when playback ends
                            (default: ~/Movies/torrential on macOS,
                             ~/Videos/torrential elsewhere)
        --keep-dir <path>   where --keep parks files (also config "keep_directory")
        --sources <list>    comma list to search this session: tpb, 1337x, nyaa
        --mode <name>       content mode for this session: auto (default,
                            shows + movies), tv, or movies. /mode in the
                            search bar shows, applies and saves it
        --no-player         do not launch a player; show the stream URL only
        --keep-cache        keep raw cache pieces after exit (advanced)
        --clear-cache       wipe the whole cache directory, then run
        --doctor            check Node, config, cache, players, the stream
                            port and every indexer, then print a report
        --offline           skip network probes (with --doctor; also for
                            fully offline checks)
        --debug[=<path>]    write a diagnostic log (default:
                            <cache dir>/torrential.log). Also enabled by
                            TORRENTIAL_DEBUG=1 or TORRENTIAL_LOG=<path>

  Speed (defaults are already tuned — tweak for your network):
        --turbo / --no-turbo    turbo serving: playhead-driven piece windows
                                (on by default; --no-turbo = plain webtorrent
                                server)
        --max-conns <5-2000>    peer connections per torrent (default 200)
        --upload-limit <kbps>   cap upload; 0 = unlimited (default). Capping
                                helps slow asymmetric (ADSL/cable) links
        --ram-cache <mb>        RAM piece cache budget (default 256, 0 = off)

  Preferences (persisted to config):
        --default-player, -df <name>
                                set the default player once and for all:
                                torrential -df iina. No value = show current.
                                accepts system, mpv, vlc, iina, anything on
                                your PATH, or a full binary path
        --theme, --skin <name>  UI skin for this session (rain, matrix,
                                sunset, ocean, ember, candy, amber, mono).
                                /theme in the search bar opens a live picker:
                                ↑↓ or j/k move · ⏎ apply + save · esc close;
                                /theme <name> applies it directly

  -c, --config <path>     use this config file instead of the default
        --list-players      show detected players and exit
    -h, --help              this help
    -v, --version           version

  KEYBINDINGS
    j/k or ↑/↓              navigate (series, seasons, episodes, files)
    ⏎                       open the highlighted row (season → episodes →
                            torrent pre-flight → stream)
    n / p                   cycle next / previous torrent for an episode
    g / G                   jump to top / bottom
    PgUp / PgDn             page through long episode lists
    q / b / esc             back one tier (or stop the stream)
    ctrl+c                  quit (stops engine; files are wiped unless --keep)

  TV flow: multi-file season packs open an interactive file picker so you
  stream the exact episode file. Thin results automatically re-query every
  source with SxxExx / 1xx nomenclature until episodes surface.

  Search bar also accepts pasted magnet links, bare info-hashes and
  slash commands: /theme · /theme <name> · /theme list (alias /skin) ·
  /mode · /mode <auto|tv|movies>.

  Config: ${'~/.config/torrential/config.json'}
  Docs:   https://github.com/frierens-arm/torrential
`.trimStart()

function fail(message: string, code = 1): never {
  process.stderr.write(`torrential: ${message}\n(try --help)\n`)
  process.exit(code)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    query: '',
    keep: false,
    noPlayer: false,
    listPlayers: false,
    keepCache: false,
    clearCache: false,
    doctor: false,
    offline: false,
    help: false,
    version: false
  }
  const positional: string[] = []
  const needsValue: Record<string, keyof CliArgs> = {
    '--magnet': 'magnet',
    '-m': 'magnet',
    '--player': 'player',
    '-p': 'player',
    '--port': 'port',
    '--config': 'config',
    '-c': 'config',
    '--sources': 'sources',
    '--keep-dir': 'keepDir',
    '--max-conns': 'maxConns',
    '--upload-limit': 'uploadLimit',
    '--ram-cache': 'ramCache',
    '--theme': 'theme',
    '--skin': 'theme',
    '--mode': 'mode'
  }
  // These accept an omitted value: `torrential --default-player` with no
  // value just SHOWS the current setting instead of erroring.
  const optionalValue = new Set(['--default-player', '--set-player', '-df'])

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    let inlineValue: string | undefined

    const eq = arg.indexOf('=')
    if (eq > 0 && arg.startsWith('--')) {
      inlineValue = arg.slice(eq + 1)
      arg = arg.slice(0, eq)
    }

    if (arg === '-h' || arg === '--help') {
      args.help = true
      continue
    }
    if (arg === '-v' || arg === '--version') {
      args.version = true
      continue
    }
    if (arg === '--no-player') {
      args.noPlayer = true
      continue
    }
    if (arg === '--list-players') {
      args.listPlayers = true
      continue
    }
    if (arg === '--doctor') {
      args.doctor = true
      continue
    }
    if (arg === '--offline') {
      args.offline = true
      continue
    }
    if (arg === '--debug') {
      // A value is only accepted inline (--debug=/tmp/t.log) so a query typed
      // after --debug is never mistaken for a path.
      args.debug = inlineValue ?? ''
      continue
    }
    if (arg === '--keep-cache') {
      args.keepCache = true
      continue
    }
    if (arg === '--clear-cache') {
      args.clearCache = true
      continue
    }
    if (arg === '--turbo') {
      args.turbo = true
      continue
    }
    if (arg === '--no-turbo') {
      args.turbo = false
      continue
    }
    if (arg === '-k' || arg === '--keep') {
      args.keep = true
      if (inlineValue !== undefined && inlineValue.trim().length > 0) {
        args.keepDir = inlineValue
      }
      continue
    }
    if (optionalValue.has(arg)) {
      const value = inlineValue ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : undefined)
      args.defaultPlayer = value !== undefined ? value : ''
      continue
    }

    const valueKey = needsValue[arg]
    if (valueKey) {
      const value = inlineValue ?? argv[++i]
      if (value === undefined) fail(`${arg} expects a value`)
      if (valueKey === 'port') {
        const port = Number.parseInt(value, 10)
        if (!Number.isFinite(port) || port < 1 || port > 65535) fail(`--port must be 1..65535`)
        args.port = port
      } else if (valueKey === 'maxConns') {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 5 || n > 2000) fail('--max-conns must be 5..2000')
        args.maxConns = n
      } else if (valueKey === 'uploadLimit') {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 0 || n > 10_000_000) fail('--upload-limit must be 0..10000000 kbps')
        args.uploadLimit = n
      } else if (valueKey === 'ramCache') {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 0 || n > 8192) fail('--ram-cache must be 0..8192 MB')
        args.ramCache = n
      } else if (valueKey === 'magnet') {
        args.magnet = value
      } else if (valueKey === 'player') {
        args.player = value
      } else if (valueKey === 'theme') {
        const id = normalizeThemeName(value)
        if (!id) {
          fail(
            `unknown skin "${value}" — available: ${themeList().map(t => t.id).join(', ')} ` +
              '(aliases like red/pink/blue/green also work)'
          )
        }
        args.theme = id
      } else if (valueKey === 'mode') {
        const id = normalizeModeName(value)
        if (!id) fail(`unknown mode "${value}" — available: ${MODE_IDS.join(', ')}`)
        args.mode = id
      } else if (valueKey === 'config') {
        args.config = value
      } else if (valueKey === 'sources') {
        args.sources = value
      } else {
        args.keepDir = value
      }
      continue
    }

    if (arg.startsWith('-') && arg !== '-') {
      fail(`unknown option "${arg}"`)
    }
    positional.push(arg)
  }

  args.query = positional.join(' ').trim()
  if (args.magnet && !looksLikeTorrentId(args.magnet)) {
    fail('--magnet expects a magnet URI, an info-hash, or a .torrent URL')
  }
  if (args.sources) {
    const parsed = parseSourcesFlag(args.sources)
    if (!parsed.providers) fail(parsed.error ?? 'invalid --sources value')
    args.sourceList = parsed.providers
  }
  return args
}

/* ------------------------------------------------------------------ *
 * Utility commands that never enter the TUI
 * ------------------------------------------------------------------ */

/**
 * Validate a --default-player value against reality: 'system', a detected
 * player, anything on PATH, or an executable path. Returns the canonical
 * name to persist, or a failure message with suggestions.
 */
function resolvePlayerChoice(input: string): { ok: true; name: string } | { ok: false; reason: string; suggestions: string } {
  const value = input.trim()
  if (value.length === 0) return { ok: false, reason: 'player name is empty', suggestions: 'system, mpv, vlc, iina' }

  if (/^system$/i.test(value)) return { ok: true, name: 'system' }

  // Known players, matched on their friendly name (iina-cli counts as iina).
  const detected = detectInstalledPlayers()
  const lowered = value.toLowerCase()
  for (const p of detected) {
    if (p.name.toLowerCase() === lowered) return { ok: true, name: p.name }
  }

  // Any other binary on PATH (mpv.net, celluloid, mpc-hc64…).
  if (!value.includes('/') && !value.includes('\\')) {
    if (findOnPath(value)) return { ok: true, name: value }
    return {
      ok: false,
      reason: `"${value}" is not installed (not found on PATH or in standard locations)`,
      suggestions:
        detected.map(p => p.name).concat(['system']).join(', ') + ' — or a full binary path'
    }
  }

  // A path: must exist and be executable.
  try {
    fs.accessSync(value, fs.constants.X_OK)
    return { ok: true, name: value }
  } catch {
    return { ok: false, reason: `"${value}" is not an executable file`, suggestions: 'check the path, or use system/mpv/vlc/iina' }
  }
}

/**
 * --default-player / -df: one command, persistent preference.
 *   torrential -df iina      validate + write config.default_player, exit
 *   torrential --default-player   show the current setting + choices, exit
 */
function runSetDefaultPlayer(value: string, explicitPath?: string): void {
  const out = (text = ''): void => {
    process.stdout.write(text + '\n')
  }
  const { config } = loadConfig(explicitPath)

  // Show mode (no value given).
  if (value === '') {
    out(`torrential ${VERSION} — default player`)
    out('')
    out(`  current: ${config.default_player}`)
    out('')
    const players = detectInstalledPlayers()
    out(players.length > 0 ? '  detected on this machine:' : '  no standalone players detected')
    for (const p of players) out(`    ${p.name.padEnd(6)} ${p.command}`)
    out('')
    out('  set it with: torrential --default-player <system|mpv|vlc|iina|/path>')
    out(`  config: ${configPath()}`)
    return
  }

  const choice = resolvePlayerChoice(value)
  if (!choice.ok) {
    out(`torrential: ${choice.reason}`)
    out(`  try: ${choice.suggestions}`)
    process.exit(1)
  }

  saveConfig({ ...config, default_player: choice.name }, explicitPath)
  out(`✓ default player set to ${choice.name}`)
  out(`  saved → ${explicitPath ?? configPath()}`)
  out('  it now applies to every session — override once with --player <name>')
}

function runListPlayers(): void {
  const out = (text = ''): void => {
    process.stdout.write(text + '\n')
  }
  out(`torrential ${VERSION} — player detection`)
  out('')
  const players = detectInstalledPlayers()
  if (players.length === 0) {
    out('  no standalone players found on PATH or in standard locations')
  } else {
    for (const p of players) {
      out(`  ${p.name.padEnd(6)} ${p.command}   [${p.how}]`)
    }
  }
  out('')
  const opener = systemOpener()
  out(
    opener
      ? `  system default: ${opener.name} (${opener.command})`
      : '  system default: not available (install xdg-open or set default_player)'
  )
  out('')
  out(`  config: ${configPath()}`)
  out(`  cache:  ${defaultCacheDir()}`)
  out('')
  out('tip: mpv streams HTTP progressively and starts fastest —')
  out('     brew install mpv | apt install mpv | winget install mpv')
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    process.stdout.write(HELP + '\n')
    return
  }
  if (args.version) {
    process.stdout.write(`torrential ${VERSION}\n`)
    return
  }
  if (args.listPlayers) {
    runListPlayers()
    return
  }
  if (args.doctor) {
    const loaded = loadConfig(args.config)
    const logPath = resolveLogPath(args.debug, loaded.config.cache_directory)
    if (logPath !== null && enableFileLog(logPath) !== null) {
      log('doctor:start', { offline: args.offline, node: process.version, platform: process.platform })
    }
    void runDoctor({ config: loaded.config, loaded, skipProviders: args.offline }).then(result => {
      process.exitCode = result.ok ? 0 : 1
    })
    return
  }
  if (args.defaultPlayer !== undefined) {
    runSetDefaultPlayer(args.defaultPlayer, args.config)
    return
  }

  const { config, warnings } = loadConfig(args.config)

  const merged: TorrentialConfig = {
    ...config,
    port: args.port ?? config.port,
    default_player: args.player ?? config.default_player,
    keep_cache: args.keepCache || config.keep_cache,
    providers: args.sourceList ?? config.providers,
    mode: args.mode ?? config.mode,
    keep_directory: args.keepDir ?? config.keep_directory ?? defaultKeepDir(),
    turbo: args.turbo ?? config.turbo,
    max_conns: args.maxConns ?? config.max_conns,
    upload_limit_kbps: args.uploadLimit ?? config.upload_limit_kbps,
    ram_cache_mb: args.ramCache ?? config.ram_cache_mb
  }

  if (args.clearCache) {
    try {
      fs.rmSync(path.resolve(merged.cache_directory), { recursive: true, force: true })
      process.stdout.write(`cache wiped: ${merged.cache_directory}\n`)
    } catch (err) {
      process.stderr.write(`could not wipe cache: ${(err as Error).message}\n`)
    }
  }

  // ── debug log (opt-in) ──
  // The TUI owns the terminal (alternate screen + raw mode), so a diagnostic
  // line printed the normal way is invisible at best and corrupts the frame
  // at worst. Everything goes to a file instead — see utils/log.ts.
  const logPath = resolveLogPath(args.debug, merged.cache_directory)
  if (logPath !== null) {
    const active = enableFileLog(logPath)
    if (active !== null) {
      process.stderr.write(`debug log → ${active}\n`)
      log('boot', {
        version: VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        config: args.config ?? configPath(),
        cache: merged.cache_directory,
        providers: merged.providers,
        mode: merged.mode,
        turbo: merged.turbo,
        port: merged.port
      })
      for (const warning of warnings) log('config:warning', { message: warning })
    } else {
      process.stderr.write(`could not write the debug log at ${logPath}\n`)
    }
  }

  // Metadata housekeeping: drop .torrent files nobody touched in a month and
  // cap the directory, so repeat streams stay fast without the cache growing
  // forever. Best effort — a failure here must never block a session.
  try {
    pruneMetadataCache(merged.cache_directory)
  } catch {
    /* housekeeping only */
  }

  // Skin: --theme wins over config.theme; unknown config values fall back
  // to the default with a gentle warning (never block the TUI on it).
  let activeTheme: string | null = null
  if (args.theme) {
    activeTheme = normalizeThemeName(args.theme)
  } else if (merged.theme) {
    activeTheme = normalizeThemeName(merged.theme)
    if (!activeTheme) {
      warnings.push(`config: unknown theme "${merged.theme}" — available: ${themeList().map(t => t.id).join(', ')} (or run /theme in the search bar)`)
      activeTheme = DEFAULT_THEME_ID
    }
  }
  if (activeTheme) setTheme(activeTheme)

  // Pre-warm everything the first stream will need: the WebTorrent client
  // (DHT bootstrap + tracker announces happen while the user is still in the
  // search bar) and the player-detection scan.
  const host = new EngineHost({
    maxConns: merged.max_conns,
    uploadLimitBytesPerSec:
      merged.upload_limit_kbps > 0 ? Math.round((merged.upload_limit_kbps * 1000) / 8) : -1
  })
  void cachedInstalledPlayers()

  // Bridge SIGINT to the in-app teardown path (raw mode swallows ctrl+c).
  let appShutdown: (() => Promise<void>) | null = null
  let sigintHit = false
  process.on('SIGINT', () => {
    if (sigintHit) {
      process.exit(130)
      return
    }
    sigintHit = true
    log('sigint')
    if (appShutdown) {
      void appShutdown().finally(() => process.exit(0))
      setTimeout(() => process.exit(0), 3500).unref?.()
    } else {
      process.exit(130)
    }
  })

  render(
    <App
      config={merged}
      host={host}
      initialQuery={args.query}
      magnetArg={args.magnet}
      noPlayer={args.noPlayer}
      playerOverride={args.player}
      keep={args.keep}
      warnings={warnings}
      configFile={args.config}
      onRegisterShutdown={fn => {
        appShutdown = fn
      }}
    />,
    { exitOnCtrlC: false }
  )
}

process.on('unhandledRejection', err => {
  process.stderr.write(`torrential: unexpected error — ${(err as Error)?.message ?? err}\n`)
  process.exitCode = 1
})

// Piped invocations (`torrential --help | less`) must not crash on EPIPE.
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

main()
