/**
 * POST /api/v1/events/[slug]/admin/geocode  { query }  →  { result: { lat, lng, label } | null, cached }
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
import { chargeGeocodeQuota, geocode, GeocodeRateLimitError } from '@/lib/geo/geocode'
import { normalizeQuery } from '@/lib/geo/coarse'
import type { EventStatus } from '@/types/event'

export const dynamic = 'force-dynamic'

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
  const query = typeof body.query === 'string' ? normalizeQuery(body.query) : ''
  if (query.length < 3) return jsonError(400, 'Enter an address to look up', { field: 'query' })

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
    const { result, cached } = await geocode(query)
    return json({ result, cached })
  } catch (e) {
    console.error('[geocode] lookup failed:', e instanceof Error ? e.message : e)
    return jsonError(502, 'The address service is not answering right now. Place the pin by hand or try again later.')
  }
}
