import { sql, tx } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { notify } from '@/lib/notifications'
import {
  canSeeSession,
  json,
  jsonError,
  loadSessionEventAccess,
  readJsonObject,
  sessionRelation,
} from '../../_lib/access'

const MAX_MESSAGE = 1000

/**
 * POST /api/v1/sessions/[id]/request-update  { message }
 *
 * An organizer who thinks a proposal's content needs a change asks its author to make it,
 * instead of editing a record that lives in the author's repository (spec §4.2). Sends the
 * author a `proposal_needs_review` notification; nothing about the session changes.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { id } = await params

  const access = await loadSessionEventAccess(request, id)
  if (access instanceof Response) return access
  const rel = await sessionRelation(sql, id, access.event.id, viewer.accountId)
  if (!rel || !canSeeSession(rel, access)) return jsonError(404, 'Session not found')
  if (!access.isOrganizer) return jsonError(403, 'Only organizers can ask a proposer to update their proposal')
  if (!rel.host_id) return jsonError(409, 'This session has no proposer to ask; organizers edit it directly', { code: 'hostless' })
  if (rel.isHost) return jsonError(400, 'This is your own proposal; edit it directly')

  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return jsonError(400, 'Say what you would like the proposer to change', { field: 'message' })
  if ([...message].length > MAX_MESSAGE) {
    return jsonError(400, `Keep the request to ${MAX_MESSAGE} characters or fewer`, { field: 'message' })
  }

  const sent = await tx((t) =>
    notify(t, {
      eventId: access.event.id,
      userIds: [rel.host_id],
      type: 'proposal_needs_review',
      title: `An organizer asked you to update “${rel.title}”`,
      body: message,
      actionUrl: `/e/${access.event.slug}/sessions/${id}`,
      data: { session_id: id, session_title: rel.title },
    }),
  )
  return json({ sent: sent > 0 })
}
