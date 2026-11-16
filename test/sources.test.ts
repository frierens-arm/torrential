import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSourcesFlag } from '../src/utils/sources.js'

describe('parseSourcesFlag', () => {
  it('accepts every documented alias', () => {
    assert.deepEqual(parseSourcesFlag('tpb').providers, ['piratebay'])
    assert.deepEqual(parseSourcesFlag('apibay').providers, ['piratebay'])
    assert.deepEqual(parseSourcesFlag('1337').providers, ['1337x'])
    assert.deepEqual(parseSourcesFlag('x1337').providers, ['1337x'])
    assert.deepEqual(parseSourcesFlag('nyaa.si').providers, ['nyaa'])
  })

  it('keeps display order and drops duplicates', () => {
    assert.deepEqual(parseSourcesFlag('nyaa,tpb,nyaa').providers, ['piratebay', 'nyaa'])
  })

  it('tolerates spacing and casing', () => {
    assert.deepEqual(parseSourcesFlag(' TPB , NYAA ').providers, ['piratebay', 'nyaa'])
  })

  it('rejects unknown sources loudly instead of silently dropping them', () => {
    const result = parseSourcesFlag('tpb,kickass')
    assert.equal(result.providers, null)
    assert.match(result.error ?? '', /unknown source "kickass"/)
  })

  it('rejects an empty list', () => {
    const result = parseSourcesFlag(' , ')
    assert.equal(result.providers, null)
    assert.match(result.error ?? '', /at least one source/)
  })
})
