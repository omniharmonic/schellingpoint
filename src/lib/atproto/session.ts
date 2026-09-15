import 'server-only'
/**
 * The `sp_at_session` cookie: a browser session bound to an account (and its DID).
 *
 * Cookie value is `<id>.<hmac-sha256(id, ATPROTO_SESSION_SECRET)>` where `id` is the
 * primary key of an `at_sessions` row. The HMAC rejects forged ids without a database
 * round-trip; the row carries the DID, the account, which door the session came through,
 * and its expiry. A sign-out is a DELETE.
 *
 * `HttpOnly; SameSite=Lax; Path=/; Max-Age=30d`, `Secure` over https. `Lax`, not
 * `Strict`, because the OAuth callback and the magic link are top-level cross-site GETs.
 *
 * When `NEXT_PUBLIC_APP_URL` names a real host, the cookie is written with
 * `Domain=.<apex>` so gathering subdomains (`<slug>.unconference.events`) share the
 * session (spec §8 routing). A cookie is only deleted on the scope it was written with,
 * so clearing emits BOTH the domain-scoped and the host-only deletion.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { sql } from '@/lib/db'
import { publicUrl, sessionSecret } from './config'

export const AT_SESSION_COOKIE = 'sp_at_session'
export const AT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type AtSessionKind = 'custodial' | 'oauth'

export interface AtSession {
  id: string
  did: string
  /** `accounts.id`. */
  accountId: string
  /** @deprecated alias of `accountId`, kept for older readers. */
  userId: string
  kind: AtSessionKind
  expiresAt: Date
}

/** Anything with a `get(name)` that returns `{ value }` — `await cookies()` qualifies. */
export interface CookieReader {
  get(name: string): { value: string } | undefined
}

export type SessionSource = Request | CookieReader

function sign(id: string): string {
  return createHmac('sha256', sessionSecret()).update(id).digest('base64url')
}

function appUrl(): URL | null {
  try {
    return new URL(publicUrl())
  } catch {
    return null
  }
}

function isSecure(): boolean {
  return appUrl()?.protocol === 'https:'
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * `.unconference.events` for `https://unconference.events` (or `www.`); null for a local
 * or IP-literal origin, where a host-only cookie is the only kind that works.
 */
export function sessionCookieDomain(): string | null {
  const url = appUrl()
  if (!url) return null
  const host = url.hostname.toLowerCase()
  if (isLocalHost(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null
  return `.${host.replace(/^www\./, '')}`
}

function cookieAttributes(maxAgeSeconds: number, domain: string | null): string {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(domain ? [`Domain=${domain}`] : []),
    ...(isSecure() ? ['Secure'] : []),
  ].join('; ')
}

/** `Set-Cookie` header value that installs `value`. */
export function sessionCookieHeader(value: string): string {
  return `${AT_SESSION_COOKIE}=${value}; ${cookieAttributes(Math.floor(AT_SESSION_TTL_MS / 1000), sessionCookieDomain())}`
}

/**
 * Every `Set-Cookie` value needed to clear the session: the domain-scoped cookie and,
 * when a domain is in use, the host-only one too.
 */
export function clearSessionCookieHeaders(): string[] {
  const domain = sessionCookieDomain()
  const out = [`${AT_SESSION_COOKIE}=; ${cookieAttributes(0, domain)}`]
  if (domain) out.push(`${AT_SESSION_COOKIE}=; ${cookieAttributes(0, null)}`)
  return out
}

/** The first clearing header. Prefer `clearSessionCookieHeaders()`. */
export function clearSessionCookieHeader(): string {
  return clearSessionCookieHeaders()[0]!
}

/** Parse and verify a cookie value. Returns the session id or null. */
export function verifySessionCookie(value: string | undefined | null): string | null {
  if (!value) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const id = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return null
  let expected: string
  try {
    expected = sign(id)
  } catch {
    return null
  }
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return id
}

export function readSessionCookieValue(source: SessionSource): string | undefined {
  if (source instanceof Request) {
    const header = source.headers.get('cookie') ?? ''
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k === AT_SESSION_COOKIE) {
        try {
          return decodeURIComponent(rest.join('='))
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }
  return source.get(AT_SESSION_COOKIE)?.value
}

/** The verified session id carried by `source` (or Next's request cookies), or null. */
export async function sessionIdFrom(source?: SessionSource): Promise<string | null> {
  const src = source ?? (await cookies())
  return verifySessionCookie(readSessionCookieValue(src))
}

/**
 * Create a session row and return the cookie to set. `setCookie` is a complete
 * `Set-Cookie` header value; `value` is just the cookie's value.
 */
export async function createAtSession(input: {
  did: string
  accountId: string
  kind: AtSessionKind
}): Promise<{ id: string; value: string; setCookie: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + AT_SESSION_TTL_MS)
  await sql`
    insert into at_sessions (id, did, user_id, kind, expires_at)
    values (${id}, ${input.did}, ${input.accountId}, ${input.kind}, ${expiresAt})
  `
  const value = `${id}.${sign(id)}`
  return { id, value, setCookie: sessionCookieHeader(value), expiresAt }
}

/**
 * Read the session from a `Request` (its `cookie` header) or a cookie reader; when
 * omitted, reads Next's request cookies. Verifies the HMAC, loads the row, checks expiry.
 */
export async function readAtSession(source?: SessionSource): Promise<AtSession | null> {
  const id = await sessionIdFrom(source)
  if (!id) return null
  const rows = await sql<{ id: string; did: string; user_id: string; kind: AtSessionKind; expires_at: string }[]>`
    select id, did, user_id, kind, expires_at from at_sessions where id = ${id}
  `
  const row = rows[0]
  if (!row) return null
  const expiresAt = new Date(row.expires_at)
  if (expiresAt.getTime() <= Date.now()) {
    await sql`delete from at_sessions where id = ${id}`
    return null
  }
  return { id: row.id, did: row.did, accountId: row.user_id, userId: row.user_id, kind: row.kind, expiresAt }
}

/** Delete the session row (if any) and return the clearing `Set-Cookie` values. */
export async function destroyAtSession(source?: SessionSource): Promise<string[]> {
  const id = await sessionIdFrom(source)
  if (id) await sql`delete from at_sessions where id = ${id}`
  return clearSessionCookieHeaders()
}

/** Housekeeping: drop expired rows. Safe to call from a cron. */
export async function pruneExpiredAtSessions(): Promise<number> {
  const rows = await sql`delete from at_sessions where expires_at < now() returning id`
  return rows.length
}
