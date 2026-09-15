import 'server-only'
/**
 * The requesting client's IP, for rate limiting only — and only ever stored as a keyed hash.
 *
 * TRUST. A Next.js route handler cannot see the TCP peer, so it cannot check for itself that a
 * request came through our proxy. `TRUST_PROXY=true` is the operator's explicit statement that it
 * did: in `deploy/unconference/compose.yml` the app publishes no port and is reachable only through
 * the Caddy container. Caddy (v2.5+, no `trusted_proxies` configured) REPLACES any incoming
 * `X-Forwarded-For` with the address of the peer it accepted, so the left-most entry is the real
 * client and a spoofed header never survives the edge. Without `TRUST_PROXY=true` the header is
 * ignored entirely (per-IP limits are skipped; per-email and global limits still apply).
 *
 * HASHING. `hmac-sha256(ATPROTO_SESSION_SECRET, bucket)` truncated to 32 hex chars. The bucket is
 * the IPv4 address, or the /64 prefix of an IPv6 address (one subscriber is routinely handed a whole
 * /64, so per-address limits on IPv6 would be meaningless). IPv4-mapped IPv6 counts as IPv4.
 */
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { sessionSecret } from '@/lib/atproto/config'

export function trustProxy(): boolean {
  return process.env.TRUST_PROXY?.trim().toLowerCase() === 'true'
}

let warned = false

/** Normalise one address token: strip brackets, an IPv4 `:port`, an IPv6 zone. Null when not an IP. */
export function normalizeIp(raw: string): string | null {
  let v = raw.trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v)
  if (bracketed) v = bracketed[1]!
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'))
  v = v.replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v)
  if (mapped) v = mapped[1]!
  return isIP(v) ? v.toLowerCase() : null
}

/** The client IP from a request, or null when the proxy is not trusted or the header is unusable. */
export function clientIp(request: Request): string | null {
  if (!trustProxy()) {
    if (!warned && process.env.NODE_ENV === 'production') {
      warned = true
      console.warn('[auth] TRUST_PROXY is not true: per-IP sign-in limits are disabled')
    }
    return null
  }
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]
  return first ? normalizeIp(first) : null
}

function expandIpv6(ip: string): string[] {
  const [head, tail = ''] = ip.includes('::') ? ip.split('::') : [ip, '']
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return groups.map((g) => g.padStart(4, '0'))
}

/** The rate-limit bucket for an address: IPv4 as is, IPv6 as its /64. */
export function ipBucket(ip: string): string {
  const v = normalizeIp(ip)
  if (!v) return 'invalid'
  if (isIP(v) === 4) return v
  return `${expandIpv6(v).slice(0, 4).join(':')}::/64`
}

/** What is stored: a truncated keyed hash of the bucket. */
export function hashIp(ip: string): string {
  return createHmac('sha256', sessionSecret()).update(`ip:${ipBucket(ip)}`).digest('hex').slice(0, 32)
}
