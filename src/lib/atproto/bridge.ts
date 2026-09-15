import 'server-only'
/**
 * The bridge between an ATProto OAuth callback and our `accounts` table.
 *
 *  - `encodeOAuthState` / `verifyOAuthState`   the opaque `state` we hand to
 *    `authorizeUrl` and get back from `handleCallback`. Signed with
 *    `ATPROTO_SESSION_SECRET`, so the callback can trust the purpose, the
 *    return path, the event and the acting account without a state table.
 *  - `findOrCreateOAuthAccount`   the `accounts` row (kind `oauth`) a DID signs in
 *    as. One account = one DID: a DID that already has a row (custodial or oauth)
 *    signs in AS that row; it is never attached to a different account.
 *  - `attachGatheringActor`   record a DID as an event's actor (OAuth credential).
 *
 * There is no session minting here any more: the `sp_at_session` cookie IS the
 * session (`session.ts`), for both doors.
 *
 * State wire format:
 *   `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payloadB64, secret))>`
 *   payload = { v: 1, purpose, next, eventId?, userId?, nonce, iat }
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { sql, tx } from '@/lib/db'
import { safeReturnPath } from '@/lib/auth-redirect'
import { sessionSecret } from './config'

/**
 * `link` is recognised only so it can be refused: attaching an OAuth identity to an
 * account that already has one (every account does) is not allowed.
 */
export const OAUTH_PURPOSES = ['signin', 'link', 'gathering'] as const
export type OAuthPurpose = (typeof OAUTH_PURPOSES)[number]

export function isOAuthPurpose(value: unknown): value is OAuthPurpose {
  return typeof value === 'string' && (OAUTH_PURPOSES as readonly string[]).includes(value)
}

export interface OAuthStatePayload {
  v: 1
  purpose: OAuthPurpose
  /** Where to send the browser afterwards. Always a same-site path. */
  next: string
  /** `gathering` only: the event whose actor is being connected. */
  eventId?: string
  /** `link` and `gathering`: the signed-in account (`accounts.id`) that started the flow. */
  userId?: string
  nonce: string
  /** Unix seconds. */
  iat: number
}

/** A state older than this is refused; the PDS consent screen never takes longer. */
export const OAUTH_STATE_TTL_SECONDS = 15 * 60

export class OAuthStateError extends Error {
  constructor(detail: string) {
    super(`invalid oauth state: ${detail}`)
    this.name = 'OAuthStateError'
  }
}

/** One-line description of any thrown value, for logs. */
export function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : JSON.stringify(err)
}

/* ───────────────────────────── state ───────────────────────────── */

function mac(payloadB64: string): string {
  return createHmac('sha256', sessionSecret()).update(payloadB64).digest('base64url')
}

