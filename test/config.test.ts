import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, loadConfig, normalizeModeName, saveConfig } from '../src/config.js'

function tempConfigFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-config-'))
  return path.join(dir, 'config.json')
}

function writeConfig(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

describe('loadConfig', () => {
  it('materializes defaults on first run', () => {
    const file = tempConfigFile()
    const result = loadConfig(file)
    assert.equal(result.created, true)
    assert.ok(fs.existsSync(file))
    assert.equal(result.config.port, DEFAULT_CONFIG.port)
    assert.equal(result.config.turbo, true)
    assert.deepEqual(result.warnings, [])
  })

  it('survives malformed JSON with defaults and a warning', () => {
    const file = tempConfigFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json', 'utf8')
    const result = loadConfig(file)
    assert.equal(result.config.turbo, DEFAULT_CONFIG.turbo)
    assert.ok(result.warnings.some(w => w.includes('not valid JSON')))
  })

  it('rejects out-of-range numbers instead of poisoning the session', () => {
    const file = tempConfigFile()
    writeConfig(file, { port: 70_000, max_conns: 1, ram_cache_mb: -5, search_timeout: 500 })
    const { config, warnings } = loadConfig(file)
    assert.equal(config.port, DEFAULT_CONFIG.port)
    assert.equal(config.max_conns, DEFAULT_CONFIG.max_conns)
    assert.equal(config.ram_cache_mb, DEFAULT_CONFIG.ram_cache_mb)
    assert.equal(config.search_timeout, DEFAULT_CONFIG.search_timeout)
    assert.equal(warnings.filter(w => w.startsWith('config:')).length, 4)
  })

  it('accepts valid values inside the documented range', () => {
    const file = tempConfigFile()
    writeConfig(file, { port: 9123, max_conns: 500, window_secs: 45, turbo: false, keep_cache: true })
    const { config, warnings } = loadConfig(file)
    assert.equal(config.port, 9123)
    assert.equal(config.max_conns, 500)
    assert.equal(config.window_secs, 45)
    assert.equal(config.turbo, false)
    assert.equal(config.keep_cache, true)
    assert.deepEqual(warnings, [])
  })

  it('drops unknown provider ids and suggests the near miss', () => {
    const file = tempConfigFile()
    writeConfig(file, { providers: ['1337'] })
    const { config, warnings } = loadConfig(file)
    assert.deepEqual(config.providers, DEFAULT_CONFIG.providers)
    assert.ok(warnings.some(w => w.includes('did you mean "1337x"')))
  })

  it('dedupes provider ids and drops unknown ones from a mixed list', () => {
    const file = tempConfigFile()
    writeConfig(file, { providers: ['nyaa', 'nyaa', 'piratebay', 'nope'] })
    const { config } = loadConfig(file)
    assert.deepEqual(config.providers, ['nyaa', 'piratebay'])
  })

  it('falls back to auto mode with a warning', () => {
    const file = tempConfigFile()
    writeConfig(file, { mode: 'series' })
    const { config, warnings } = loadConfig(file)
    assert.equal(config.mode, 'auto')
    assert.ok(warnings.some(w => w.includes('"mode"')))
  })

  it('reports unknown keys instead of silently ignoring them', () => {
    const file = tempConfigFile()
    writeConfig(file, { transmission_port: 51413 })
    const { warnings } = loadConfig(file)
    assert.ok(warnings.some(w => w.includes('unknown key "transmission_port"')))
  })

  it('warns on a non-boolean flag', () => {
    const file = tempConfigFile()
    writeConfig(file, { turbo: 'yes' })
    const { config, warnings } = loadConfig(file)
    assert.equal(config.turbo, DEFAULT_CONFIG.turbo)
    assert.ok(warnings.some(w => w.includes('"turbo"')))
  })

  it('round-trips through saveConfig', () => {
    const file = tempConfigFile()
    const base = loadConfig(file).config
    saveConfig({ ...base, default_player: 'mpv', theme: 'matrix', mode: 'tv' }, file)
    const reread = loadConfig(file).config
    assert.equal(reread.default_player, 'mpv')
    assert.equal(reread.theme, 'matrix')
    assert.equal(reread.mode, 'tv')
  })
})

describe('normalizeModeName', () => {
  it('accepts the closed set case-insensitively', () => {
    assert.equal(normalizeModeName('AUTO'), 'auto')
    assert.equal(normalizeModeName(' tv '), 'tv')
    assert.equal(normalizeModeName('movies'), 'movies')
  })

  it('rejects anything else', () => {
    assert.equal(normalizeModeName('series'), null)
    assert.equal(normalizeModeName(''), null)
  })
})
