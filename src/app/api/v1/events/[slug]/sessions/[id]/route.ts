import { isUuid, loadEventAccess, json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { getSession } from '@/app/api/v1/sessions/_lib/read'

/**
 * GET /api/v1/events/[slug]/sessions/[id]
 *
 * One session in the list shape plus detail: the host's in-gathering profile text for
 * members, and attendee-only fields (`telegram_group_url`, `custom_location`) for confirmed
 * RSVPs, the session's hosts and organizers only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!isUuid(id)) return jsonError(404, 'Session not found')

  const session = await getSession(access, id)
  if (!session) return jsonError(404, 'Session not found')
  return json({ session })
}
