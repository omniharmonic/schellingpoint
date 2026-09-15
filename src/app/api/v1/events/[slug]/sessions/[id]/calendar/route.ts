import { generateSingleEventICS } from '@/lib/calendar/ics'
import { isUuid, jsonError, loadEventAccess } from '@/app/api/v1/sessions/_lib/access'
import { icsResponse, scheduledCalendarEvents } from '@/app/api/v1/sessions/_lib/calendar'

/** GET /api/v1/events/[slug]/sessions/[id]/calendar — one scheduled session as an ICS file. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!isUuid(id)) return jsonError(404, 'Session not found')

  const [event] = await scheduledCalendarEvents(access.event, [id])
  if (!event) return jsonError(404, 'Session is not scheduled')
  return icsResponse(generateSingleEventICS(event, access.event.name), `${event.title}.ics`)
}
