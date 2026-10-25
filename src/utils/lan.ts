import crypto from 'node:crypto'
import os from 'node:os'

/**
 * LAN helpers for the phone hand-off.
 *
 * The stream server speaks plain HTTP with Range support, so a phone on the
 * same Wi-Fi can play the file exactly like the desktop player does. The two
 * hard parts are picking an address the phone can actually dial, and telling
 * a LAN visitor apart from the local machine. Both live here as pure
 * functions so they can be tested without a network.
 */

export interface LanInterfaceInfo {
  address: string
  family: string | number
  internal: boolean
}

export type NetworkInterfaceMap = Record<string, LanInterfaceInfo[] | undefined>

export interface LanAddress {
  address: string
  /** Interface name, for the TUI/short logs ("en0", "Wi-Fi"). */
  name: string
}

/**
 * Interface names that almost never reach the phone: container bridges,
 * VM host-only adapters and every VPN/tunnel flavour. They are still used as
 * a last resort, because a misdetected address beats no QR at all — but a
 * real Wi-Fi/Ethernet address always wins.
 */
const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vnic|utun|tun|tap|ppp|wg|zt|tailscale|ham\d|vEthernet|Hyper-V|Loopback|awdl|llw)/i

/** Interfaces that look like the machine's primary physical link. */
const PHYSICAL_INTERFACE = /^(en|eth|wl|wlan|wi-?fi|ethernet)/i

export function isPrivateIPv4(address: string): boolean {
  if (/^192\.168\./.test(address)) return true
  if (/^10\./.test(address)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true
  return false
}

function isUsableIPv4(address: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false
  if (/^127\./.test(address)) return false
  if (/^169\.254\./.test(address)) return false // link-local: never routable from the phone
  if (/^0\./.test(address)) return false
  if (address === '255.255.255.255') return false
  return true
}

function isIPv6(info: LanInterfaceInfo): boolean {
  return info.family === 'IPv6' || info.family === 6
}

/**
 * Pick the best LAN IPv4 from an interface map.
 *
 * Ordering: private ranges (192.168 first — the common home router, then
 * 172.16/12, then 10/8), public addresses, and virtual adapters last.
 * IPv6 is skipped entirely: a bracketed v6 URL is far too long to scan from
 * a terminal at a comfortable size.
 */
export function rankLanAddresses(ifaces: NetworkInterfaceMap): LanAddress[] {
  const scored: Array<{ address: string; name: string; score: number }> = []

  for (const [name, infos] of Object.entries(ifaces)) {
    if (!infos) continue
    for (const info of infos) {
      if (info.internal || isIPv6(info)) continue
      if (!isUsableIPv4(info.address)) continue
      let score = isPrivateIPv4(info.address) ? 100 : 10
      if (/^192\.168\./.test(info.address)) score = 300
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) score = 250
      else if (/^10\./.test(info.address)) score = 200
      if (PHYSICAL_INTERFACE.test(name)) score += 20
      if (VIRTUAL_INTERFACE.test(name)) score -= 1000
      scored.push({ address: info.address, name, score })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
  return scored.map(({ address, name }) => ({ address, name }))
}

/** Best LAN IPv4, or null when the machine has none. */
export function pickLanAddress(ifaces: NetworkInterfaceMap): LanAddress | null {
  return rankLanAddresses(ifaces)[0] ?? null
}

/** Detect the machine's LAN IPv4, or null on a loopback-only machine. */
export function detectLanAddress(): LanAddress | null {
  return pickLanAddress(os.networkInterfaces() as unknown as NetworkInterfaceMap)
}

/**
 * True for the local machine: `127.0.0.0/8`, `::1`, and their IPv4-mapped
 * forms (a dual-stack socket reports LAN clients as `::ffff:192.168.x.x`).
 */
export function isLoopbackAddress(remote: string | undefined | null): boolean {
  if (!remote) return true // no peer info (in-process/agent) → treat as local
  const address = normaliseRemoteAddress(remote)
  if (address === '::1') return true
  return /^127\./.test(address)
}

/** Strip IPv6 brackets and the `::ffff:` IPv4-mapping prefix. */
export function normaliseRemoteAddress(remote: string): string {
  let address = remote.trim()
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  const mapped = /^::ffff:(.*)$/i.exec(address)
  if (mapped) address = mapped[1]
  return address
}

/** Alphabet without look-alikes (0/o, 1/l/i) — easy to read off a screen. */
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * Random 8-character token that scopes the phone URL. 40 bits of entropy:
 * an unguessable path on the LAN, short enough to keep the QR small.
 */
export function createShareToken(): string {
  const bytes = crypto.randomBytes(8)
  let token = ''
  for (let i = 0; i < 8; i++) token += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  return token
}
