import { assertSameOrigin } from '@/lib/auth/viewer'
import { tx, sql } from '@/lib/db'
import {
  canSeeSession,
  ensurePublicMembership,
  isUuid,
  json,
  jsonError,
  loadEventAccess,
  sessionRelation,
  type EventAccess,
} from '@/app/api/v1/sessions/_lib/access'

/**
 * PUT    /api/v1/events/[slug]/favorites/[sessionId] — save to my schedule
 * DELETE /api/v1/events/[slug]/favorites/[sessionId] — remove it
 *
 * A favorite is a private interest list (spec §9): never published, never shown to anyone
 * but its owner. Runs on the service connection with the checks the baseline RLS made
 * (own row, member of the event, session visible to the viewer).
 */
type Params = { params: Promise<{ slug: string; sessionId: string }> }

async function prepare(request: Request, params: Params['params'], removing = false): Promise<{ access: EventAccess & { viewer: NonNullable<EventAccess['viewer']> }; sessionId: string } | Response> {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug, sessionId } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!access.viewer) return jsonError(401, 'Unauthorized')
  if (!isUuid(sessionId)) return jsonError(404, 'Session not found')
  const rel = await sessionRelation(sql, sessionId, access.event.id, access.viewer.accountId)
  // Removing your own row stays possible after a session leaves public view (e.g. it was declined).
  if (!rel || (!removing && !canSeeSession(rel, access))) return jsonError(404, 'Session not found')
  return { access: access as EventAccess & { viewer: NonNullable<EventAccess['viewer']> }, sessionId }
}

export async function PUT(request: Request, { params }: Params) {
  const ready = await prepare(request, params)
  if (ready instanceof Response) return ready
  const { access, sessionId } = ready

  const ok = await tx(async (t) => {
    const role = await ensurePublicMembership(t, access)
    if (!role) return false
    await t`
      insert into favorites (user_id, session_id, event_id)
      values (${access.viewer.accountId}, ${sessionId}, ${access.event.id})
      on conflict (user_id, session_id) do nothing
    `
    return true
  })
  if (!ok) return jsonError(403, 'Join this event to save sessions', { code: 'not_member' })
  return json({ is_favorite: true })
}

export async function DELETE(request: Request, { params }: Params) {
  const ready = await prepare(request, params, true)
  if (ready instanceof Response) return ready
  const { access, sessionId } = ready

  await sql`
    delete from favorites
    where user_id = ${access.viewer.accountId} and session_id = ${sessionId} and event_id = ${access.event.id}
  `
  return json({ is_favorite: false })
}
