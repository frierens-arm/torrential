/**
 * Metadata (`.torrent`) cache maintenance.
 *
 * The engine saves the info dict of every streamed torrent under
 * `<cache>/meta/<infoHash>.torrent` so a re-stream skips the metadata
 * round-trip. Nothing ever deleted those files, so a long-lived install grew
 * an unbounded pile of 20-200 KB files for torrents the user will never touch
 * again. Pruning runs once at boot and is deliberately conservative:
 *
 *   - only files inside `<cache>/meta` are ever considered
 *   - entries untouched for `maxAgeMs` (30 days) go first
 *   - then the oldest entries above `maxEntries` (300) go
 *   - every failure is swallowed: this is housekeeping, not a prerequisite
 */

import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.js'

export const META_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const META_MAX_ENTRIES = 300

export function metaCacheDir(cacheDir: string): string {
  return path.join(cacheDir, 'meta')
}

export function metaCachePath(cacheDir: string, infoHash: string): string {
  return path.join(metaCacheDir(cacheDir), `${infoHash}.torrent`)
}

export interface PruneOptions {
  /** Files older than this are removed regardless of the entry cap. */
  maxAgeMs?: number
  /** After the age pass, keep at most this many of the newest files. */
  maxEntries?: number
  /** Injectable clock (tests). */
  now?: number
  /** Report what would happen without deleting anything (tests, --doctor). */
  dryRun?: boolean
}

export interface PruneResult {
  /** Files deleted (or that would be, with dryRun). */
  removed: number
  /** Bytes reclaimed (or reclaimable). */
  bytes: number
  /** Files left in place. */
  kept: number
  /** Directory did not exist — nothing to do. */
  missing: boolean
}

/**
 * Prune the metadata cache. Synchronous and safe to call at boot; returns
 * counters instead of throwing so callers can log them and move on.
 */
export function pruneMetadataCache(cacheDir: string, opts: PruneOptions = {}): PruneResult {
  const dir = metaCacheDir(cacheDir)
  const maxAgeMs = opts.maxAgeMs ?? META_MAX_AGE_MS
  const maxEntries = opts.maxEntries ?? META_MAX_ENTRIES
  const now = opts.now ?? Date.now()
  const result: PruneResult = { removed: 0, bytes: 0, kept: 0, missing: false }

  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    result.missing = true
    return result
  }

  interface Entry {
    file: string
    mtime: number
    size: number
  }
  const entries: Entry[] = []
  for (const name of names) {
    if (!name.endsWith('.torrent')) continue
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      entries.push({ file, mtime: stat.mtimeMs, size: stat.size })
    } catch {
      /* vanished mid-scan — skip */
    }
  }

  const doomed = new Set<string>()
  for (const entry of entries) {
    if (now - entry.mtime > maxAgeMs) doomed.add(entry.file)
  }

  const survivors = entries
    .filter(entry => !doomed.has(entry.file))
    .sort((a, b) => b.mtime - a.mtime)
  for (const entry of survivors.slice(Math.max(0, maxEntries))) {
    doomed.add(entry.file)
  }

  for (const entry of entries) {
    if (!doomed.has(entry.file)) {
      result.kept++
      continue
    }
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(entry.file)
      } catch {
        result.kept++
        continue
      }
    }
    result.removed++
    result.bytes += entry.size
  }

  if (result.removed > 0) {
    log('cache:pruned', { dir, removed: result.removed, bytes: result.bytes, kept: result.kept })
  }
  return result
}