export function encodeOAuthState(input: {
  purpose: OAuthPurpose
  next: string | null | undefined
  eventId?: string
  userId?: string
}): string {
  const payload: OAuthStatePayload = {
    v: 1,
    purpose: input.purpose,
    next: safeReturnPath(input.next),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    nonce: randomBytes(12).toString('base64url'),
    iat: Math.floor(Date.now() / 1000),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${payloadB64}.${mac(payloadB64)}`
}

/** Verify signature, shape and age. Throws `OAuthStateError`. */
export function verifyOAuthState(state: string | null | undefined): OAuthStatePayload {
  if (!state) throw new OAuthStateError('missing')
  const dot = state.lastIndexOf('.')
  if (dot <= 0) throw new OAuthStateError('malformed')
  const payloadB64 = state.slice(0, dot)
  const given = Buffer.from(state.slice(dot + 1))
  const expected = Buffer.from(mac(payloadB64))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OAuthStateError('bad signature')

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    throw new OAuthStateError('unparseable payload')
  }
  if (!payload || typeof payload !== 'object') throw new OAuthStateError('payload is not an object')
  const p = payload as Record<string, unknown>
  if (p.v !== 1) throw new OAuthStateError('unknown version')
  if (!isOAuthPurpose(p.purpose)) throw new OAuthStateError('unknown purpose')
  if (typeof p.next !== 'string') throw new OAuthStateError('missing next')
  if (typeof p.iat !== 'number' || typeof p.nonce !== 'string') throw new OAuthStateError('missing iat/nonce')
  if (Math.floor(Date.now() / 1000) - p.iat > OAUTH_STATE_TTL_SECONDS) throw new OAuthStateError('expired')
  if (p.eventId !== undefined && typeof p.eventId !== 'string') throw new OAuthStateError('bad eventId')
  if (p.userId !== undefined && typeof p.userId !== 'string') throw new OAuthStateError('bad userId')
  if ((p.purpose === 'link' || p.purpose === 'gathering') && !p.userId) throw new OAuthStateError(`${p.purpose} needs userId`)
  if (p.purpose === 'gathering' && !p.eventId) throw new OAuthStateError('gathering needs eventId')
  return {
    v: 1,
    purpose: p.purpose,
    next: safeReturnPath(p.next),
    ...(p.eventId ? { eventId: p.eventId as string } : {}),
    ...(p.userId ? { userId: p.userId as string } : {}),
    nonce: p.nonce,
    iat: p.iat,
  }
}

/* ─────────────────────────── authorization ─────────────────────────── */

/** Owner or admin of `eventId`? */
export async function isEventOrganizer(accountId: string, eventId: string): Promise<boolean> {
  const rows = await sql<{ role: string }[]>`
    select role from event_members where event_id = ${eventId} and user_id = ${accountId}
  `
  const role = rows[0]?.role
  return role === 'owner' || role === 'admin'
}

/* ───────────────────────── accounts ───────────────────────── */

export interface BridgedAccount {
  accountId: string
  did: string
  kind: 'custodial' | 'oauth'
  created: boolean
}

/**
 * The account a DID signs in as through the Bluesky door: its existing `accounts` row
 * (whatever the kind), else a new `kind = 'oauth'` row with `email = NULL`. The profile
 * row is created by the accounts trigger; its `did` / `atproto_handle` are filled here.
 */
export async function findOrCreateOAuthAccount(did: string, handle: string | null): Promise<BridgedAccount> {
  return tx(async (t) => {
    await t`select pg_advisory_xact_lock(hashtext(${did}))`
    const existing = await t<{ id: string; kind: 'custodial' | 'oauth'; handle: string | null }[]>`
      select id, kind, handle from accounts where did = ${did}
    `
    if (existing[0]) {
      const row = existing[0]
      if (handle && handle !== row.handle) {
        await t`update accounts set handle = ${handle} where id = ${row.id}`
        await t`update profiles set atproto_handle = ${handle} where id = ${row.id}`
      }
      return { accountId: row.id, did, kind: row.kind, created: false }
    }
    const inserted = await t<{ id: string }[]>`
      insert into accounts (did, handle, email, kind) values (${did}, ${handle}, null, 'oauth') returning id
    `
    const accountId = inserted[0]!.id
    await t`
      update profiles set did = ${did}, atproto_handle = ${handle}, atproto_linked_at = coalesce(atproto_linked_at, now())
      where id = ${accountId}
    `
    return { accountId, did, kind: 'oauth' as const, created: true }
  })
}

/**
 * Record `did` as the gathering actor for `eventId`. The OAuth session the library stored
 * under the DID is the credential; `at_credentials` only remembers that it exists and who
 * connected it.
 */
export async function attachGatheringActor(input: {
  eventId: string
  did: string
  handle: string | null
  pdsUrl: string | null
  userId: string
}): Promise<void> {
  await tx(async (t) => {
    await t`
      insert into at_credentials (did, kind, identifier, wrapped, key_version, pds_url, created_by, rotated_at, last_error, last_error_at)
      values (${input.did}, 'oauth', ${input.handle}, null, null, ${input.pdsUrl}, ${input.userId}, now(), null, null)
      on conflict (did) do update set
        kind = excluded.kind, identifier = excluded.identifier, wrapped = null, key_version = null,
        pds_url = excluded.pds_url, created_by = excluded.created_by, rotated_at = now(),
        last_error = null, last_error_at = null
    `
    await t`update events set actor_did = ${input.did}, actor_handle = ${input.handle} where id = ${input.eventId}`
  })
}
