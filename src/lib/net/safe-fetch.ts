import 'server-only'
/**
 * SSRF-safe `fetch` for every URL a third party controls: PDS endpoints named in DID documents,
 * did:web documents, handle well-knowns, OAuth authorization/resource servers, foreign repos.
 *
 * WHY THIS SHAPE
 *  - The address check happens at CONNECT time, inside an undici `Agent` whose connector resolves the
 *    hostname itself (`lookup`) and refuses any non-public address. A name that resolves publicly
 *    when we validate and privately when we connect (DNS rebinding) is therefore still refused:
 *    there is no separate "validate, then fetch" window. IP-literal hosts never reach `lookup`
 *    (Node skips DNS for them), so the connector checks those explicitly too.
 *  - Redirects are followed by hand (max 3), each hop re-validated by the same URL policy and
 *    dialled through the same guarded dispatcher.
 *  - Responses are size-capped and the whole exchange (body included) is bounded by a timeout.
 *  - `undici` is an explicit dependency (major 6, the line Node 22 bundles) because Node's bundled
 *    copy is not importable, and we use undici's own `fetch` with its own `Agent` so the dispatcher
 *    and the fetch implementation are always the same version. The response is re-wrapped in a
 *    global `Response`, so callers (`@atproto/api`, `@atproto/oauth-client`) see the standard class.
 *
 * WHAT IS ALLOWED
 *  - `https:` to a public unicast address.
 *  - `http:` ONLY outside production AND when the origin exactly equals a configured local service
 *    (`PDS_URL`, `PDS_INTERNAL_URL`, `ATPROTO_DEFAULT_PDS_URL`, `ATPROTO_PLC_URL`,
 *    `ATPROTO_HANDLE_RESOLVER`, `AI_TEST_BASE_ORIGIN`). Those origins also skip the public-address
 *    rule (they are localhost in development). Nothing is exempt in production.
 *
 *  `AI_TEST_BASE_ORIGIN` exists for the tests only: it names one origin (e.g.
 *  `http://127.0.0.1:41234`) that may stand in for an organizer-supplied OpenAI-compatible answer
 *  provider, so no test ever calls a real model. It is unset by default, ignored in production,
 *  and the ai-key route refuses any other non-https base URL.
 *
 * Code that talks to OUR PDS through `PDS_INTERNAL_URL` does not use this: that URL is operator
 * configuration, not attacker input (see `src/lib/atproto/service-url.ts`).
 */
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOneOptions } from 'node:dns'
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici'

export const SAFE_FETCH_TIMEOUT_MS = 10_000
export const SAFE_FETCH_MAX_BYTES = 5 * 1024 * 1024
export const SAFE_FETCH_MAX_REDIRECTS = 3

/** A request refused by the SSRF policy. Never retried; the message names the origin only. */
export class UnsafeUrlError extends Error {
  readonly code = 'ERR_UNSAFE_URL'
  constructor(detail: string) {
    super(`Refused by outbound URL policy: ${detail}`)
    this.name = 'UnsafeUrlError'
  }
}

/* ───────────────────────────── address policy ───────────────────────────── */

