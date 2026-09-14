import 'server-only'
/**
 * The bridge between an ATProto identity (a DID) and a Supabase auth user.
 *
 *  - `encodeOAuthState` / `verifyOAuthState`   the opaque `state` we hand to
 *    `authorizeUrl` and get back from `handleCallback`. Signed with
 *    `ATPROTO_SESSION_SECRET`, so the callback can trust the purpose, the
 *    return path, the event and the acting user without a state table.
 *  - `ensureSupabaseUserForDid`   find-or-create the Supabase user a DID signs
 *    in as (`<did-with-dashes>@atproto.schellingpoint.app`, never mailed).
 *  - `linkDidToProfile`   attach a DID to an existing member.
 *  - `attachGatheringActor`   record a DID as an event's actor (OAuth credential).
 *  - `mintSupabaseSession`   `generateLink` → `verifyOtp`, server-side, so the
 *    browser can land on `/auth/callback#access_token=…` exactly as it does
 *    after a magic link.
 *  - `unlinkDid`   detach a DID from a member and forget its sessions.
 *
 * State wire format:
 *   `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payloadB64, secret))>`
 *   payload = { v: 1, purpose, next, eventId?, userId?, nonce, iat }
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'
import { safeReturnPath } from '@/lib/auth-redirect'
import { sessionSecret } from './config'
import { revokeOAuthSession } from './oauth'

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
  /** `link` and `gathering`: the signed-in Supabase user who started the flow. */
  userId?: string
  nonce: string
  /** Unix seconds. */
  iat: number
}

/** A state older than this is refused; the PDS consent screen never takes longer. */
export const OAUTH_STATE_TTL_SECONDS = 15 * 60

/** Sign-in accounts created for a DID live under this domain. Never mailed. */
export const ATPROTO_EMAIL_DOMAIN = 'atproto.schellingpoint.app'

export class OAuthStateError extends Error {
  constructor(detail: string) {
    super(`invalid oauth state: ${detail}`)
    this.name = 'OAuthStateError'
  }
}

export class DidAlreadyLinkedError extends Error {
  constructor(readonly did: string) {
    super(`${did} is already linked to another account`)
    this.name = 'DidAlreadyLinkedError'
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
export async function isEventOrganizer(userId: string, eventId: string): Promise<boolean> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('event_members')
    .select('role')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`event_members get: ${error.message}`)
  return data?.role === 'owner' || data?.role === 'admin'
}

/* ───────────────────────── Supabase user bridge ───────────────────────── */

/** The synthetic, never-mailed address a DID-only account signs in under. */
export function emailForDid(did: string): string {
  return `${did.replace(/[^a-z0-9]/gi, '-').toLowerCase()}@${ATPROTO_EMAIL_DOMAIN}`
}

