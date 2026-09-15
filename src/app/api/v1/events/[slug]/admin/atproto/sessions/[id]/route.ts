/**
 * POST /api/v1/events/[slug]/admin/atproto/sessions/[id]   body { action, reason?, target?, confirmPublicLinkage? }
 *
 *   republish                      rewrite this session's calendar event, config and slot in place
 *                                  (adopts a drifted proposal; refuses a changed slot)
 *   move { target?, reason }       destructive when published → approvals (see /approvals)
 *   cancel { reason }              destructive when published → approvals
 *
 * Owner/admin. Move and cancel return `{ status: 'applied' | 'awaiting_approval', approvalsNeeded }`.
 */
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { requestSessionCancel, requestSessionMove } from '@/lib/atproto/approvals'
import { atprotoErrorResponse } from '@/lib/atproto/http'
import { republishSession } from '@/lib/atproto/publish'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const denied = assertSameOrigin(request)
  if (denied) return denied
  const { slug, id } = await params
  const auth = await requireEventRole(request, slug, ['owner', 'admin'])
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const action = body?.action
  const [session] = await sql`select id from sessions where id = ${/^[0-9a-f-]{36}$/i.test(id) ? id : '00000000-0000-0000-0000-000000000000'} and event_id = ${auth.event.id}`
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 })
  const base = { eventId: auth.event.id, sessionId: id, callerUserId: auth.viewer.accountId }
  const reason = typeof body?.reason === 'string' ? body.reason : ''
  const confirmPublicLinkage = body?.confirmPublicLinkage === true
  try {
    if (action === 'republish') {
      if (!auth.event.actor_did) return Response.json({ error: 'Create the gathering’s network identity first.', code: 'GatheringNotLinked' }, { status: 409 })
      const { results } = await republishSession(base)
      return Response.json({ action, results })
    }
    if (action === 'move') {
      const t = body?.target as { timeSlotId?: unknown; venueId?: unknown } | undefined
      const target = t && typeof t.timeSlotId === 'string' ? { timeSlotId: t.timeSlotId, venueId: typeof t.venueId === 'string' ? t.venueId : null } : undefined
      return Response.json({ action, ...(await requestSessionMove({ ...base, reason, target, confirmPublicLinkage })) })
    }
    if (action === 'cancel') {
      return Response.json({ action, ...(await requestSessionCancel({ ...base, reason, confirmPublicLinkage })) })
    }
    return Response.json({ error: 'action must be one of republish, move, cancel', field: 'action' }, { status: 400 })
  } catch (e) {
    return atprotoErrorResponse(e, 'admin/atproto/sessions')
  }
}
