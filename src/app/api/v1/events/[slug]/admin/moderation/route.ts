/**
 * The organizer moderation queue (spec §9 `sp_moderation_queue`).
 *
 *   GET    ?status=open|resolved|all   → { reports, open }
 *   PATCH  { reportId, action, note }  → resolve one case
 *   POST   { sessionId, unhide: true } → put a hidden session back in the listings
 *
 * Owners, admins and moderators. Everything is scoped to the resolved `event.id`: a case file
 * belongs to one gathering and another gathering's organizers are the public (spec §8).
 * Nothing here writes to the network — hiding a session sets a flag on our row and leaves the
 * author's record in their own repo exactly where it is.
 */
import { NextResponse } from 'next/server'
import { requireOrganizer, fail, json, readBody, isUuid } from '@/lib/scheduling/admin-api'
import {
  countOpenReports,
  isModerationAction,
  listReports,
  resolveReport,
  ReportError,
  unhideSession,
} from '@/lib/moderation'

export const dynamic = 'force-dynamic'

const ROLES = ['owner', 'admin', 'moderator'] as const

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const wanted = new URL(request.url).searchParams.get('status')
  const status = wanted === 'resolved' || wanted === 'all' ? wanted : 'open'
  const [reports, open] = await Promise.all([listReports(ctx.event.id, { status }), countOpenReports(ctx.event.id)])
  return json({ reports, open })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  if (!isUuid(body.reportId)) return fail(400, 'Which report?', { field: 'reportId' })
  if (!isModerationAction(body.action)) return fail(400, 'Choose what to do with this report.', { field: 'action' })
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return fail(400, 'A note must be text.', { field: 'note' })
  }

  try {
    const outcome = await resolveReport({
      eventId: ctx.event.id,
      eventSlug: ctx.event.slug,
      reportId: body.reportId,
      resolverAccountId: ctx.viewer.accountId,
      // The queue must not be a way around the roster's own rules: a moderator acts on
      // members, an owner acts on organizers (mirrors members/[userId]).
      resolverRole: ctx.role,
      action: body.action,
      note: typeof body.note === 'string' ? body.note : null,
    })
    if (outcome.blocked === 'not-a-member') {
      return NextResponse.json(
        { ...outcome, error: 'That person is no longer a member of this gathering.' },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    if (outcome.blocked === 'last-owner') {
      return NextResponse.json(
        {
          ...outcome,
          error: 'That person is the only owner of this gathering; make someone else an owner before removing them.',
        },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return json(outcome)
  } catch (e) {
    if (e instanceof ReportError) return fail(e.status, e.message, { code: e.code })
    console.error('[moderation] resolve failed:', e instanceof Error ? e.name : 'error')
    return fail(500, 'That report could not be updated. Try again.')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body
  if (!isUuid(body.sessionId)) return fail(400, 'Which session?', { field: 'sessionId' })
  if (body.unhide !== true) return fail(400, 'Only un-hiding is done here; hide a session by resolving its report.')
  const done = await unhideSession(ctx.event.id, body.sessionId)
  return json({ sessionId: body.sessionId, hidden: false, changed: done })
}
