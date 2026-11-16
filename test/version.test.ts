import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { VERSION } from '../src/version.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')

describe('release version drift', () => {
  it('is a plain semver string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  })

  it('matches package.json', () => {
    assert.equal(VERSION, pkg.version)
  })

  it('has a CHANGELOG section for this version', () => {
    assert.match(changelog, new RegExp(`^## ${VERSION.replace(/\./g, '\\.')} — `, 'm'))
  })
})
