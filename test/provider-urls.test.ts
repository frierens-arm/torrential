import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { x1337MirrorUrls } from '../src/providers/x1337.js'

describe('x1337MirrorUrls', () => {
  it('uses the TV category route for shows', () => {
    assert.deepEqual(x1337MirrorUrls(['https://1337x.to'], 'breaking bad'), [
      'https://1337x.to/category-search/breaking%20bad/TV/1/'
    ])
  })

  it('uses the plain catalogue route outside tv mode', () => {
    assert.deepEqual(x1337MirrorUrls(['https://1377x.to/'], 'oppenheimer', false), [
      'https://1377x.to/search/oppenheimer/1/'
    ])
  })

  it('substitutes {query} templates verbatim', () => {
    assert.deepEqual(x1337MirrorUrls(['https://p.example/s?q={query}'], 'the bear', true), [
      'https://p.example/s?q=the%20bear'
    ])
  })

  it('keeps the user mirror order and skips blanks', () => {
    assert.deepEqual(x1337MirrorUrls([' ', 'https://a.example', 'https://b.example'], 'x', false), [
      'https://a.example/search/x/1/',
      'https://b.example/search/x/1/'
    ])
  })
})
