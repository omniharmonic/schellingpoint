/**
 * POST /api/v1/events/[slug]/admin/geocode
 *   { query }                                              free text somebody typed
 *   { address: { street, locality, region, postal_code, country } }   a room's address in parts
 *   { query, limit: 2..5 }                                 the editor's address search
 *   →  { result: { lat, lng, label } | null, cached }
 *      { result, results: [{ lat, lng, label }], cached }  when `limit` is more than 1
 *
 * The parts form is what the map editor sends for a room, and it matters: a street line on its own
 * matches whichever same-named street the geocoder ranks first anywhere in the world, so the city,
 * region and postal code travel with it as real constraints (spec §8.2).
 *
 * Forward geocoding for the map (spec §8.2). Who may call it:
 *   - organizers (owner / admin / moderator), placing rooms and the map area;
 *   - hosts and co-hosts of a self-hosted session in this event, placing their session;
 *   - a member while proposals are open (they are placing the session they are about to propose).
 * Anyone else gets 403; a private or draft gathering answers 404 to non-members. Each account
 * may make 30 lookups an hour (429 with Retry-After); the process makes at most one Nominatim
 * request a second and caches answers for 30 days.
 *
 * The query is the address the caller typed. Nothing about the caller's own position is ever
 * involved: browser geolocation stays in the browser.
 */
import { sql } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { canSubmitProposals } from '@/lib/events/lifecycle'
import { json, jsonError, loadEventAccess, readJsonObject } from '@/app/api/v1/sessions/_lib/access'
import { chargeGeocodeQuota, geocode, geocodeCandidates, GEOCODE_MAX_CANDIDATES, GeocodeRateLimitError } from '@/lib/geo/geocode'
import { addressLine, hasAddress, normalizeQuery, type StructuredAddress } from '@/lib/geo/coarse'
import type { EventStatus } from '@/types/event'

export const dynamic = 'force-dynamic'

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null)

/**
 * What to look up: the `address` parts when they are given, otherwise the free-text `query`.
 * Null when neither says enough to be worth a Nominatim request.
 */
function addressToLookUp(body: Record<string, unknown>): string | StructuredAddress | null {
  const raw = body.address
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const parts = raw as Record<string, unknown>
    const address: StructuredAddress = {
      street: text(parts.street),
      locality: text(parts.locality),
      region: text(parts.region),
      postalCode: text(parts.postal_code) ?? text(parts.postalCode),
      country: text(parts.country),
    }
    if (hasAddress(address) && normalizeQuery(addressLine(address)).length >= 3) return address
    return null
  }
  const query = typeof body.query === 'string' ? normalizeQuery(body.query) : ''
  return query.length >= 3 ? query : null
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  if (!access.isOrganizer) {
    if (!access.role) return jsonError(403, 'Join this gathering before looking up addresses')
    const [hosting] = await sql<{ ok: boolean }[]>`
      select exists (
        select 1 from sessions s
        where s.event_id = ${access.event.id} and s.is_self_hosted
          and (s.host_id = ${viewer.accountId}
               or exists (select 1 from session_cohosts c where c.session_id = s.id and c.user_id = ${viewer.accountId}))
      ) as ok
    `
    const windows = await sql<{ proposals_open_at: string | null; proposals_close_at: string | null }[]>`
      select proposals_open_at, proposals_close_at from events where id = ${access.event.id}
    `
    const now = Date.now()
    const w = windows[0]
    const proposing = canSubmitProposals(access.event.status as EventStatus)
      && (!w?.proposals_open_at || now >= Date.parse(w.proposals_open_at))
      && (!w?.proposals_close_at || now < Date.parse(w.proposals_close_at))
    if (!hosting?.ok && !proposing) return jsonError(403, 'Only organizers and hosts of self-hosted sessions can look up addresses here')
  }

  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  const lookup = addressToLookUp(body)
  if (!lookup) return jsonError(400, 'Enter an address to look up', { field: 'query' })
  // Design §1.3: the editor's address search offers a handful of candidates to pick from. One
  // lookup either way, so the same 30/h budget covers it; the answers live in their own cache
  // namespace so a list never overwrites the single result the rest of the app reads.
  const rawLimit = body.limit
  const limit = rawLimit === undefined || rawLimit === null ? 1 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > GEOCODE_MAX_CANDIDATES) {
    return jsonError(400, `limit must be a whole number between 1 and ${GEOCODE_MAX_CANDIDATES}`, { field: 'limit' })
  }

  try {
    await chargeGeocodeQuota(sql, viewer.accountId)
  } catch (e) {
    if (e instanceof GeocodeRateLimitError) {
      return new Response(JSON.stringify({ error: e.message, code: e.code, retry_after: e.retryAfterSeconds }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(e.retryAfterSeconds), 'cache-control': 'private, no-store' },
      })
    }
    throw e
  }

  try {
    if (limit > 1) {
      const { results, cached } = await geocodeCandidates(lookup, limit)
      return json({ result: results[0] ?? null, results, cached })
    }
    const { result, cached } = await geocode(lookup)
    return json({ result, cached })
  } catch (e) {
    console.error('[geocode] lookup failed:', e instanceof Error ? e.message : e)
    return jsonError(502, 'The address service is not answering right now. Place the pin by hand or try again later.')
  }
}
