import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { enableFileLog, isLogging, log, logFile, resetLogForTests, resolveLogPath } from '../src/utils/log.js'

const saved = {
  TORRENTIAL_DEBUG: process.env.TORRENTIAL_DEBUG,
  TORRENTIAL_LOG: process.env.TORRENTIAL_LOG
}

beforeEach(() => {
  delete process.env.TORRENTIAL_DEBUG
  delete process.env.TORRENTIAL_LOG
  resetLogForTests()
})

afterEach(() => {
  resetLogForTests()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const DEFAULT_DIR = path.join(os.tmpdir(), 'torrential-logs')

describe('resolveLogPath', () => {
  it('is off unless asked for', () => {
    assert.equal(resolveLogPath(undefined, DEFAULT_DIR), null)
    assert.equal(resolveLogPath(undefined, DEFAULT_DIR), null)
  })

  it('uses the cache directory for a bare --debug', () => {
    assert.equal(resolveLogPath('', DEFAULT_DIR), path.join(DEFAULT_DIR, 'torrential.log'))
  })

  it('honours an explicit --debug=<path>', () => {
    assert.equal(resolveLogPath('relative/t.log', DEFAULT_DIR), path.resolve('relative/t.log'))
  })

  it('reads TORRENTIAL_LOG and TORRENTIAL_DEBUG', () => {
    process.env.TORRENTIAL_LOG = '/tmp/from-env.log'
    assert.equal(resolveLogPath(undefined, DEFAULT_DIR), path.resolve('/tmp/from-env.log'))
    delete process.env.TORRENTIAL_LOG

    process.env.TORRENTIAL_DEBUG = '1'
    assert.equal(resolveLogPath(undefined, DEFAULT_DIR), path.join(DEFAULT_DIR, 'torrential.log'))
    process.env.TORRENTIAL_DEBUG = '0'
    assert.equal(resolveLogPath(undefined, DEFAULT_DIR), null)
  })

  it('prefers the CLI flag over the environment', () => {
    process.env.TORRENTIAL_LOG = '/tmp/from-env.log'
    assert.equal(resolveLogPath('', DEFAULT_DIR), path.join(DEFAULT_DIR, 'torrential.log'))
  })
})

describe('file logging', () => {
  it('creates the directory and appends structured lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-log-'))
    const file = path.join(dir, 'nested', 'torrential.log')
    assert.equal(enableFileLog(file), file)
    assert.equal(isLogging(), true)
    assert.equal(logFile(), file)

    log('search:start', { queries: ['the bear'], providers: ['nyaa'] })
    log('stream:ready', { bytes: 1234, turbo: true, error: null })

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+search:start\s+queries=\[.*\]\s+providers=\[.*\]$/)
    assert.match(lines[1]!, /bytes=1234/)
    assert.match(lines[1]!, /turbo=true/)
    assert.match(lines[1]!, /error=null/)
  })

  it('quotes values containing spaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-log-'))
    const file = path.join(dir, 't.log')
    enableFileLog(file)
    log('e', { message: 'two words' })
    assert.match(fs.readFileSync(file, 'utf8'), /message="two words"/)
  })

  it('goes quiet instead of throwing when the path is unusable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-log-'))
    fs.mkdirSync(path.join(dir, 'as-dir'))
    const file = path.join(dir, 'as-dir') // a directory, not a file
    enableFileLog(file)
    // Either enableFileLog refused it or the append silently failed — the
    // contract is "never throws".
    assert.doesNotThrow(() => log('still-alive'))
  })

  it('does nothing when logging is off', () => {
    assert.doesNotThrow(() => log('nobody-hears'))
  })
})
