import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  META_MAX_AGE_MS,
  metaCacheDir,
  metaCachePath,
  pruneMetadataCache
} from '../src/utils/cache.js'

const DAY = 24 * 60 * 60 * 1000

function fixture(entries: Array<{ name: string; ageDays: number; size?: number }>): string {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-cache-'))
  const dir = metaCacheDir(cache)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    fs.writeFileSync(file, Buffer.alloc(entry.size ?? 10))
    const mtime = new Date(now - entry.ageDays * DAY)
    fs.utimesSync(file, mtime, mtime)
  }
  return cache
}

describe('meta paths', () => {
  it('lays .torrent files out under <cache>/meta', () => {
    assert.equal(metaCachePath('/tmp/c', 'abc'), path.join('/tmp/c', 'meta', 'abc.torrent'))
    assert.equal(metaCacheDir('/tmp/c'), path.join('/tmp/c', 'meta'))
  })
})

describe('pruneMetadataCache', () => {
  it('reports a missing directory instead of creating one', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-cache-'))
    const result = pruneMetadataCache(cache)
    assert.equal(result.missing, true)
    assert.equal(result.removed, 0)
    assert.ok(!fs.existsSync(metaCacheDir(cache)))
  })

  it('removes entries older than the age limit', () => {
    const cache = fixture([
      { name: 'old.torrent', ageDays: 40 },
      { name: 'fresh.torrent', ageDays: 1 }
    ])
    const result = pruneMetadataCache(cache)
    assert.equal(result.removed, 1)
    assert.equal(result.kept, 1)
    assert.equal(result.bytes, 10)
    assert.deepEqual(fs.readdirSync(metaCacheDir(cache)), ['fresh.torrent'])
  })

  it('caps the directory by dropping the oldest survivors', () => {
    const cache = fixture([
      { name: 'a.torrent', ageDays: 3 },
      { name: 'b.torrent', ageDays: 2 },
      { name: 'c.torrent', ageDays: 1 }
    ])
    const result = pruneMetadataCache(cache, { maxEntries: 2 })
    assert.equal(result.removed, 1)
    assert.deepEqual(fs.readdirSync(metaCacheDir(cache)).sort(), ['b.torrent', 'c.torrent'])
  })

  it('never touches non-torrent files or subdirectories', () => {
    const cache = fixture([{ name: 'keep.torrent', ageDays: 1 }])
    const dir = metaCacheDir(cache)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi')
    fs.mkdirSync(path.join(dir, 'nested'))
    pruneMetadataCache(cache, { maxAgeMs: 0 })
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')))
    assert.ok(fs.existsSync(path.join(dir, 'nested')))
  })

  it('dryRun reports without deleting', () => {
    const cache = fixture([{ name: 'old.torrent', ageDays: 40 }])
    const result = pruneMetadataCache(cache, { dryRun: true })
    assert.equal(result.removed, 1)
    assert.equal(result.kept, 0)
    assert.deepEqual(fs.readdirSync(metaCacheDir(cache)), ['old.torrent'])
  })

  it('uses a 30-day default age', () => {
    assert.equal(META_MAX_AGE_MS, 30 * DAY)
    const cache = fixture([
      { name: 'just-inside.torrent', ageDays: 29 },
      { name: 'just-outside.torrent', ageDays: 31 }
    ])
    pruneMetadataCache(cache)
    assert.deepEqual(fs.readdirSync(metaCacheDir(cache)), ['just-inside.torrent'])
  })
})