export function isDidOnlyEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${ATPROTO_EMAIL_DOMAIN}`)
}

export interface BridgedUser {
  userId: string
  email: string
  created: boolean
}

/**
 * The Supabase user for a DID: the profile already carrying `did`, else a
 * fresh auth user (email confirmed) whose `profiles` row `handle_new_user`
 * creates. Sets `did` / `atproto_handle` / `atproto_linked_at` on the profile.
 */
export async function ensureSupabaseUserForDid(did: string, handle: string | null): Promise<BridgedUser> {
  const db = await createAdminClient()

  const { data: existing, error: lookupError } = await db
    .from('profiles')
    .select('id, email, atproto_handle')
    .eq('did', did)
    .maybeSingle()
  if (lookupError) throw new Error(`profiles lookup by did: ${lookupError.message}`)

  if (existing) {
    const userId = existing.id as string
    // `profiles.email` mirrors auth at creation; the auth record is authoritative.
    const { data: authUser } = await db.auth.admin.getUserById(userId)
    const email = authUser?.user?.email ?? (existing.email as string)
    if (!email) throw new Error(`user ${userId} has no email to mint a session for`)
    if (handle && handle !== existing.atproto_handle) {
      await db.from('profiles').update({ atproto_handle: handle }).eq('id', userId)
    }
    return { userId, email, created: false }
  }

  const email = emailForDid(did)
  let userId: string | undefined
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { did, handle, display_name: handle ?? did },
  })
  if (createError) {
    // The auth user survived an earlier unlink; recover it through generateLink,
    // which returns the user for an existing address without sending mail.
    const { data: linkData, error: linkError } = await db.auth.admin.generateLink({ type: 'magiclink', email })
    if (linkError || !linkData?.user) throw new Error(`createUser: ${createError.message}`)
    userId = linkData.user.id
  } else {
    userId = created.user.id
  }

  // The trigger inserted the profile inside the same transaction as auth.users.
  const { error: updateError } = await db
    .from('profiles')
    .update({ did, atproto_handle: handle, atproto_linked_at: new Date().toISOString() })
    .eq('id', userId)
  if (updateError) throw new Error(`profiles link: ${updateError.message}`)

  return { userId, email, created: true }
}

/** Attach `did` to an existing member. Throws `DidAlreadyLinkedError` when another profile owns it. */
export async function linkDidToProfile(userId: string, did: string, handle: string | null): Promise<void> {
  const db = await createAdminClient()
  const { data: holder, error: lookupError } = await db.from('profiles').select('id').eq('did', did).maybeSingle()
  if (lookupError) throw new Error(`profiles lookup by did: ${lookupError.message}`)
  if (holder && holder.id !== userId) throw new DidAlreadyLinkedError(did)

  const { error } = await db
    .from('profiles')
    .update({ did, atproto_handle: handle, atproto_linked_at: new Date().toISOString() })
    .eq('id', userId)
  if (error) throw new Error(`profiles link: ${error.message}`)
}

/**
 * Record `did` as the gathering actor for `eventId`. The OAuth session the
 * library stored under the DID is the credential; `at_credentials` only
 * remembers that it exists and who connected it.
 */
export async function attachGatheringActor(input: {
  eventId: string
  did: string
  handle: string | null
  pdsUrl: string | null
  userId: string
}): Promise<void> {
  const db = await createAdminClient()
  const { error: credError } = await db.from('at_credentials').upsert(
    {
      did: input.did,
      kind: 'oauth',
      identifier: input.handle,
      wrapped: null,
      key_version: null,
      pds_url: input.pdsUrl,
      created_by: input.userId,
      rotated_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    },
    { onConflict: 'did' },
  )
  if (credError) throw new Error(`at_credentials upsert: ${credError.message}`)

  const { error: eventError } = await db
    .from('events')
    .update({ actor_did: input.did, actor_handle: input.handle })
    .eq('id', input.eventId)
  if (eventError) throw new Error(`events set actor: ${eventError.message}`)
}

/* ───────────────────────── session minting ───────────────────────── */

export interface MintedSession {
  access_token: string
  refresh_token: string
  expires_in: number
}

/**
 * A Supabase session for `email` without any mail: the admin client issues a
 * magic-link token hash, the anon client redeems it. The result is what the
 * implicit flow would have put in the URL hash.
 */
export async function mintSupabaseSession(email: string): Promise<MintedSession> {
  const admin = await createAdminClient()
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data?.properties?.hashed_token) throw new Error(`generateLink: ${error?.message ?? 'no token'}`)

  const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyError || !verified.session) throw new Error(`verifyOtp: ${verifyError?.message ?? 'no session'}`)
  const s = verified.session
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in }
}

/** The `/auth/callback` URL that installs a minted session, exactly as a magic link would. */
export function implicitCallbackPath(session: MintedSession, next: string): string {
  const hash = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: String(session.expires_in),
    token_type: 'bearer',
  })
  return `/auth/callback?next=${encodeURIComponent(safeReturnPath(next))}#${hash.toString()}`
}

/* ───────────────────────────── unlink ───────────────────────────── */

/**
 * Detach a DID from a member: clear the profile columns, drop browser
 * sessions bound to the DID, revoke the stored OAuth session (best-effort).
 */
export async function unlinkDid(userId: string, did: string): Promise<void> {
  const db = await createAdminClient()
  const { error } = await db
    .from('profiles')
    .update({ did: null, atproto_handle: null, atproto_linked_at: null, publish_proposals: false })
    .eq('id', userId)
    .eq('did', did)
  if (error) throw new Error(`profiles unlink: ${error.message}`)
  await db.from('at_sessions').delete().eq('did', did)
  try {
    await revokeOAuthSession(did)
  } catch (e) {
    console.warn('[atproto] revoke on unlink failed:', describe(e))
  }
}
