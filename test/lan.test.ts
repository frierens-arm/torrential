import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createShareToken,
  isLoopbackAddress,
  normaliseRemoteAddress,
  pickLanAddress,
  rankLanAddresses,
  type NetworkInterfaceMap
} from '../src/utils/lan.js'

describe('pickLanAddress', () => {
  it('prefers the home-router 192.168 range', () => {
    const picked = pickLanAddress({
      en0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      en1: [{ address: '192.168.1.42', family: 'IPv4', internal: false }]
    })
    assert.deepEqual(picked, { address: '192.168.1.42', name: 'en1' })
  })

  it('accepts 10/8 and 172.16/12 private ranges', () => {
    assert.equal(
      pickLanAddress({ eth0: [{ address: '172.20.3.9', family: 'IPv4', internal: false }] })?.address,
      '172.20.3.9'
    )
    assert.equal(
      pickLanAddress({ 'Wi-Fi': [{ address: '10.1.2.3', family: 4, internal: false }] })?.address,
      '10.1.2.3'
    )
  })

  it('skips loopback, link-local, IPv6 and internal addresses', () => {
    const ifaces: NetworkInterfaceMap = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      awdl0: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
      en0: [
        { address: 'fe80::1c2d:3e4f', family: 'IPv6', internal: false },
        { address: '192.168.0.7', family: 'IPv4', internal: false }
      ]
    }
    assert.deepEqual(pickLanAddress(ifaces), { address: '192.168.0.7', name: 'en0' })
  })

  it('never advertises a virtual adapter when a real one exists', () => {
    // docker0 would otherwise win on range alone (172.17), but the phone
    // cannot route to it.
    const picked = pickLanAddress({
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      wlan0: [{ address: '10.0.0.12', family: 'IPv4', internal: false }]
    })
    assert.deepEqual(picked, { address: '10.0.0.12', name: 'wlan0' })
  })

  it('falls back to a virtual adapter rather than returning nothing', () => {
    assert.equal(
      pickLanAddress({ utun3: [{ address: '192.168.99.2', family: 'IPv4', internal: false }] })?.address,
      '192.168.99.2'
    )
  })

  it('returns null on a loopback-only machine', () => {
    assert.equal(pickLanAddress({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), null)
    assert.equal(pickLanAddress({}), null)
  })

  it('ranks every candidate so the TUI/doctor can offer alternates', () => {
    const ranked = rankLanAddresses({
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      en0: [{ address: '10.0.0.228', family: 'IPv4', internal: false }],
      en1: [{ address: '192.168.1.9', family: 'IPv4', internal: false }]
    })
    assert.deepEqual(
      ranked.map(c => c.address),
      ['192.168.1.9', '10.0.0.228', '172.17.0.1']
    )
  })
})

describe('isLoopbackAddress', () => {
  it('recognises loopback in every shape a socket reports', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('127.8.9.10'), true)
    assert.equal(isLoopbackAddress('::1'), true)
    assert.equal(isLoopbackAddress('[::1]'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress(undefined), true) // no peer info = local
  })

  it('treats a phone on the LAN as remote, including the IPv4-mapped form', () => {
    assert.equal(isLoopbackAddress('192.168.1.50'), false)
    assert.equal(isLoopbackAddress('::ffff:192.168.1.50'), false)
    assert.equal(isLoopbackAddress('fd00::1'), false)
  })
})

describe('normaliseRemoteAddress', () => {
  it('unwraps bracketed and IPv4-mapped forms', () => {
    assert.equal(normaliseRemoteAddress('[::1]'), '::1')
    assert.equal(normaliseRemoteAddress('::ffff:10.0.0.2'), '10.0.0.2')
    assert.equal(normaliseRemoteAddress(' 192.168.1.2 '), '192.168.1.2')
  })
})

describe('createShareToken', () => {
  it('is short, unguessable and free of look-alike characters', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const token = createShareToken()
      assert.equal(token.length, 8)
      assert.match(token, /^[a-hj-km-np-z2-9]{8}$/)
      tokens.add(token)
    }
    // 40 bits of entropy: 200 draws colliding would mean broken randomness.
    assert.ok(tokens.size > 195, `only ${tokens.size} unique tokens`)
  })
})
