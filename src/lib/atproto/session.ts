import 'server-only'
/**
 * The `sp_at_session` cookie: a browser session bound to a DID.
 *
 * Cookie value is `<id>.<hmac-sha256(id, ATPROTO_SESSION_SECRET)>` where `id`
 * is the primary key of an `at_sessions` row. The HMAC lets us reject forged
 * ids without a database round-trip; the row carries the DID, the linked
 * profile (if any), which door the session came through, and its expiry.
 *
 * HttpOnly, SameSite=Lax, Path=/, 30 days, Secure when the public URL is https.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/server'
import { publicUrl, sessionSecret } from './config'

export const AT_SESSION_COOKIE = 'sp_at_session'
export const AT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type AtSessionKind = 'oauth' | 'app-password'

export interface AtSession {
  id: string
  did: string
  userId: string | null
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

function isSecure(): boolean {
  try {
    return new URL(publicUrl()).protocol === 'https:'
  } catch {
    return false
  }
}

function cookieAttributes(maxAgeSeconds: number): string {
  return [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAgeSeconds}`, ...(isSecure() ? ['Secure'] : [])].join('; ')
}

/** `Set-Cookie` header value that installs `value`. */
export function sessionCookieHeader(value: string): string {
  return `${AT_SESSION_COOKIE}=${value}; ${cookieAttributes(Math.floor(AT_SESSION_TTL_MS / 1000))}`
}

/** `Set-Cookie` header value that clears the cookie. */
export function clearSessionCookieHeader(): string {
  return `${AT_SESSION_COOKIE}=; ${cookieAttributes(0)}`
}

/** Parse and verify a cookie value. Returns the session id or null. */
export function verifySessionCookie(value: string | undefined | null): string | null {
  if (!value) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const id = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return null
  const expected = sign(id)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return id
}

function readCookieValue(source: SessionSource): string | undefined {
  if (source instanceof Request) {
    const header = source.headers.get('cookie') ?? ''
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k === AT_SESSION_COOKIE) return decodeURIComponent(rest.join('='))
    }
    return undefined
  }
  return source.get(AT_SESSION_COOKIE)?.value
}

/**
 * Create a session row and return the cookie to set. `setCookie` is a
 * complete `Set-Cookie` header value; `value` is just the cookie's value for
 * callers that use Next's `cookies().set()`.
 */
export async function createAtSession(input: {
  did: string
  userId?: string | null
  kind: AtSessionKind
}): Promise<{ id: string; value: string; setCookie: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + AT_SESSION_TTL_MS)
  const db = await createAdminClient()
  const { error } = await db.from('at_sessions').insert({
    id,
    did: input.did,
    user_id: input.userId ?? null,
    kind: input.kind,
    expires_at: expiresAt.toISOString(),
  })
  if (error) throw new Error(`at_sessions insert: ${error.message}`)
  const value = `${id}.${sign(id)}`
  return { id, value, setCookie: sessionCookieHeader(value), expiresAt }
}

/**
 * Read the session from a `Request` (its `cookie` header) or a cookie reader
 * (`await cookies()`); when omitted, reads Next's request cookies. Verifies
 * the HMAC, loads the row, checks expiry. Null when absent or invalid.
 */
export async function readAtSession(source?: SessionSource): Promise<AtSession | null> {
  const src = source ?? (await cookies())
  const id = verifySessionCookie(readCookieValue(src))
  if (!id) return null
  const db = await createAdminClient()
  const { data, error } = await db
    .from('at_sessions')
    .select('id, did, user_id, kind, expires_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`at_sessions get: ${error.message}`)
  if (!data) return null
  const expiresAt = new Date(data.expires_at as string)
  if (expiresAt.getTime() <= Date.now()) {
    await db.from('at_sessions').delete().eq('id', id)
    return null
  }
  return {
    id: data.id as string,
    did: data.did as string,
    userId: (data.user_id as string | null) ?? null,
    kind: data.kind as AtSessionKind,
    expiresAt,
  }
}

/** Delete the session row (if any) and return the clearing `Set-Cookie` value. */
export async function destroyAtSession(source?: SessionSource): Promise<string> {
  const src = source ?? (await cookies())
  const id = verifySessionCookie(readCookieValue(src))
  if (id) {
    const db = await createAdminClient()
    await db.from('at_sessions').delete().eq('id', id)
  }
  return clearSessionCookieHeader()
}

/** Housekeeping: drop expired rows. Safe to call from a cron. */
export async function pruneExpiredAtSessions(): Promise<number> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('at_sessions')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('id')
  if (error) throw new Error(`at_sessions prune: ${error.message}`)
  return data?.length ?? 0
}
