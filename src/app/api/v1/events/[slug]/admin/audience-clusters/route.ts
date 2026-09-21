/**
 * Audience clusters (release design §9.3; PRD §4.7 step 3).
 *   GET /api/v1/events/[slug]/admin/audience-clusters
 *
 * "Keep apart" pairs (≥60% shared voters), "fine together" sets (<20%), and how many pairs
 * were suppressed for having fewer than k voters on a side. Percentages and counts only:
 * ballot tokens never leave `schedulingInputs`, and a shared-voter count is shown only when it
 * is itself at least k. Answers 409 `RoundOpen` while the round is open.
 */
import { audienceClusters } from '@/lib/scheduling/clusters'
import { loadSchedulingContext, RoundOpenError, roundOpenResponse } from '@/lib/scheduling/context'
import { errorResponse, json, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx

  try {
    let inputs: Awaited<ReturnType<typeof loadSchedulingContext>>
    try {
      inputs = await loadSchedulingContext(ctx.event.id)
    } catch (e) {
      if (e instanceof RoundOpenError) return roundOpenResponse()
      throw e
    }
    const clusters = audienceClusters(inputs.ballots, inputs.k)
    const titles = new Map(inputs.sessions.map((s) => [s.id, s.title]))
    const session = (id: string) => ({ id, title: titles.get(id) ?? 'Untitled session' })
    const k = clusters.k
    return json({
      roundId: inputs.roundId,
      k,
      thresholds: { keepApartPercent: 60, fineTogetherPercent: 20 },
      keepApart: clusters.keepApart.map((p) => ({
        a: session(p.a),
        b: session(p.b),
        overlapPercent: Math.round(p.coefficient * 100),
        sharedVoters: p.shared >= k ? p.shared : null,
      })),
      fineTogether: clusters.fineTogether.map((g) => ({
        sessions: g.sessionIds.map(session),
        maxOverlapPercent: Math.round(g.maxCoefficient * 100),
      })),
      comparableSessions: clusters.comparableSessions,
      suppressed: { pairs: clusters.suppressedCount, sessions: clusters.suppressedSessions },
    })
  } catch (e) {
    return errorResponse(e, 'audience clusters')
  }
}
