/**
 * Opt-in debug log.
 *
 * The TUI owns the terminal (alternate screen, raw mode), so a normal
 * console.log is invisible at best and corrupts the frame at worst. Every
 * diagnostic therefore goes to a plain file, and only when the user asks for
 * it:
 *
 *   torrential --debug "severance"      → <cache dir>/torrential.log
 *   torrential --debug=/tmp/t.log …     → that path
 *   TORRENTIAL_DEBUG=1 torrential …     → <cache dir>/torrential.log
 *   TORRENTIAL_LOG=/tmp/t.log torrential …
 *
 * Logging is best effort by contract: a full disk or a read-only path must
 * never take the session down, so every failure here is swallowed after the
 * first warning.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Rotate (truncate) the log once it passes this size. */
const MAX_LOG_BYTES = 2_000_000

let activeFile: string | null = null
let writeFailed = false

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * Resolve the log destination from the CLI flag / environment without
 * touching the filesystem yet. Returns null when logging is off.
 *
 * `flag` mirrors --debug semantics: undefined = not given, '' = given
 * without a path (use the default), a string = explicit path.
 */
export function resolveLogPath(flag: string | undefined, defaultDir: string): string | null {
  const env = process.env.TORRENTIAL_LOG?.trim()
  if (flag !== undefined) {
    if (flag.trim().length > 0) return path.resolve(flag.trim())
    return path.join(defaultDir, 'torrential.log')
  }
  if (env) return path.resolve(env)
  const debugEnv = process.env.TORRENTIAL_DEBUG
  if (debugEnv !== undefined && debugEnv !== '0' && debugEnv.toLowerCase() !== 'false') {
    return path.join(defaultDir, 'torrential.log')
  }
  return null
}

/** Turn file logging on. Returns the path, or null when it cannot be used. */
export function enableFileLog(file: string): string | null {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Keep the file from growing forever across sessions: a fresh session
    // that finds an oversized log starts it over instead of appending.
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_LOG_BYTES) fs.truncateSync(file, 0)
    } catch {
      /* no file yet — fine */
    }
    // Create it eagerly: the CLI prints "debug log → path", and that path
    // should exist even before the first event is written.
    fs.closeSync(fs.openSync(file, 'a'))
    activeFile = file
    writeFailed = false
    return file
  } catch {
    activeFile = null
    return null
  }
}

export function isLogging(): boolean {
  return activeFile !== null
}

export function logFile(): string | null {
  return activeFile
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return /\s|=/.test(value) ? JSON.stringify(value) : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return JSON.stringify(value.message)
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[unserializable]'
    }
  }
  return String(value)
}

/**
 * Append one line: `2026-10-24T12:00:00.000Z  event  key=value …`.
 * Never throws, never writes to stdout/stderr (which would corrupt the TUI).
 */
export function log(event: string, data?: Record<string, unknown>): void {
  if (activeFile === null || writeFailed) return
  let line = `${new Date().toISOString()}  ${event}`
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      line += `  ${key}=${formatValue(value)}`
    }
  }
  try {
    fs.appendFileSync(activeFile, line + '\n', 'utf8')
  } catch {
    // One failure is enough: stop trying for the rest of the session so a
    // broken path cannot add latency to every stream tick.
    writeFailed = true
  }
}

/** Convenience for the common "something threw" case. */
export function logError(event: string, err: unknown, data?: Record<string, unknown>): void {
  const message = err instanceof Error ? err.message : String(err)
  log(`${event}:error`, { ...data, message })
}

/** Test hook: forget the configured file (used by unit tests only). */
export function resetLogForTests(): void {
  activeFile = null
  writeFailed = false
}
