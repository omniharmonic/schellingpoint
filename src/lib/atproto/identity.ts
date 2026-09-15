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
import { assertPublicServiceUrl, safeFetch } from '@/lib/net/safe-fetch'
import { defaultPdsUrl, handleResolverUrl, isProduction, pdsInternalUrl } from './config'

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
/** The PLC URL the cached resolver was built with; a changed configuration rebuilds it. */
let resolverPlcUrl: string | undefined
function idResolver(): IdResolver {
  if (resolver && resolverPlcUrl !== plcUrl()) resolver = undefined
  if (!resolver) {
    resolverPlcUrl = plcUrl()
    resolver = new IdResolver({
      didCache: new MemoryCache(HOUR, 24 * HOUR),
      timeout: 5000,
      ...(plcUrl() ? { plcUrl: plcUrl() } : {}),
      // SSRF guard: PLC, did:web and handle well-known fetches go through the connect-time
      // address check (and reach a configured local PLC outside production).
      fetch: safeFetch,
    })
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

/**
 * Forget every identity fact cached for `did` in this module: the DID document (PLC / did:web
 * cache) and whether our PDS hosts it. Called on a relay `#identity` event. (`service-url.ts`
 * holds no cache; `write.ts` read agents and the gathering actor registry are evicted by the
 * caller, `repo-status.ts`.)
 */
export async function forgetIdentity(did: string): Promise<void> {
  ownRepoCache.delete(did)
  await idResolver().did.cache?.clearEntry(did).catch(() => undefined)
}

/** The first `at://` handle a DID document claims, lower-cased; null when none. */
export function handleFromDidDoc(doc: { alsoKnownAs?: unknown } | null | undefined): string | null {
  const aka = Array.isArray(doc?.alsoKnownAs) ? (doc!.alsoKnownAs as unknown[]) : []
  for (const entry of aka) {
    if (typeof entry === 'string' && entry.startsWith('at://')) {
      const h = entry.slice('at://'.length).toLowerCase()
      return isHandle(h) ? h : null
    }
  }
  return null
}

/** How a handle is verified: the DID document's claim, and where that handle resolves. Injectable for tests. */
export interface HandleVerifier {
  /** The handle the DID document claims (fresh, never cached). `undefined` = the document could not be read. */
  claimedHandle(did: string): Promise<string | null | undefined>
  /** Handle → DID, or null when it does not resolve. */
  resolveHandle(handle: string): Promise<string | null>
}

function underOurHandleDomain(handle: string): boolean {
  const domain = process.env.PDS_HANDLE_DOMAIN?.trim().replace(/^\.+|\.+$/g, '').toLowerCase()
  return !!domain && (handle === domain || handle.endsWith(`.${domain}`))
}

/**
 * The PLC directory OUR PDS writes its accounts' operations to (`PDS_PLC_URL`; production: the
 * public directory). Operator configuration, so a plain fetch. Read directly — never through the
 * PDS's `describeRepo`, whose DID document comes from the PDS's own cache and stays stale for up
 * to an hour after a handle change.
 */
function pdsPlcUrl(): string {
  const v = process.env.PDS_PLC_URL?.trim() || process.env.ATPROTO_PLC_URL?.trim() || 'https://plc.directory'
  return v.replace(/\/+$/, '')
}

/**
 * The production verifier. The DID document is read fresh: for a did:plc our PDS hosts, straight
 * from the PLC directory our PDS writes to; for anything else through PLC / did:web with the cache
 * bypassed (`safeFetch`). A handle under our own handle domain resolves on our PDS (its authority);
 * any other handle through DNS / well-known / the resolver fallback, all behind `safeFetch`.
 */
export const defaultHandleVerifier: HandleVerifier = {
  async claimedHandle(did) {
    const own = did.startsWith('did:plc:') ? await ownPdsHosts(did) : false
    if (own) {
      const res = await fetch(`${pdsPlcUrl()}/${encodeURIComponent(did)}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }).catch(() => null)
      if (!res?.ok) return undefined
      const doc = (await res.json().catch(() => null)) as { alsoKnownAs?: unknown } | null
      return doc ? handleFromDidDoc(doc) : undefined
    }
    if (!isAllowedDidWeb(did)) return undefined
    try {
      const doc = await idResolver().did.resolve(did, true)
      return doc ? handleFromDidDoc(doc as { alsoKnownAs?: unknown }) : undefined
    } catch {
      return undefined
    }
  },
  async resolveHandle(handle) {
    if (underOurHandleDomain(handle)) {
      const url = new URL(`${pdsInternalUrl()}/xrpc/com.atproto.identity.resolveHandle`)
      url.searchParams.set('handle', handle)
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' }).catch(() => null)
      if (!res?.ok) return null
      const body = (await res.json().catch(() => ({}))) as { did?: string }
      return body.did ?? null
    }
    return resolveHandle(handle).catch(() => null)
  },
}

/** Does OUR PDS host this repo (in any state)? `getRepoStatus` answers for taken-down repos too. */
async function ownPdsHosts(did: string): Promise<boolean> {
  const url = new URL(`${pdsInternalUrl()}/xrpc/com.atproto.sync.getRepoStatus`)
  url.searchParams.set('did', did)
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' }).catch(() => null)
  return !!res?.ok
}

export type VerifiedHandle =
  | { state: 'verified'; handle: string }
  | { state: 'invalid'; claimed: string | null }
  | { state: 'unresolvable' }

/**
 * Bidirectional handle verification (atproto identity spec): the DID document claims the handle
 * AND the handle resolves back to the same DID. Anything less is `invalid` (store NULL; display
 * falls back to the DID). `unresolvable` = the DID document itself could not be read (keep what
 * we had; try again later).
 */
export async function verifyHandleForDid(did: string, verifier: HandleVerifier = defaultHandleVerifier): Promise<VerifiedHandle> {
  const claimed = await verifier.claimedHandle(did)
  if (claimed === undefined) return { state: 'unresolvable' }
  if (!claimed || claimed === 'handle.invalid') return { state: 'invalid', claimed: null }
  const back = await verifier.resolveHandle(claimed).catch(() => null)
  return back === did ? { state: 'verified', handle: claimed } : { state: 'invalid', claimed }
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
    const agent = new AtpAgent({ service: handleResolverUrl(), fetch: safeFetch })
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
  if (!isAllowedDidWeb(did)) throw new DidNotFoundError(did)
  let data: Awaited<ReturnType<IdResolver['did']['resolveAtprotoData']>>
  try {
    data = await idResolver().did.resolveAtprotoData(did)
  } catch {
    throw new DidNotFoundError(did)
  }
  // SSRF guard: a DID document is attacker-controlled. Its PDS endpoint must be our own PDS or a
  // public https URL; anything else (loopback, private, metadata, http) makes the DID unusable.
  let pds: string
  try {
    const named = data.pds.replace(/\/+$/, '')
    pds = new URL(named).origin === new URL(defaultPdsUrl()).origin ? named : assertPublicServiceUrl(named)
  } catch {
    throw new DidNotFoundError(did)
  }
  return { did: data.did, pds, handle: data.handle || null, signingKey: data.signingKey }
}

/**
 * SSRF guard for did:web: the host must be a DNS name (never an IP literal) and, in production,
 * carry no port. The address it resolves to is checked again at connect time by `safeFetch`.
 */
function isAllowedDidWeb(did: string): boolean {
  if (!did.startsWith('did:web:')) return true
  try {
    const host = new URL(`https://${decodeURIComponent(did.slice('did:web:'.length))}`)
    if (/^\[.*\]$/.test(host.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(host.hostname)) return false
    if (host.port && isProduction()) return false
    return true
  } catch {
    return false
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
