import 'server-only'
/**
 * Forward geocoding through Nominatim (spec §8.2, decision §12.1): key-less, reached only through
 * the SSRF-safe fetch with our identifying User-Agent (Nominatim's usage policy), paced to at
 * most one request per second per process, memoised for 30 days in `geocode_cache`.
 *
 * Only organizers and hosts of self-hosted sessions can reach this (the geocode route), and
 * each account is limited to `GEOCODE_PER_ACCOUNT_HOUR` calls an hour. Nothing here ever sees a
 * person's own position: browser geolocation stays in the browser.
 *
 * `GEOCODER_URL` overrides the Nominatim base (a local stub in tests); it must still pass the
 * outbound URL policy (https, or a configured local origin outside production).
 */
import { createHash } from 'node:crypto'
import { safeFetch } from '@/lib/net/safe-fetch'
import { sql, type Sql } from '@/lib/db'
import {
  addressIsPlaced,
  addressLine,
  geocodeParams,
  isLatLng,
  normalizeQuery,
  type LatLng,
  type StructuredAddress,
} from './coarse'

export const GEOCODE_CACHE_DAYS = 30
export const GEOCODE_PER_ACCOUNT_HOUR = 30
export const GEOCODE_USER_AGENT = 'unconference.events (hello@unconference.events)'
const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org/search'
const MIN_INTERVAL_MS = 1_000

export interface GeocodeResult extends LatLng {
  /** Nominatim's display name for the match. */
  label: string
}

export function geocoderUrl(): string {
  return (process.env.GEOCODER_URL?.trim() || DEFAULT_GEOCODER_URL).replace(/\/+$/, '')
}

/**
 * The cache key: sha256 of the normalized query (never the raw text).
 *
 * `namespace` keeps answers of different SHAPES apart. The single-result lookups that existed
 * before are unprefixed and stay exactly where they are; the editor's address search asks for up
 * to five candidates and keys them under its own namespace, so one does not overwrite the other.
 */
export function queryHash(query: string, namespace = ''): string {
  return createHash('sha256').update(`${namespace}${normalizeQuery(query)}`).digest('hex')
}

/** Cache namespace for a multi-candidate search of `limit` results. */
export const candidatesNamespace = (limit: number) => `candidates:${limit}|`

/* ───────────── 1 req/s process-wide token bucket ───────────── */

let nextSlotAt = 0

/** Resolves when this call may proceed; calls queue behind each other one second apart. */
async function takeToken(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, nextSlotAt)
  nextSlotAt = at + MIN_INTERVAL_MS
  if (at > now) await new Promise((r) => setTimeout(r, at - now))
}

/* ───────────── cache ───────────── */

async function readCache<T>(db: Sql, hash: string): Promise<{ hit: true; result: T | null } | { hit: false }> {
  const rows = await db<{ result: T | null }[]>`
    select result from geocode_cache
    where query_hash = ${hash} and fetched_at > now() - make_interval(days => ${GEOCODE_CACHE_DAYS})
  `
  return rows.length ? { hit: true, result: rows[0]!.result } : { hit: false }
}

async function writeCache(db: Sql, hash: string, result: unknown): Promise<void> {
  await db`
    insert into geocode_cache (query_hash, result, fetched_at)
    values (${hash}, ${result === null || result === undefined ? null : db.json(result as never)}, now())
    on conflict (query_hash) do update set result = excluded.result, fetched_at = excluded.fetched_at
  `
}

/* ───────────── per-account limit ───────────── */

export class GeocodeRateLimitError extends Error {
  readonly code = 'GeocodeRateLimited'
  readonly status = 429
  constructor(readonly retryAfterSeconds: number) {
    super('Too many address lookups. Try again in a little while.')
    this.name = 'GeocodeRateLimitError'
  }
}

/** Records one call for `accountId`; throws when the hourly budget is spent. */
export async function chargeGeocodeQuota(db: Sql, accountId: string): Promise<void> {
  await db`delete from geocode_requests where requested_at < now() - interval '1 hour'`
  const rows = await db<{ n: number; oldest: string | null }[]>`
    select count(*)::int as n, min(requested_at) as oldest from geocode_requests
    where account_id = ${accountId} and requested_at > now() - interval '1 hour'
  `
  const { n, oldest } = rows[0]!
  if (n >= GEOCODE_PER_ACCOUNT_HOUR) {
    const retry = oldest ? Math.max(1, Math.ceil((new Date(oldest).getTime() + 3_600_000 - Date.now()) / 1000)) : 3600
    throw new GeocodeRateLimitError(retry)
  }
  await db`insert into geocode_requests (account_id) values (${accountId})`
}

