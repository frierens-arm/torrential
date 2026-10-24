/**
 * Persistent, non-config session memory: recent searches and where you were
 * in each series.
 *
 * Kept separate from config.json on purpose — users hand-edit config, and a
 * watched-episode ledger rewritten on every stream would make that file churn
 * (and risk clobbering their edits mid-session). state.json is a cache-grade
 * file: losing it is annoying, not harmful, so every read/write is tolerant
 * and the app never blocks on it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { configDir } from '../config.js'
import { log } from './log.js'

export interface WatchedEntry {
  /** null = absolute-numbering bucket (anime-style shows). */
  season: number | null
  episode: number
  /** ISO timestamp of the last time this episode was streamed. */
  at: string
}

export interface SessionState {
  version: 1
  /** Most recent first, newest at index 0. */
  history: string[]
  /** seriesKey → last streamed episode. */
  watched: Record<string, WatchedEntry>
}

export const HISTORY_LIMIT = 20
/** Bound the ledger so a long-lived install cannot grow without limit. */
export const WATCHED_LIMIT = 200

export const EMPTY_STATE: SessionState = { version: 1, history: [], watched: {} }

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

export function statePath(): string {
  return path.join(configDir(), 'state.json')
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------ */

function isWatchedEntry(value: unknown): value is WatchedEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const seasonOk = entry.season === null || (typeof entry.season === 'number' && Number.isFinite(entry.season))
  return (
    seasonOk &&
    typeof entry.episode === 'number' &&
    Number.isFinite(entry.episode) &&
    typeof entry.at === 'string'
  )
}

/**
 * Validate anything that came off disk. Unknown shapes are dropped rather
 * than repaired, so a hand-mangled state.json degrades to "no history"
 * instead of throwing inside the TUI.
 */
export function normalizeState(raw: unknown): SessionState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY_STATE }
  const input = raw as Record<string, unknown>

  const history = Array.isArray(input.history)
    ? input.history
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map(q => q.trim())
        .filter((q, i, all) => all.indexOf(q) === i)
        .slice(0, HISTORY_LIMIT)
    : []

  const watched: Record<string, WatchedEntry> = {}
  if (typeof input.watched === 'object' && input.watched !== null && !Array.isArray(input.watched)) {
    for (const [key, entry] of Object.entries(input.watched as Record<string, unknown>)) {
      if (key.trim().length > 0 && isWatchedEntry(entry)) watched[key] = entry
    }
  }

  return { version: 1, history, watched: capWatched(watched) }
}

/** Newest N entries by timestamp — the ledger is bounded, not unbounded. */
function capWatched(watched: Record<string, WatchedEntry>): Record<string, WatchedEntry> {
  const keys = Object.keys(watched)
  if (keys.length <= WATCHED_LIMIT) return watched
  const keep = keys
    .sort((a, b) => (watched[b]?.at ?? '').localeCompare(watched[a]?.at ?? ''))
    .slice(0, WATCHED_LIMIT)
  const capped: Record<string, WatchedEntry> = {}
  for (const key of keep) {
    const entry = watched[key]
    if (entry) capped[key] = entry
  }
  return capped
}

/**
 * Push a query to the front of the history. Repeating an existing query
 * promotes it instead of duplicating it; slash commands are excluded by
 * the caller. Returns the same object when nothing would change so React
 * can skip a render.
 */
export function pushHistory(state: SessionState, query: string, limit = HISTORY_LIMIT): SessionState {
  const trimmed = query.trim()
  if (trimmed.length === 0) return state
  const history = [trimmed, ...state.history.filter(q => q !== trimmed)].slice(0, limit)
  if (history.length === state.history.length && history.every((q, i) => q === state.history[i])) {
    return state
  }
  return { ...state, history }
}

/** Remember the episode just streamed for a series. */
export function recordWatched(
  state: SessionState,
  seriesKey: string,
  entry: Omit<WatchedEntry, 'at'>,
  now = new Date()
): SessionState {
  const key = seriesKey.trim()
  if (key.length === 0) return state
  const watched = capWatched({
    ...state.watched,
    [key]: { season: entry.season, episode: entry.episode, at: now.toISOString() }
  })
  return { ...state, watched }
}

export function lastWatchedFor(state: SessionState, seriesKey: string): WatchedEntry | null {
  return state.watched[seriesKey] ?? null
}

/* ------------------------------------------------------------------ *
 * Disk IO (best effort)
 * ------------------------------------------------------------------ */

export function loadState(file = statePath()): SessionState {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return normalizeState(JSON.parse(raw) as unknown)
  } catch {
    return { ...EMPTY_STATE }
  }
}

export function saveState(state: SessionState, file = statePath()): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Write-then-rename so an interrupted write cannot leave a half file
    // that makes the next launch think every search errored.
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    log('state:save-failed', { file, message: err instanceof Error ? err.message : String(err) })
    return false
  }
}
