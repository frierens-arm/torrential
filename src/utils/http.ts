import https from 'node:https'
import { USER_AGENT } from '../constants.js'

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const DEFAULT_TIMEOUT_MS = 12_000

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9'
}

/** Humanize low-level fetch failures. */
function normalizeNetworkError(err: unknown, url: string): HttpError {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timeout/i.test(msg)) {
    return new HttpError(`timed out (${new URL(url).host} did not answer in time)`, undefined, err)
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return new HttpError(`network unreachable for ${new URL(url).host}`, undefined, err)
  }
  return new HttpError(msg, undefined, err)
}

/* ------------------------------------------------------------------ *
 * Cloudflare "Just a moment…" challenge detection
 * ------------------------------------------------------------------ */

const CHALLENGE_RE =
  /just a moment|cf-browser-verification|challenge-platform|attention required|cf_chl_opt|__cf_chl/i

/** True when the HTML is a Cloudflare interstitial instead of real content. */
export function looksLikeChallenge(html: string): boolean {
  return html.length > 0 && html.length < 200_000 && CHALLENGE_RE.test(html)
}

function challengeError(url: string): HttpError {
  return new HttpError(
    `blocked by ${new URL(url).host} (Cloudflare challenge) — try a VPN or add a working mirror to config "x1337_mirrors"`,
    403
  )
}

/* ------------------------------------------------------------------ *
 * DNS-over-HTTPS fallback
 *
 * ISPs in several countries (CA/UK/AU/FR…) court-order-block torrent
 * sites by DNS. The domain then fails to resolve or resolves to a
 * blockpage. Resolving the SAME domain over DoH (encrypted, off-ISP)
 * and connecting straight to the real IP with correct SNI defeats the
 * DNS-level block. This is only a fallback: normal fetch runs first.
 * ------------------------------------------------------------------ */

interface DohAnswer {
  type?: number
  data?: string
}
interface DohResponse {
  Status?: number
  Answer?: DohAnswer[]
}

const DNS_TTL_MS = 10 * 60_000
const dnsCache = new Map<string, { ips: string[]; expires: number }>()

/** Literal-IP resolvers first (they need no DNS at all), then hostname ones. */
const DOH_ENDPOINTS = [
  'https://1.1.1.1/dns-query',
  'https://cloudflare-dns.com/dns-query',
  'https://8.8.8.8/resolve'
]

async function resolveViaDoh(host: string, timeoutMs: number): Promise<string[]> {
  const cached = dnsCache.get(host)
  if (cached && cached.expires > Date.now()) return cached.ips

  for (const endpoint of DOH_ENDPOINTS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 6000))
    try {
      const res = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=A`, {
        signal: controller.signal,
        headers: { accept: 'application/dns-json' }
      })
      if (!res.ok) continue
      const data = (await res.json()) as DohResponse
      const ips = (data.Answer ?? [])
        .filter(a => a.type === 1 && typeof a.data === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data))
        .map(a => a.data as string)
      if (ips.length > 0) {
        dnsCache.set(host, { ips, expires: Date.now() + DNS_TTL_MS })
        return ips
      }
    } catch {
      // resolver down/blocked → try the next one
    } finally {
      clearTimeout(timer)
    }
  }
  return []
}

interface RawResponse {
  status: number
  location?: string
  body: string
}

/** Plain node:https GET pinned to one IP, with SNI + Host kept honest. */
function requestViaIp(url: URL, ip: string, timeoutMs: number, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          host: url.host,
          ...BROWSER_HEADERS,
          ...headers,
          connection: 'close'
        }
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

/** GET `url` through DoH-resolved IPs, following up to 4 redirects. */
async function fetchViaDoh(url: string, timeoutMs: number, headers: Record<string, string>): Promise<string> {
  let current = new URL(url)
  let lastError: unknown = null

  for (let hop = 0; hop < 5; hop++) {
    const ips = await resolveViaDoh(current.hostname, timeoutMs)
    if (ips.length === 0) {
      throw new HttpError(
        `could not resolve ${current.hostname} even over DNS-over-HTTPS — the domain may be dead or your network blocks it entirely`,
        undefined,
        lastError
      )
    }

    let outcome: RawResponse | null = null
    for (const ip of ips.slice(0, 3)) {
      try {
        outcome = await requestViaIp(current, ip, timeoutMs, headers)
        break
      } catch (err) {
        lastError = err
      }
    }
    if (!outcome) {
      throw normalizeNetworkError(
        lastError instanceof Error ? lastError : new Error('connection failed over DoH-resolved IP'),
        current.toString()
      )
    }

    if ([301, 302, 303, 307, 308].includes(outcome.status) && outcome.location) {
      current = new URL(outcome.location, current)
      continue
    }
    if (outcome.status >= 400) {
      throw new HttpError(`HTTP ${outcome.status} from ${current.host} (DoH path)`, outcome.status)
    }
    return outcome.body
  }
  throw new HttpError(`too many redirects fetching ${url} (DoH path)`)
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface FetchOptions {
  timeoutMs?: number
  headers?: Record<string, string>
}

/** fetch() + timeout + UA + friendly error mapping + DoH fallback. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { ...BROWSER_HEADERS, ...opts.headers }
    })
    if (!res.ok) {
      throw new HttpError(
        res.status === 403 || res.status === 429
          ? `blocked by ${new URL(url).host} (HTTP ${res.status}) — try again, use a VPN, or add a working mirror to config "x1337_mirrors"`
          : `HTTP ${res.status} from ${new URL(url).host}`,
        res.status
      )
    }
    const body = await res.text()
    if (looksLikeChallenge(body)) throw challengeError(url)
    return body
  } catch (err) {
    // v1.3.1 fix: a DNS-level failure (ENOTFOUND / EAI_AGAIN — the classic
    // ISP court-block signature) rejects fetch() with a *TypeError*, not an
    // HttpError — the old code only ran the DoH bypass for HttpErrors, so
    // the bypass was unreachable in exactly the case it was built for.
    // Normalize first (TypeError/AbortError → HttpError), then retry the
    // whole fetch over DNS-over-HTTPS when the failure looks DNS-shaped.
    const httpErr = err instanceof HttpError ? err : normalizeNetworkError(err, url)
    const causeMsg = httpErr.cause instanceof Error ? `${httpErr.cause.message} ${httpErr.message}` : httpErr.message
    const dnsShaped =
      /ENOTFOUND|EAI_AGAIN|network unreachable|timed out|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|fetch failed/i.test(
        causeMsg
      )
    if (dnsShaped && !/cloudflare-dns|1\.1\.1\.1|8\.8\.8\.8/.test(url)) {
      try {
        const body = await fetchViaDoh(url, timeoutMs, opts.headers ?? {})
        if (!looksLikeChallenge(body)) return body
      } catch {
        // fall through to the original error
      }
    }
    throw httpErr
  } finally {
    clearTimeout(timer)
  }
}

/** JSON variant of {@link fetchText}. */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers }
  })
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new HttpError(`${new URL(url).host} returned malformed JSON`, undefined, err)
  }
}