/* ───────────── lookup ───────────── */

interface NominatimRow {
  lat?: string
  lon?: string
  display_name?: string
}

/** One Nominatim request for up to `limit` matches. `input` is free text (`q=`) or an address. */
async function lookupMany(input: string | StructuredAddress, limit: number): Promise<GeocodeResult[]> {
  const url = new URL(geocoderUrl())
  const params = geocodeParams(input)
  for (const [key, value] of params) url.searchParams.set(key, value)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(limit))
  // With more than one candidate the label is what a person picks from, so ask for the parts
  // Nominatim uses to build a fuller display name.
  if (limit > 1) url.searchParams.set('addressdetails', '1')
  await takeToken()
  const res = await safeFetch(url, { headers: { 'user-agent': GEOCODE_USER_AGENT, accept: 'application/json' } })
  if (!res.ok) throw new Error(`geocoder answered ${res.status}`)
  const body = (await res.json()) as unknown
  const rows = Array.isArray(body) ? (body as NominatimRow[]) : []
  const out: GeocodeResult[] = []
  for (const row of rows.slice(0, limit)) {
    const lat = Number(row.lat)
    const lng = Number(row.lon)
    if (!isLatLng(lat, lng)) continue
    out.push({ lat, lng, label: String(row.display_name ?? '').slice(0, 300) })
  }
  return out
}

/** One Nominatim request. `input` is either free text (`q=`) or a structured address. */
async function lookup(input: string | StructuredAddress): Promise<GeocodeResult | null> {
  return (await lookupMany(input, 1))[0] ?? null
}

/**
 * Geocode an address. `input` may be free text (an address somebody typed) or a structured
 * address; a structured one is asked of Nominatim in its structured form, so the city, region
 * and postal code actually constrain the match instead of being ranking hints. A structured
 * lookup that matches nothing falls back to the same address as one line, which Nominatim is
 * more forgiving about.
 *
 * Returns `{ result, cached }`; `result` is null when nothing matched (a miss is cached too, so
 * retyping the same bad address does not hit Nominatim again). Both forms of the same address
 * share one cache key — the one-line form — so the cache cannot hold two answers for it.
 */
export async function geocode(
  input: string | StructuredAddress,
  db: Sql = sql,
): Promise<{ result: GeocodeResult | null; cached: boolean }> {
  const line = normalizeQuery(typeof input === 'string' ? input : addressLine(input))
  if (line.length < 3) return { result: null, cached: false }
  const hash = queryHash(line)
  const cached = await readCache<GeocodeResult>(db, hash)
  if (cached.hit) return { result: cached.result, cached: true }

  // A street line with no city, region or postal code is ambiguous in every country at once:
  // ask it as free text rather than as a structured address Nominatim would refuse to place.
  const structured = typeof input !== 'string' && addressIsPlaced(input)
  let result = await lookup(structured ? input : line)
  if (!result && structured) result = await lookup(line)

  await writeCache(db, hash, result)
  return { result, cached: false }
}

/** The most candidates the editor's address search may ask for. */
export const GEOCODE_MAX_CANDIDATES = 5

/**
 * Up to `limit` matches for an address somebody is searching for (design §1.3). Same pacing, same
 * 30-day cache, same SSRF-safe fetch as `geocode()` — but keyed under its own namespace, so the
 * single-result entries the rest of the app depends on are never overwritten by a list, nor a list
 * answered with one result.
 */
export async function geocodeCandidates(
  input: string | StructuredAddress,
  limit = GEOCODE_MAX_CANDIDATES,
  db: Sql = sql,
): Promise<{ results: GeocodeResult[]; cached: boolean }> {
  const count = Math.min(GEOCODE_MAX_CANDIDATES, Math.max(1, Math.trunc(limit)))
  const line = normalizeQuery(typeof input === 'string' ? input : addressLine(input))
  if (line.length < 3) return { results: [], cached: false }
  const hash = queryHash(line, candidatesNamespace(count))
  const cached = await readCache<GeocodeResult[]>(db, hash)
  if (cached.hit) return { results: Array.isArray(cached.result) ? cached.result : [], cached: true }

  const structured = typeof input !== 'string' && addressIsPlaced(input)
  let results = await lookupMany(structured ? input : line, count)
  if (!results.length && structured) results = await lookupMany(line, count)

  await writeCache(db, hash, results)
  return { results, cached: false }
}
