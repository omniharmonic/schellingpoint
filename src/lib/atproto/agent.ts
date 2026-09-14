import 'server-only'
/**
 * An authenticated `Agent` for a DID's OWN repo.
 *
 * Two doors, one shape:
 *   - `app-password`  a credential we custody (`at_credentials`, AES-wrapped):
 *                     the gathering actor, or a custodial member account.
 *                     Logged in once per process and cached; re-login on
 *                     `ExpiredToken` / 401.
 *   - `oauth`         restore the stored OAuth session and wrap it in an `Agent`.
 *
 * Mirrors Free School's `apps/appview/src/lib/actor-agent.ts`. The gathering
 * actor's agent must only ever be obtained through `actor.ts` so every write
 * as the gathering is authorised and audited.
 */
import { Agent, AtpAgent, XRPCError } from '@atproto/api'
import { createAdminClient } from '@/lib/supabase/server'
import { defaultPdsUrl } from './config'
import { unwrapSecret } from './crypto'
import { restoreOAuthSession } from './oauth'

export class NoActorCredentialError extends Error {
  constructor(readonly did: string) {
    super(`no usable credential for ${did}`)
    this.name = 'NoActorCredentialError'
  }
}

export class ProfileNotLinkedError extends Error {
  constructor(readonly userId: string) {
    super(`profile ${userId} has no linked DID`)
    this.name = 'ProfileNotLinkedError'
  }
}

interface CredentialRow {
  did: string
  kind: 'oauth' | 'app-password'
  identifier: string | null
  wrapped: string | null
  key_version: string | null
  pds_url: string | null
}

const cache = new Map<string, AtpAgent>()

async function loadCredential(did: string): Promise<CredentialRow | null> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('at_credentials')
    .select('did, kind, identifier, wrapped, key_version, pds_url')
    .eq('did', did)
    .maybeSingle()
  if (error) throw new Error(`at_credentials get: ${error.message}`)
  return (data as CredentialRow | null) ?? null
}

async function markCredential(did: string, ok: boolean, message?: string): Promise<void> {
  const db = await createAdminClient()
  const now = new Date().toISOString()
  await db
    .from('at_credentials')
    .update(ok ? { last_ok_at: now, last_error: null } : { last_error_at: now, last_error: message?.slice(0, 500) ?? 'error' })
    .eq('did', did)
}

async function loginWithAppPassword(row: CredentialRow): Promise<AtpAgent> {
  if (!row.wrapped || !row.key_version || !row.identifier) throw new NoActorCredentialError(row.did)
  const password = unwrapSecret(row.wrapped, row.key_version)
  const agent = new AtpAgent({ service: row.pds_url ?? defaultPdsUrl() })
  try {
    await agent.login({ identifier: row.identifier, password })
  } catch (e) {
    await markCredential(row.did, false, e instanceof Error ? e.message : String(e))
    throw e
  }
  await markCredential(row.did, true)
  return agent
}

export function isAuthExpiredError(e: unknown): boolean {
  if (e instanceof XRPCError) return e.status === 401 || e.error === 'ExpiredToken' || e.error === 'InvalidToken'
  const err = e as { status?: number; error?: string } | undefined
  return err?.status === 401 || err?.error === 'ExpiredToken' || err?.error === 'InvalidToken'
}

/** Drop a cached app-password agent (after rotation, or on auth failure). */
export function evictAgent(did: string): void {
  cache.delete(did)
}

/**
 * Agent for `did`. Throws `NoActorCredentialError` when we hold nothing usable.
 * App-password agents are cached per DID; pass `{ fresh: true }` to force a
 * re-login (the caller saw `ExpiredToken`/401).
 */
export async function agentForDid(did: string, opts: { fresh?: boolean } = {}): Promise<Agent> {
  const row = await loadCredential(did)
  if (row?.kind === 'app-password') {
    if (!opts.fresh) {
      const cached = cache.get(did)
      if (cached?.session) return cached
    }
    const agent = await loginWithAppPassword(row)
    cache.set(did, agent)
    return agent
  }
  // OAuth: either an explicit `oauth` credential row or none at all — the
  // stored OAuth session (at_oauth_session) is the credential.
  try {
    const session = await restoreOAuthSession(did)
    return new Agent(session)
  } catch {
    throw new NoActorCredentialError(did)
  }
}

/**
 * Run `fn` with an agent for `did`, retrying once with a fresh login when the
 * PDS reports an expired/invalid token. Use this around any write.
 */
export async function withAgentForDid<T>(did: string, fn: (agent: Agent) => Promise<T>): Promise<T> {
  const agent = await agentForDid(did)
  try {
    return await fn(agent)
  } catch (e) {
    if (!isAuthExpiredError(e)) throw e
    evictAgent(did)
    return fn(await agentForDid(did, { fresh: true }))
  }
}

/** Resolve `profiles.did` for a Supabase user, then `agentForDid`. */
export async function agentForUser(userId: string): Promise<Agent> {
  const db = await createAdminClient()
  const { data, error } = await db.from('profiles').select('did').eq('id', userId).maybeSingle()
  if (error) throw new Error(`profiles get: ${error.message}`)
  const did = (data?.did as string | null) ?? null
  if (!did) throw new ProfileNotLinkedError(userId)
  return agentForDid(did)
}
