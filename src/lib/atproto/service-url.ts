import 'server-only'
/**
 * Where the app may send a request for a DID's repo, and with which fetch (SSRF guard).
 *
 *   our PDS hosts the DID, or its DID document names our `PDS_URL`
 *        → `PDS_INTERNAL_URL`, plain fetch (operator configuration, never attacker input)
 *   anything else
 *        → the endpoint its DID document names, validated by the public-address rule and only
 *          ever dialled through `safeFetch` (connect-time address check, capped redirects)
 *
 * Kept apart from `identity.ts` / `write.ts` so the protocol code there stays focused.
 */
import { AtpAgent } from '@atproto/api'
import { assertPublicServiceUrl, safeFetch } from '@/lib/net/safe-fetch'
import { defaultPdsUrl, pdsInternalUrl } from './config'
import { describeOwnRepo, resolveDidDoc } from './identity'

export interface RepoService {
  url: string
  /** True only for our own PDS reached through `PDS_INTERNAL_URL`. */
  internal: boolean
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** Resolve the service for `did` (see module doc). Throws `DidNotFoundError` / `UnsafeUrlError`. */
export async function serviceForDid(did: string): Promise<RepoService> {
  const own = await describeOwnRepo(did).catch(() => null)
  if (own) return { url: pdsInternalUrl(), internal: true }
  const doc = await resolveDidDoc(did)
  if (sameOrigin(doc.pds, defaultPdsUrl())) return { url: pdsInternalUrl(), internal: true }
  return { url: assertPublicServiceUrl(doc.pds), internal: false }
}

/** The URL half of `serviceForDid`. */
export async function serviceUrlForDid(did: string): Promise<string> {
  return (await serviceForDid(did)).url
}

/** The fetch a request to `service` must use. */
export function fetchForService(service: RepoService): typeof globalThis.fetch {
  return service.internal ? globalThis.fetch : safeFetch
}

/** An unauthenticated `AtpAgent` against `service`, with the right fetch. */
export function atpAgentForService(service: RepoService): AtpAgent {
  return new AtpAgent({ service: service.url, ...(service.internal ? {} : { fetch: safeFetch }) })
}
