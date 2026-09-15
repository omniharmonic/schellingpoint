import { sql } from '@/lib/db'
import { generateICS } from '@/lib/calendar/ics'
import { jsonError, loadEventAccess } from '@/app/api/v1/sessions/_lib/access'
import { icsResponse, scheduledCalendarEvents } from '@/app/api/v1/sessions/_lib/calendar'

/**
 * GET /api/v1/events/[slug]/calendar[?favorites=true]
 *
 * The event's scheduled sessions as an ICS file; with `favorites=true`, only the signed-in
 * viewer's saved sessions (their personal schedule).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const favoritesOnly = new URL(request.url).searchParams.get('favorites') === 'true'
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
  return icsResponse(generateICS({ name, events }), `${access.event.name}-${favoritesOnly ? 'my-schedule' : 'schedule'}.ics`)
}
