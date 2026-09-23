import 'server-only'
/**
 * Our reference PDS, admin-side. Ported from Free School `apps/appview/src/lib/pds.ts`.
 *
 * Everything here goes to `PDS_INTERNAL_URL` (fallback `PDS_URL`). The admin password
 * never leaves this module; passwords and emails passed through here are never logged.
 */
import { pdsAdminPassword, pdsInternalUrl } from '@/lib/atproto/config'

const TIMEOUT_MS = 10_000

export class PdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PdsError'
  }
}

function adminAuth(): string {
  return `Basic ${Buffer.from(`admin:${pdsAdminPassword()}`).toString('base64')}`
}

function base(): string {
  return pdsInternalUrl().replace(/\/+$/, '')
}

async function parse(res: Response, method: string): Promise<Record<string, unknown>> {
  const text = await res.text()
  let json: Record<string, unknown> = {}
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      json = {}
    }
  }
  if (!res.ok) {
    throw new PdsError(
      typeof json.message === 'string' ? json.message : `PDS ${method} failed (${res.status})`,
      res.status,
      typeof json.error === 'string' ? json.error : undefined,
    )
  }
  return json
}

async function post<T>(method: string, body: unknown, opts: { admin?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base()}/xrpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.admin ? { authorization: adminAuth() } : {}) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (e) {
    throw new PdsError(`PDS ${method} unreachable: ${e instanceof Error ? e.name : 'error'}`, 503, 'PdsUnreachable')
  }
  return (await parse(res, method)) as T
}

async function get<T>(url: URL, method: string, opts: { admin?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: opts.admin ? { authorization: adminAuth() } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (e) {
    throw new PdsError(`PDS ${method} unreachable: ${e instanceof Error ? e.name : 'error'}`, 503, 'PdsUnreachable')
  }
  return (await parse(res, method)) as T
}

/** `com.atproto.server.createInviteCode` (admin). */
export async function createInviteCode(uses = 1): Promise<string> {
  const out = await post<{ code: string }>('com.atproto.server.createInviteCode', { useCount: uses }, { admin: true })
  return out.code
}

/**
 * `com.atproto.server.createAccount`. The reference PDS requires an email for a
 * locally-hosted account (see `custody.ts#mintGatheringAccount`), so pass one.
 */
export async function createAccount(input: {
  email?: string
  handle: string
  password: string
  inviteCode: string
}): Promise<{ did: string; handle: string }> {
  const body: Record<string, string> = { handle: input.handle, password: input.password, inviteCode: input.inviteCode }
  if (input.email) body.email = input.email
  const out = await post<{ did: string; handle: string }>('com.atproto.server.createAccount', body)
  return { did: out.did, handle: out.handle }
}

/** `com.atproto.admin.updateAccountPassword` (admin) — rotate without the member's session. */
export async function updateAccountPassword(did: string, password: string): Promise<void> {
  await post('com.atproto.admin.updateAccountPassword', { did, password }, { admin: true })
}

/** `com.atproto.admin.deleteAccount` (admin). */
export async function deleteAccount(did: string): Promise<void> {
  await post('com.atproto.admin.deleteAccount', { did }, { admin: true })
}

/**
 * `com.atproto.server.deactivateAccount`, called with the account holder's OWN credential.
 *
 * This is what "delete my account" does to the PDS side of a custodial identity, and it is
 * deliberately not `deleteAccount`. A DID's PLC history is append-only and public by design:
 * the document, its rotation keys and every update are already mirrored by the directory and
 * by anyone who indexed them. Deleting the repository would not unpublish any of that; it
 * would only destroy the person's own copy of their records while the permanent part stayed
 * exactly where it is. Deactivation takes the repository out of circulation — the PDS stops
 * serving it and tells the relay — and leaves the person able to reactivate or migrate it
 * later, which is the only outcome here that is actually reversible by them.
 */
export async function deactivateAccountAs(identifier: string, password: string): Promise<void> {
  const session = await post<{ accessJwt: string }>('com.atproto.server.createSession', { identifier, password })
  let res: Response
  try {
    res = await fetch(`${base()}/xrpc/com.atproto.server.deactivateAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (e) {
    throw new PdsError(`PDS deactivateAccount unreachable: ${e instanceof Error ? e.name : 'error'}`, 503, 'PdsUnreachable')
  }
  await parse(res, 'com.atproto.server.deactivateAccount')
}

export interface AdminAccountSummary {
  did: string
  handle: string
}

/**
 * Find a PDS account by email, admin-side — the orphan self-heal in `custody.ts`.
 *
 * `com.atproto.admin.searchAccounts` only accepts a moderation-service bearer, never the
 * Basic admin token (verified against pds 0.4 by Free School), so walk
 * `com.atproto.sync.listRepos` and ask `com.atproto.admin.getAccountInfos` in batches.
 * Returns null for no match AND for an ambiguous (more than one) match.
 */
export async function searchAccountByEmail(email: string): Promise<AdminAccountSummary | null> {
  const wanted = email.trim().toLowerCase()
  const matches: AdminAccountSummary[] = []
  let cursor: string | undefined
  do {
    const listUrl = new URL(`${base()}/xrpc/com.atproto.sync.listRepos`)
    listUrl.searchParams.set('limit', '500')
    if (cursor) listUrl.searchParams.set('cursor', cursor)
    const list = await get<{ repos?: Array<{ did?: string }>; cursor?: string }>(listUrl, 'com.atproto.sync.listRepos')
    const dids = (list.repos ?? []).map((r) => r.did).filter((d): d is string => typeof d === 'string')
    for (let i = 0; i < dids.length; i += 50) {
      const infoUrl = new URL(`${base()}/xrpc/com.atproto.admin.getAccountInfos`)
      for (const did of dids.slice(i, i + 50)) infoUrl.searchParams.append('dids', did)
      const info = await get<{ infos?: Array<{ did?: string; handle?: string; email?: string }> }>(
        infoUrl,
        'com.atproto.admin.getAccountInfos',
        { admin: true },
      )
      for (const row of info.infos ?? []) {
        if (row.email?.trim().toLowerCase() === wanted && row.did && row.handle) {
          matches.push({ did: row.did, handle: row.handle })
        }
      }
    }
    cursor = list.cursor && dids.length > 0 ? list.cursor : undefined
  } while (cursor)
  if (matches.length > 1) {
    console.warn('[pds] account lookup by email matched more than one account; refusing to choose')
    return null
  }
  return matches[0] ?? null
}

/**
 * `com.atproto.identity.resolveHandle` against our PDS. `null` ONLY for the PDS's genuine
 * not-found answer; anything else non-2xx throws, so "not registered" and "could not ask"
 * stay distinguishable.
 */
export async function resolveHandleOnPds(handle: string): Promise<string | null> {
  const url = new URL(`${base()}/xrpc/com.atproto.identity.resolveHandle`)
  url.searchParams.set('handle', handle)
  try {
    const out = await get<{ did?: string }>(url, 'com.atproto.identity.resolveHandle')
    return out.did ?? null
  } catch (e) {
    if (e instanceof PdsError && e.status === 400 && (e.code === 'HandleNotFound' || /unable to resolve/i.test(e.message))) {
      return null
    }
    throw e
  }
}
