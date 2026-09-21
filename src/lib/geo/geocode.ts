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
import { isLatLng, normalizeQuery, type LatLng } from './coarse'

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

/** The cache key: sha256 of the normalized query (never the raw text). */
export function queryHash(query: string): string {
  return createHash('sha256').update(normalizeQuery(query)).digest('hex')
}

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

async function readCache(db: Sql, hash: string): Promise<{ hit: true; result: GeocodeResult | null } | { hit: false }> {
  const rows = await db<{ result: GeocodeResult | null }[]>`
    select result from geocode_cache
    where query_hash = ${hash} and fetched_at > now() - make_interval(days => ${GEOCODE_CACHE_DAYS})
  `
  return rows.length ? { hit: true, result: rows[0]!.result } : { hit: false }
}

async function writeCache(db: Sql, hash: string, result: GeocodeResult | null): Promise<void> {
  await db`
    insert into geocode_cache (query_hash, result, fetched_at)
    values (${hash}, ${result === null ? null : db.json(result as never)}, now())
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

async function lookup(query: string): Promise<GeocodeResult | null> {
  const url = new URL(geocoderUrl())
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  url.searchParams.set('q', normalizeQuery(query))
  await takeToken()
  const res = await safeFetch(url, { headers: { 'user-agent': GEOCODE_USER_AGENT, accept: 'application/json' } })
  if (!res.ok) throw new Error(`geocoder answered ${res.status}`)
  const body = (await res.json()) as unknown
  const first = Array.isArray(body) ? (body[0] as NominatimRow | undefined) : undefined
  if (!first) return null
  const lat = Number(first.lat)
  const lng = Number(first.lon)
  if (!isLatLng(lat, lng)) return null
  return { lat, lng, label: String(first.display_name ?? '').slice(0, 300) }
}

/**
 * Geocode `query`. Returns `{ result, cached }`; `result` is null when nothing matched (a
 * miss is cached too, so retyping the same bad address does not hit Nominatim again).
 */
export async function geocode(query: string, db: Sql = sql): Promise<{ result: GeocodeResult | null; cached: boolean }> {
  const q = normalizeQuery(query)
  if (q.length < 3) return { result: null, cached: false }
  const hash = queryHash(q)
  const cached = await readCache(db, hash)
  if (cached.hit) return { result: cached.result, cached: true }
  const result = await lookup(q)
  await writeCache(db, hash, result)
  return { result, cached: false }
}
