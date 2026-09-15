import { loadEventAccess, json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { listSessions, parseListFilters } from '@/app/api/v1/sessions/_lib/read'

/**
 * GET /api/v1/events/[slug]/sessions
 *
 * The app's session list. Query: status (comma list or `all`; default approved,scheduled —
 * other statuses only for the viewer's own sessions or organizers), track (id), format,
 * day (YYYY-MM-DD in the event timezone), mine=1, favorites=1, timed=1, q, and
 * sort = newest | title | track | time. Never carries vote counts (spec §5.3).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const filters = parseListFilters(new URL(request.url))
  if ('error' in filters) return jsonError(400, filters.error)
  if ((filters.mine || filters.favorites) && !access.viewer) return jsonError(401, 'Unauthorized')

  const sessions = await listSessions(access, filters)
  return json({ sessions })
}
