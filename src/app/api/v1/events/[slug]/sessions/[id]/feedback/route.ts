/**
 * /api/v1/events/[slug]/sessions/[id]/feedback — post-session feedback on ballot machinery.
 *
 * GET    → { window: { status, opensAt, closesAt }, summary, own, can_submit, reason,
 *            can_manage, is_host }
 *          `summary` has numbers only after the window closes and only with ≥ k responses;
 *          `summary.comments` only for the session's hosts/co-hosts and event organizers,
 *          on the same conditions. Nobody — organizers included — sees who wrote what.
 *          `own` is the caller's feedback while the window is open (after close it can
 *          no longer be found, by anyone).
 * POST   { rating: 1-5, would_attend_again?: boolean|null, comment?: string|null }
 *          → { own } — leave or change feedback while the window is open
 * DELETE → { removed } — withdraw feedback while the window is open
 */
import { assertSameOrigin } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import {
  feedbackSummary,
  getOwnFeedback,
  openFeedbackWindow,
  parseFeedbackInput,
  retractFeedback,
  submitFeedback,
} from '@/lib/voting'
import { errorResponse, json, jsonError, ORGANIZER_ROLES, readJson, resolveEvent, type ResolvedEvent } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string; id: string }> }

interface SessionContext extends ResolvedEvent {
  session: { id: string; status: string; host_id: string | null }
  isOrganizer: boolean
  isHost: boolean
  canManage: boolean
}

async function loadContext(request: Request, slug: string, sessionId: string): Promise<SessionContext | Response> {
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return jsonError(404, 'Session not found')

  const accountId = resolved.viewer?.accountId ?? null
  const [session] = await sql<{ id: string; status: string; host_id: string | null; is_cohost: boolean }[]>`
    select s.id, s.status, s.host_id,
           (${accountId}::uuid is not null and exists (
             select 1 from session_cohosts c where c.session_id = s.id and c.user_id = ${accountId}::uuid
           )) as is_cohost
    from sessions s
    where s.id = ${sessionId} and s.event_id = ${resolved.event.id}
  `
  if (!session) return jsonError(404, 'Session not found')

  const isOrganizer = !!resolved.role && ORGANIZER_ROLES.includes(resolved.role)
  const isHost = !!accountId && (session.host_id === accountId || session.is_cohost)
  const canManage = isOrganizer || isHost
  if (!['approved', 'scheduled'].includes(session.status) && !canManage) return jsonError(404, 'Session not found')

  return { ...resolved, session: { id: session.id, status: session.status, host_id: session.host_id }, isOrganizer, isHost, canManage }
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  try {
    await openFeedbackWindow(ctx.session.id)
    const summary = await feedbackSummary(ctx.session.id, undefined, { includeComments: ctx.canManage })
    const own = ctx.viewer && summary.status === 'open' ? await getOwnFeedback(ctx.viewer.accountId, ctx.session.id) : null

    let reason: string | null = null
    if (summary.status === 'none') reason = 'Feedback opens once the session has started.'
    else if (summary.status === 'closed') reason = 'Feedback for this session has closed.'
    else if (!ctx.viewer) reason = 'Sign in to leave feedback.'
    else if (!ctx.role) reason = 'Join the gathering to leave feedback.'
    else if (ctx.isHost) reason = 'Hosts cannot leave feedback on their own session.'

    const { opensAt, closesAt, status, ...rest } = summary
    return json({
      window: { status, opensAt, closesAt },
      summary: rest,
      own,
      can_submit: reason === null,
      reason,
      can_manage: ctx.canManage,
      is_host: ctx.isHost,
    })
  } catch (e) {
    return errorResponse(e, 'feedback GET')
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.viewer) return jsonError(401, 'Unauthorized')
  const body = await readJson(request)
  if (body instanceof Response) return body
  try {
    const input = parseFeedbackInput(body)
    const own = await submitFeedback(ctx.viewer.accountId, ctx.session.id, input)
    return json({ own })
  } catch (e) {
    return errorResponse(e, 'feedback POST')
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.viewer) return jsonError(401, 'Unauthorized')
  try {
    return json(await retractFeedback(ctx.viewer.accountId, ctx.session.id))
  } catch (e) {
    return errorResponse(e, 'feedback DELETE')
  }
}
