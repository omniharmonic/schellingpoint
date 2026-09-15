/**
 * GET /api/jobs/close-rounds — the scheduler's one-minute sweep (plan §1, §7.2 Jobs).
 *
 *  1. close every vote round past `closes_at` or whose event left the voting phase
 *     (`closeDueRounds`): ballots and randomized entries written, ledger deleted,
 *     ballot key destroyed — then each tally published as the gathering after commit
 *  2. open feedback windows for sessions whose slot has started, and close windows whose
 *     time is up (`closeDueFeedbackWindows`)
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`, 401 otherwise (allowed in development
 * without CRON_SECRET).
 */
import { closeDueFeedbackWindows, closeDueRounds } from '@/lib/voting'
import { json, jsonError, verifyCron } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const denied = verifyCron(request, '/api/jobs/close-rounds')
  if (denied) return denied
  try {
    const rounds = await closeDueRounds()
    const feedback = await closeDueFeedbackWindows()
    return json({
      rounds: {
        closed: rounds.closed.map((r) => ({
          roundId: r.roundId,
          eventId: r.eventId,
          phase: r.phase,
          ballotsCast: r.ballotsCast,
          published: r.published ?? null,
        })),
        failed: rounds.failed,
      },
      feedback,
    })
  } catch (e) {
    console.error('[jobs:close-rounds] failed', e)
    return jsonError(500, e instanceof Error ? e.message : 'close-rounds failed')
  }
}
