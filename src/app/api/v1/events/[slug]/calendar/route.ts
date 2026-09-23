import { sql } from '@/lib/db'
import { generateICS } from '@/lib/calendar/ics'
import { publicUrl } from '@/lib/atproto/config'
import { jsonError, loadEventAccess } from '@/app/api/v1/sessions/_lib/access'
import { icsResponse, scheduledCalendarEvents } from '@/app/api/v1/sessions/_lib/calendar'
import { FEED_REFRESH_INTERVAL } from '@/lib/calendar/feed'

/**
 * GET /api/v1/events/[slug]/calendar[?favorites=true][?subscribe=true]
 *
 * The event's scheduled sessions as an ICS file; with `favorites=true`, only the signed-in
 * viewer's saved sessions (their personal schedule).
 *
 * `subscribe=true` is the same published schedule served for a calendar *subscription*
 * (MT §12.8): served inline rather than as a download, and carrying REFRESH-INTERVAL so a
 * client comes back for schedule changes instead of holding the first copy forever. It is the
 * gathering's public schedule — the same rows anyone can already read — so it needs no
 * credential, and it refuses `favorites`, which are nobody's business but the person's (those
 * live behind a per-member token at `/api/calendar/<token>`).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const search = new URL(request.url).searchParams
  const favoritesOnly = search.get('favorites') === 'true'
  const subscribe = search.get('subscribe') === 'true'
  if (subscribe && favoritesOnly) {
    return jsonError(400, 'A subscription URL carries the public schedule. Subscribe to your own saved sessions from Account → Notifications.')
  }

  let sessionIds: string[] | undefined
  if (favoritesOnly) {
    if (!access.viewer) return jsonError(401, 'Sign in to export your schedule')
    const rows = await sql<{ session_id: string }[]>`
      select session_id from favorites where user_id = ${access.viewer.accountId} and event_id = ${access.event.id}
    `
    sessionIds = rows.map((r) => r.session_id)
  }

  const events = await scheduledCalendarEvents(access.event, sessionIds)
  const name = favoritesOnly ? `${access.event.name} - My Schedule` : access.event.name
  if (!subscribe) {
    return icsResponse(generateICS({ name, events }), `${access.event.name}-${favoritesOnly ? 'my-schedule' : 'schedule'}.ics`)
  }

  let origin = 'http://localhost:3001'
  try {
    origin = publicUrl().replace(/\/+$/, '')
  } catch {
    // keep the fallback origin
  }
  const ics = generateICS({
    name,
    description: `The published schedule for ${access.event.name}. Updates on its own.`,
    refreshInterval: FEED_REFRESH_INTERVAL,
    source: `${origin}/api/v1/events/${encodeURIComponent(access.event.slug)}/calendar?subscribe=true`,
    events,
  })
  return icsResponse(ics, `${access.event.name}-schedule.ics`, { disposition: 'inline' })
}
