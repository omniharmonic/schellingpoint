import 'server-only'
/**
 * An authenticated `Agent` for a DID's OWN repo.
 *
 * Where the credential comes from:
 *   - `accounts` kind `custodial`  the wrapped password we hold for a member minted on our
 *                                  PDS. Logged in against `PDS_INTERNAL_URL`, cached per
 *                                  DID, re-login on `ExpiredToken` / 401. Refused
 *                                  (`NoActorCredentialError`) once the member has taken
 *                                  ownership (`owned_at` set) — from then on publishing
 *                                  needs a real sign-in through the Bluesky door.
 *   - `accounts` kind `oauth`      the stored OAuth session, restored and wrapped.
 *   - `at_credentials`             gathering actors: `app-password` (minted on our PDS,
 *                                  wrapped) or `oauth` (an organizer's existing account).
 *
 * Mirrors Free School's `apps/appview/src/lib/actor-agent.ts`. The gathering actor's agent
 * must only ever be obtained through `actor.ts` so every write as the gathering is
 * authorised and audited.
 */
import { Agent, AtpAgent, XRPCError } from '@atproto/api'
import { sql } from '@/lib/db'
import { safeFetch } from '@/lib/net/safe-fetch'
import { defaultPdsUrl, pdsInternalUrl } from './config'
import { unwrapSecret } from './crypto'
import { restoreOAuthSession } from './oauth'

export class NoActorCredentialError extends Error {
  constructor(readonly did: string) {
    super(`no usable credential for ${did}`)
    this.name = 'NoActorCredentialError'
  }
}

/** Thrown when an account id names no account (kept under its historical name). */
export class ProfileNotLinkedError extends Error {
  constructor(readonly userId: string) {
    super(`account ${userId} has no DID`)
    this.name = 'ProfileNotLinkedError'
  }
}

interface AccountRow {
  id: string
  did: string
  handle: string | null
  kind: 'custodial' | 'oauth'
  wrapped_password: Buffer | null
  key_version: string | null
  owned_at: string | null
}

interface CredentialRow {
  did: string
  kind: 'oauth' | 'app-password'
  identifier: string | null
  wrapped: Buffer | null
  key_version: string | null
  pds_url: string | null
}

const cache = new Map<string, AtpAgent>()

/** A credential row's `pds_url` names the public PDS; reach our own through the internal URL. */
function serviceFor(pdsUrl: string | null): { url: string; internal: boolean } {
  const url = (pdsUrl ?? defaultPdsUrl()).replace(/\/+$/, '')
  return url === defaultPdsUrl() ? { url: pdsInternalUrl(), internal: true } : { url, internal: false }
}

async function loadAccountById(accountId: string): Promise<AccountRow | null> {
  const rows = await sql<AccountRow[]>`
    select id, did, handle, kind, wrapped_password, key_version, owned_at from accounts where id = ${accountId}
  `
  return rows[0] ?? null
}

async function loadAccountByDid(did: string): Promise<AccountRow | null> {
  const rows = await sql<AccountRow[]>`
    select id, did, handle, kind, wrapped_password, key_version, owned_at from accounts where did = ${did}
  `
  return rows[0] ?? null
}

async function loadCredential(did: string): Promise<CredentialRow | null> {
  const rows = await sql<CredentialRow[]>`
    select did, kind, identifier, wrapped, key_version, pds_url from at_credentials where did = ${did}
  `
  return rows[0] ?? null
}

async function markCredential(did: string, ok: boolean, message?: string): Promise<void> {
  try {
    if (ok) await sql`update at_credentials set last_ok_at = now(), last_error = null where did = ${did}`
    else {
      const detail = message?.slice(0, 500) ?? 'error'
      await sql`update at_credentials set last_error_at = now(), last_error = ${detail} where did = ${did}`
    }
  } catch {
    // Bookkeeping only.
  }
}

async function login(service: { url: string; internal: boolean }, identifier: string, password: string): Promise<AtpAgent> {
  // SSRF guard: a PDS that is not ours is reached only through safeFetch.
  const agent = new AtpAgent({ service: service.url, ...(service.internal ? {} : { fetch: safeFetch }) })
  await agent.login({ identifier, password })
  return agent
}

export function isAuthExpiredError(e: unknown): boolean {
  if (e instanceof XRPCError) return e.status === 401 || e.error === 'ExpiredToken' || e.error === 'InvalidToken'
  const err = e as { status?: number; error?: string } | undefined
  return err?.status === 401 || err?.error === 'ExpiredToken' || err?.error === 'InvalidToken'
}

/** Drop a cached password agent (after rotation, take-ownership, or an auth failure). */
export function evictAgent(did: string): void {
  cache.delete(did)
}

async function agentForAccountRow(account: AccountRow, opts: { fresh?: boolean }): Promise<Agent> {
  if (account.kind === 'oauth') {
    try {
      return new Agent(await restoreOAuthSession(account.did))
    } catch {
      throw new NoActorCredentialError(account.did)
    }
  }
  if (account.owned_at || !account.wrapped_password || !account.key_version) {
    evictAgent(account.did)
    throw new NoActorCredentialError(account.did)
  }
  if (!opts.fresh) {
    const cached = cache.get(account.did)
    if (cached?.session) return cached
  }
  const password = unwrapSecret(account.wrapped_password, account.key_version)
  const agent = await login({ url: pdsInternalUrl(), internal: true }, account.did, password)
  cache.set(account.did, agent)
  return agent
}

/** Agent for a member's own repo, by `accounts.id`. */
export async function agentForAccount(accountId: string, opts: { fresh?: boolean } = {}): Promise<Agent> {
  const account = await loadAccountById(accountId)
  if (!account) throw new ProfileNotLinkedError(accountId)
  return agentForAccountRow(account, opts)
}

/** @deprecated alias of `agentForAccount` — the old name read `profiles.did`. */
export const agentForUser = agentForAccount

/**
 * Agent for `did`: an `accounts` row first (members), else `at_credentials` (gathering
 * actors). Throws `NoActorCredentialError` when we hold nothing usable.
 */
export async function agentForDid(did: string, opts: { fresh?: boolean } = {}): Promise<Agent> {
  const account = await loadAccountByDid(did)
  if (account) return agentForAccountRow(account, opts)

  const row = await loadCredential(did)
  if (row?.kind === 'app-password') {
    if (!opts.fresh) {
      const cached = cache.get(did)
      if (cached?.session) return cached
    }
    if (!row.wrapped || !row.key_version || !row.identifier) throw new NoActorCredentialError(did)
    const password = unwrapSecret(row.wrapped, row.key_version)
    try {
      const agent = await login(serviceFor(row.pds_url), row.identifier, password)
      await markCredential(did, true)
      cache.set(did, agent)
      return agent
    } catch (e) {
      await markCredential(did, false, e instanceof Error ? e.message : String(e))
      throw e
    }
  }
  // OAuth: an explicit `oauth` credential row or none at all — the stored OAuth session is the credential.
  try {
    return new Agent(await restoreOAuthSession(did))
  } catch {
    throw new NoActorCredentialError(did)
  }
}

/**
 * Run `fn` with an agent for `did`, retrying once with a fresh login when the PDS reports
 * an expired/invalid token. Use this around any write.
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
