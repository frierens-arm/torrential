import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import { runDoctor } from '../src/doctor.js'

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrential-doctor-'))
  const file = path.join(dir, 'config.json')
  const loaded = loadConfig(file)
  const config = {
    ...DEFAULT_CONFIG,
    ...loaded.config,
    cache_directory: path.join(dir, 'cache'),
    keep_directory: path.join(dir, 'keep')
  }
  return { dir, config, loaded }
}

describe('runDoctor', () => {
  it('prints a full report and passes offline', async () => {
    const { config, loaded } = tempConfig()
    const lines: string[] = []
    const result = await runDoctor({
      config,
      loaded,
      skipProviders: true,
      print: line => lines.push(line ?? '')
    })
    const report = lines.join('\n')
    assert.match(report, /torrential \d/)
    for (const section of [
      'runtime',
      'paths',
      'player',
      'stream server',
      'phone sharing',
      'indexers',
      'next steps'
    ]) {
      assert.ok(report.includes(section), `missing section: ${section}`)
    }
    assert.ok(report.includes('skipped (--doctor --offline)'))
    assert.ok(report.includes('cache directory is writable'))

    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
    if (nodeMajor >= 22) {
      assert.deepEqual(result.failures, [])
      assert.equal(result.ok, true)
      assert.ok(report.includes('all clear'))
    }
  })

  it('warns about an unknown configured source', async () => {
    const { config, loaded } = tempConfig()
    const lines: string[] = []
    await runDoctor({
      config: { ...config, providers: [...config.providers, 'notasource'] },
      loaded,
      skipProviders: true,
      print: line => lines.push(line ?? '')
    })
    assert.ok(lines.join('\n').includes('notasource'))
  })

  it('flags an unknown default player', async () => {
    const { config, loaded } = tempConfig()
    const lines: string[] = []
    const result = await runDoctor({
      config: { ...config, default_player: 'definitely-not-installed' },
      loaded,
      skipProviders: true,
      print: line => lines.push(line ?? '')
    })
    assert.ok(result.warnings.some(w => w.includes('definitely-not-installed')))
  })
})