const blocked = new BlockList()
// IPv4 special-purpose registry (RFC 6890 and friends).
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
// IPv6: only global unicast (2000::/3) can be public; within it, carve out the special ranges.
const globalUnicast = new BlockList()
globalUnicast.addSubnet('2000::', 3, 'ipv6')
for (const [net, prefix] of [
  ['2001::', 23], // IETF protocol assignments (Teredo 2001::/32, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an arbitrary IPv4 address)
  ['3fff::', 20], // documentation (RFC 9637)
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

function embeddedIPv4(v6: string): string | null {
  // ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-compatible), 64:ff9b::a.b.c.d (NAT64), in either
  // dotted or hex form. Anything that embeds IPv4 is judged by the IPv4 it embeds.
  const lower = v6.toLowerCase()
  const m = /^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(lower)
  if (!m) return null
  if (m[1]) return m[1]
  const hi = parseInt(m[2]!, 16)
  const lo = parseInt(m[3]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/**
 * True only for a public unicast address. Loopback, unspecified, private, CGNAT, link-local, ULA,
 * multicast, reserved, documentation ranges and IPv4-mapped/embedded forms of those are refused.
 * Anything that does not parse as an IP address is refused.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const family = isIP(ip)
  if (family === 4) return !blocked.check(ip, 'ipv4')
  if (family === 6) {
    const v4 = embeddedIPv4(ip)
    if (v4 !== null) return isIP(v4) === 4 && !blocked.check(v4, 'ipv4')
    // ::, ::1, fc00::/7 (ULA, incl. fd00:ec2::254 metadata), fe80::/10, fec0::/10, ff00::/8 all
    // fall outside 2000::/3.
    return globalUnicast.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6')
  }
  return false
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** `dns.lookup` that fails when ANY resolved address is not public. Handles `all: true` (Node's happy eyeballs). */
export function safeLookup(hostname: string, options: LookupOneOptions | LookupAllOptions | number, callback: LookupCallback): void {
  const opts = typeof options === 'number' ? { family: options } : options
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err, [])
    const list = addresses as LookupAddress[]
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const refused = Object.assign(new UnsafeUrlError(`${hostname} resolves to a non-public address`), { errno: undefined })
      return callback(refused as NodeJS.ErrnoException, [])
    }
    if ((opts as LookupAllOptions).all) return callback(null, list)
    return callback(null, list[0]!.address, list[0]!.family)
  })
}

/* ───────────────────────────── dispatchers ───────────────────────────── */

let guarded: Agent | undefined
let local: Agent | undefined

/**
 * The guarded dispatcher: every connection it opens has been checked against the public-address
 * rule, whether the host was an IP literal or a name (resolved by `safeLookup` at connect time).
 */
export function safeDispatcher(): Dispatcher {
  if (!guarded) {
    const base = buildConnector({ lookup: safeLookup as never, timeout: SAFE_FETCH_TIMEOUT_MS })
    const connect: buildConnector.connector = (options, callback) => {
      const host = options.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) && !isPublicAddress(host)) {
        callback(new UnsafeUrlError(`${host} is not a public address`), null)
        return
      }
      base(options, callback)
    }
    guarded = new Agent({ connect, maxRedirections: 0 })
  }
  return guarded
}

/** Plain dispatcher for the exact local service origins allowed outside production. */
function localDispatcher(): Dispatcher {
  local ??= new Agent({ maxRedirections: 0 })
  return local
}

/* ───────────────────────────── URL policy ───────────────────────────── */

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function originOf(value: string | undefined): string | null {
  const v = value?.trim()
  if (!v) return null
  try {
    return new URL(v).origin
  } catch {
    return null
  }
}

/** Origins of our own configured local services (only honoured outside production). */
export function localServiceOrigins(): Set<string> {
  const names = ['PDS_URL', 'PDS_INTERNAL_URL', 'ATPROTO_DEFAULT_PDS_URL', 'ATPROTO_PLC_URL', 'ATPROTO_HANDLE_RESOLVER', 'AI_TEST_BASE_ORIGIN']
  return new Set(names.map((n) => originOf(process.env[n])).filter((o): o is string => Boolean(o)))
}

function isAllowedLocalOrigin(url: URL): boolean {
  return !isProduction() && localServiceOrigins().has(url.origin)
}

/**
 * The syntactic half of the policy (the address half runs at connect time): `https:` only (or an
 * allowed local origin outside production), no credentials in the URL, no non-public IP literal.
 * Returns which dispatcher the URL must use. Throws `UnsafeUrlError`.
 */
