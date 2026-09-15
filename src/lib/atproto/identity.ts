import 'server-only'
/**
 * Identity resolution and AT-URI helpers.
 *
 *  - handle → DID   DNS `_atproto` TXT, then `/.well-known/atproto-did`, then
 *                   an XRPC `com.atproto.identity.resolveHandle` fallback on
 *                   `ATPROTO_HANDLE_RESOLVER` (defaults to bsky.social).
 *  - DID → doc      `did:plc` via plc.directory, `did:web` via the host; the
 *                   result carries the PDS endpoint and the declared handle.
 *
 * Resolution results are cached in-process for an hour (`MemoryCache`).
 */
import { AtpAgent } from '@atproto/api'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { AtUri } from '@atproto/syntax'
import { defaultPdsUrl, handleResolverUrl, pdsInternalUrl } from './config'

const HOUR = 60 * 60 * 1000

/**
 * The PLC directory foreign DIDs resolve against. `ATPROTO_PLC_URL` overrides the public
 * directory; DIDs hosted on OUR PDS never need it (see `describeOwnRepo`), which is what
 * lets a local stack with a private PLC read the public skills authority at the same time.
 */
function plcUrl(): string | undefined {
  const v = process.env.ATPROTO_PLC_URL?.trim()
  return v ? v.replace(/\/+$/, '') : undefined
}

let resolver: IdResolver | undefined
function idResolver(): IdResolver {
  if (!resolver) {
    resolver = new IdResolver({ didCache: new MemoryCache(HOUR, 24 * HOUR), timeout: 5000, ...(plcUrl() ? { plcUrl: plcUrl() } : {}) })
  }
  return resolver
}

export interface OwnRepo {
  did: string
  handle: string | null
}

const ownRepoCache = new Map<string, { value: OwnRepo | null; at: number }>()
const OWN_REPO_TTL_MS = 10 * 60 * 1000
const OWN_REPO_CACHE_CAP = 2048

/**
 * `com.atproto.repo.describeRepo` against OUR PDS (internal URL). A DID our PDS hosts is read
 * and written there directly — never over the public edge, never via a DID-document lookup.
 * `null` when our PDS does not host the repo (its genuine `RepoNotFound`), throws when the
 * PDS could not be asked, so "not ours" and "could not tell" stay distinguishable.
 */
export async function describeOwnRepo(did: string): Promise<OwnRepo | null> {
  const hit = ownRepoCache.get(did)
  if (hit && Date.now() - hit.at < OWN_REPO_TTL_MS) return hit.value
  const url = new URL(`${pdsInternalUrl()}/xrpc/com.atproto.repo.describeRepo`)
  url.searchParams.set('repo', did)
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
  let value: OwnRepo | null
  if (res.ok) {
    const body = (await res.json()) as { did?: string; handle?: string }
    value = { did: body.did ?? did, handle: body.handle && body.handle !== 'handle.invalid' ? body.handle : null }
  } else if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error !== 'RepoNotFound' && body.error !== 'RepoDeactivated' && body.error !== 'RepoTakendown') {
      throw new Error(`describeRepo failed (${body.error ?? res.status})`)
    }
    value = null
  } else {
    throw new Error(`describeRepo failed (${res.status})`)
  }
  if (ownRepoCache.size >= OWN_REPO_CACHE_CAP) ownRepoCache.delete(ownRepoCache.keys().next().value as string)
  ownRepoCache.set(did, { value, at: Date.now() })
  return value
}

/** Forget what we know about a repo's host (after an account is minted, deleted or migrated). */
export function forgetOwnRepo(did: string): void {
  ownRepoCache.delete(did)
}

export class HandleNotFoundError extends Error {
  constructor(readonly handle: string) {
    super(`could not resolve handle ${handle}`)
    this.name = 'HandleNotFoundError'
  }
}

export class DidNotFoundError extends Error {
  constructor(readonly did: string) {
    super(`could not resolve DID document for ${did}`)
    this.name = 'DidNotFoundError'
  }
}

const HANDLE_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i

export function isDid(value: string): boolean {
  return /^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(value)
}

export function isHandle(value: string): boolean {
  return HANDLE_RE.test(value)
}

/** Handle → DID. Accepts a leading `@`. Throws `HandleNotFoundError`. */
export async function resolveHandle(handle: string): Promise<string> {
  const h = handle.trim().replace(/^@/, '').toLowerCase()
  if (isDid(h)) return h
  if (!isHandle(h)) throw new HandleNotFoundError(handle)
  const did = await idResolver().handle.resolve(h).catch(() => undefined)
  if (did) return did
  // Fallback: ask a PDS/AppView that knows more handles than DNS does.
  try {
    const agent = new AtpAgent({ service: handleResolverUrl() })
    const res = await agent.com.atproto.identity.resolveHandle({ handle: h })
    if (res.data.did) return res.data.did
  } catch {
    // fall through
  }
  throw new HandleNotFoundError(handle)
}

export interface ResolvedDid {
  did: string
  /** PDS service endpoint (`https://…`). */
  pds: string
  /** The handle the DID document declares (not bidirectionally verified here). */
  handle: string | null
  signingKey: string
}

/**
 * DID → { pds, handle }. A repo on our own PDS answers from the PDS itself (its public URL is
 * what the DID document names); anything else resolves through PLC / did:web. Throws
 * `DidNotFoundError`.
 */
export async function resolveDidDoc(did: string): Promise<ResolvedDid> {
  if (!isDid(did)) throw new DidNotFoundError(did)
  const own = await describeOwnRepo(did).catch(() => null)
  if (own) return { did, pds: defaultPdsUrl(), handle: own.handle, signingKey: '' }
  try {
    const data = await idResolver().did.resolveAtprotoData(did)
    return { did: data.did, pds: data.pds.replace(/\/+$/, ''), handle: data.handle || null, signingKey: data.signingKey }
  } catch {
    throw new DidNotFoundError(did)
  }
}

/** Handle-or-DID → DID. */
export async function resolveIdentifier(handleOrDid: string): Promise<string> {
  const v = handleOrDid.trim().replace(/^@/, '')
  return isDid(v) ? v : resolveHandle(v)
}

/** `at://<did>/<collection>/<rkey>` */
export function atUri(did: string, collection: string, rkey: string): string {
  return AtUri.make(did, collection, rkey).toString()
}

export interface ParsedAtUri {
  did: string
  collection: string
  rkey: string
}

/** Parse an AT-URI into its parts. Throws on malformed input or a missing collection/rkey. */
export function parseAtUri(uri: string): ParsedAtUri {
  const u = new AtUri(uri)
  if (!u.collection || !u.rkey) throw new Error(`AT-URI must name a collection and rkey: ${uri}`)
  return { did: u.hostname, collection: u.collection, rkey: u.rkey }
}
