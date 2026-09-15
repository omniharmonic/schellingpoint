import 'server-only'
/**
 * Gathering subdomains (spec §8 "Routing", plan §6 item 6): `<slug>.<PDS_HANDLE_DOMAIN>`
 * serves the gathering at `/e/<slug>`. The PDS answers only `/.well-known/atproto-did` and
 * `/xrpc/*` on those hosts (deploy Caddyfile); every other path reaches the app.
 *
 * Resolution is by table, never by pattern: a label is a gathering only when an event with
 * that slug exists. Answers are cached briefly in-process so a burst of asset requests does
 * not become a burst of queries.
 */
import { sql } from '@/lib/db'
import { handleDomain, labelUnder } from '@/lib/auth/handles'

/** Labels under the handle domain that are infrastructure, never a gathering. */
const INFRASTRUCTURE_LABELS: ReadonlySet<string> = new Set(['www', 'pds'])

const TTL_MS = 30_000
const MAX_ENTRIES = 1_000

type CacheEntry = { slug: string | null; at: number }
const g = globalThis as typeof globalThis & { __unconferenceHostCache?: Map<string, CacheEntry> }
const cache: Map<string, CacheEntry> = (g.__unconferenceHostCache ??= new Map())

export type HostResolution =
  | { kind: 'apex' }
  | { kind: 'infrastructure'; label: string }
  | { kind: 'gathering'; slug: string }
  | { kind: 'unknown'; label: string }

/** What a request's `Host` names. `apex` for anything not directly under the handle domain. */
export async function resolveGatheringHost(host: string | null): Promise<HostResolution> {
  if (!host) return { kind: 'apex' }
  let domain: string
  try {
    domain = handleDomain()
  } catch {
    return { kind: 'apex' }
  }
  const label = labelUnder(host, domain)
  if (!label) return { kind: 'apex' }
  if (INFRASTRUCTURE_LABELS.has(label)) return { kind: 'infrastructure', label }

  const now = Date.now()
  const hit = cache.get(label)
  if (hit && now - hit.at < TTL_MS) {
    return hit.slug ? { kind: 'gathering', slug: hit.slug } : { kind: 'unknown', label }
  }
  const rows = await sql<{ slug: string }[]>`select slug from events where slug = ${label} limit 1`
  const slug = rows[0]?.slug ?? null
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
  cache.set(label, { slug, at: now })
  return slug ? { kind: 'gathering', slug } : { kind: 'unknown', label }
}

/** Forget a label (after creating or deleting a gathering) so the next request re-reads it. */
export function forgetGatheringHost(slug: string): void {
  cache.delete(slug.trim().toLowerCase())
}