export function checkOutboundUrl(input: string | URL): { url: URL; local: boolean } {
  let url: URL
  try {
    url = new URL(String(input))
  } catch {
    throw new UnsafeUrlError('not a URL')
  }
  if (url.username || url.password) throw new UnsafeUrlError(`${url.protocol}//… carries credentials`)
  if (isAllowedLocalOrigin(url)) return { url, local: true }
  if (url.protocol !== 'https:') throw new UnsafeUrlError(`${url.origin} is not https`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError(`${url.origin} is not a public address`)
  return { url, local: false }
}

/**
 * Validate a service endpoint named by a third party (a DID document's PDS) without fetching.
 * Returns it without a trailing slash. The connect-time check still applies when it is used.
 */
export function assertPublicServiceUrl(endpoint: string): string {
  const { url } = checkOutboundUrl(endpoint)
  if (url.search || url.hash) throw new UnsafeUrlError(`${url.origin} service endpoint has a query or fragment`)
  return url.toString().replace(/\/+$/, '')
}

/* ───────────────────────────── fetch ───────────────────────────── */

export interface SafeFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

type Body = string | ArrayBuffer | Uint8Array | URLSearchParams | undefined

async function bufferBody(body: unknown, headers: Headers): Promise<Body> {
  if (body == null) return undefined
  if (typeof body === 'string' || body instanceof ArrayBuffer || body instanceof URLSearchParams) return body
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  // Blob, FormData, ReadableStream: let the platform serialise it once, keep the bytes for replay.
  const r = new Request('http://body.invalid/', { method: 'POST', body: body as BodyInit, duplex: 'half' } as RequestInit)
  if (!headers.has('content-type')) {
    const type = r.headers.get('content-type')
    if (type) headers.set('content-type', type)
  }
  return new Uint8Array(await r.arrayBuffer())
}

function limitBody(body: ReadableStream<Uint8Array>, maxBytes: number, origin: string): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > maxBytes) controller.error(new UnsafeUrlError(`${origin} response exceeds ${maxBytes} bytes`))
        else controller.enqueue(chunk)
      },
    }),
  )
}

function unwrap(e: unknown): unknown {
  let cur = e
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof UnsafeUrlError) return cur
    cur = (cur as { cause?: unknown }).cause
  }
  return e
}

/**
 * Drop-in `fetch` for third-party-controlled URLs. Accepts the same arguments as the global
 * `fetch` (a `Request` object included) and returns a global `Response`.
 */
export function createSafeFetch(opts: SafeFetchOptions = {}): typeof globalThis.fetch {
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS

  return async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : null
    const headers = new Headers(init?.headers ?? req?.headers)
    let method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
    const redirectMode = init?.redirect ?? req?.redirect ?? 'follow'
    let body: Body =
      init?.body !== undefined
        ? await bufferBody(init.body, headers)
        : req && req.body && method !== 'GET' && method !== 'HEAD'
          ? new Uint8Array(await req.arrayBuffer())
          : undefined
    const callerSignal = init?.signal ?? req?.signal ?? undefined
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)

    let target = req ? req.url : input instanceof URL ? input.toString() : String(input)
    for (let hop = 0; ; hop++) {
      const { url, local } = checkOutboundUrl(target)
      let res: Awaited<ReturnType<typeof undiciFetch>>
      try {
        res = await undiciFetch(url, {
          method,
          headers: [...headers.entries()],
          body: body as never,
          redirect: 'manual',
          signal,
          dispatcher: local ? localDispatcher() : safeDispatcher(),
        })
      } catch (e) {
        const cause = unwrap(e)
        if (cause instanceof UnsafeUrlError) throw cause
        throw e
      }

      if (REDIRECT_STATUSES.has(res.status) && redirectMode !== 'manual') {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => undefined)
        if (redirectMode === 'error') throw new TypeError(`fetch failed: unexpected redirect from ${url.origin}`)
        if (!location) throw new TypeError(`fetch failed: redirect without Location from ${url.origin}`)
        if (hop >= maxRedirects) throw new UnsafeUrlError(`${url.origin} redirected more than ${maxRedirects} times`)
        const next = new URL(location, url)
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET'
          body = undefined
          headers.delete('content-type')
          headers.delete('content-length')
        }
        if (next.origin !== url.origin) {
          // Never carry credentials to another origin.
          headers.delete('authorization')
          headers.delete('cookie')
          headers.delete('dpop')
        }
        target = next.toString()
        continue
      }

      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined)
        throw new UnsafeUrlError(`${url.origin} response exceeds ${maxBytes} bytes`)
      }
      const out = new Response(
        NULL_BODY_STATUSES.has(res.status) || !res.body ? null : limitBody(res.body as ReadableStream<Uint8Array>, maxBytes, url.origin),
        { status: res.status, statusText: res.statusText, headers: new Headers([...res.headers.entries()]) },
      )
      Object.defineProperty(out, 'url', { value: url.toString() })
      Object.defineProperty(out, 'redirected', { value: hop > 0 })
      return out
    }
  } as typeof globalThis.fetch
}

/** The default SSRF-safe fetch (10 s, 5 MB, 3 redirects). */
export const safeFetch: typeof globalThis.fetch = createSafeFetch()
