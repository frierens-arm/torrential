import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSlashCommand } from '../src/utils/commands.js'

describe('parseSlashCommand', () => {
  it('leaves ordinary searches alone', () => {
    assert.equal(parseSlashCommand('breaking bad'), null)
    assert.equal(parseSlashCommand('  s02e05  '), null)
  })

  it('opens the picker for bare theme commands', () => {
    for (const text of ['/theme', '/skin', '/theme list', '/theme ?', '/THEME']) {
      assert.deepEqual(parseSlashCommand(text), { kind: 'theme' })
    }
  })

  it('parses a theme argument case-insensitively', () => {
    assert.deepEqual(parseSlashCommand('/theme Ocean'), { kind: 'theme', arg: 'ocean' })
    assert.deepEqual(parseSlashCommand('/skin  candy '), { kind: 'theme', arg: 'candy' })
  })

  it('parses mode commands', () => {
    assert.deepEqual(parseSlashCommand('/mode'), { kind: 'mode' })
    assert.deepEqual(parseSlashCommand('/mode list'), { kind: 'mode' })
    assert.deepEqual(parseSlashCommand('/mode tv'), { kind: 'mode', arg: 'tv' })
  })

  it('flags unknown commands so the caller can explain them', () => {
    assert.deepEqual(parseSlashCommand('/nope'), { kind: 'unknown', name: 'nope' })
    assert.deepEqual(parseSlashCommand('/'), { kind: 'unknown', name: '' })
  })
})
