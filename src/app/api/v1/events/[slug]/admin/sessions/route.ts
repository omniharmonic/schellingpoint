/**
 * Organizer session list and curated-session creation.
 *   GET  /api/v1/events/[slug]/admin/sessions   every session of the event, all statuses
 *   POST /api/v1/events/[slug]/admin/sessions   create a host-less curated session
 *
 * GET never includes vote numbers while a round is open. After the round closes it adds
 * `results` (package C's `organizerResults`) so organizers — and only organizers — can sort
 * by votes (spec §3, §5.3).
 */
import { asAccount, sql } from '@/lib/db'
import { organizerResults, roundState } from '@/lib/voting'
import { errorResponse, json, readBody, requireOrganizer, rolesWith, rolesWithAny } from '@/lib/scheduling/admin-api'
import { listAdminSessions } from '@/lib/scheduling/program'
import { insertCuratedSession, parseCuratedSession } from '@/lib/scheduling/sessions'

export const dynamic = 'force-dynamic'

const READ_ROLES = rolesWithAny('approveProposals', 'manageSchedule')
const WRITE_ROLES = rolesWith('manageSchedule')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, READ_ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const [sessions, round] = await Promise.all([listAdminSessions(ctx.event.id, sql), roundState(ctx.event.id)])
    let results: Record<string, { voters: number; votes: number; credits: number }> | null = null
    // Results of the latest finalized round; never while a round is open (organizerResults would refuse).
    if (round.status !== 'open') {
      results = {}
      for (const r of await organizerResults(ctx.event.id)) {
        results[r.sessionId] = { voters: r.voters, votes: r.votes, credits: r.credits }
      }
    }
    return json({
      sessions,
      voting: { status: round.status, closesAt: round.round?.closesAt ?? null },
      results,
    })
  } catch (e) {
    return errorResponse(e, 'list admin sessions')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const input = parseCuratedSession(body)
    const id = await asAccount(ctx.viewer.accountId, (tx) =>
      insertCuratedSession(tx, ctx.event.id, ctx.viewer.accountId, input),
    )
    return json({ id, status: input.status }, { status: 201 })
  } catch (e) {
    return errorResponse(e, 'create curated session')
  }
}
