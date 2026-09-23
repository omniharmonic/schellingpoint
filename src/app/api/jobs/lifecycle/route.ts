/**
 * The gathering clock, run by the scheduler every five minutes (plan §1, §7.2 "Jobs").
 *
 *   GET /api/jobs/lifecycle   Authorization: Bearer $CRON_SECRET
 *
 * Advances gatherings whose organizer asked for automatic phase changes, opens the
 * attendance round at the start, sends the 24 h / 1 h reminders and the 15-minute
 * "starting soon" notice for saved sessions, and raises the organizer alerts
 * (most-wanted sessions unscheduled, keep-apart pairs running together, a room at 80 %).
 *
 * 401 without the bearer; 503 outside development when CRON_SECRET is unset.
 * Responds with counts and gathering ids only — never a person.
 */
import { runLifecycleJob } from '@/lib/events/lifecycle-job'
import { authorizeCron } from '@/lib/notifications/cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeCron(request)
  if (denied) return denied
  try {
    const report = await runLifecycleJob()
    return Response.json({ ok: true, report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[jobs:lifecycle] run failed:', err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Lifecycle job failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
