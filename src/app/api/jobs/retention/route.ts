/**
 * Retention sweep (spec §9), run by the scheduler.
 *
 *   GET /api/jobs/retention   Authorization: Bearer $CRON_SECRET
 *
 * 401 without the bearer; 503 outside development when CRON_SECRET is unset.
 * Responds with a count per rule, never identifiers.
 */
import { authorizeCron } from '@/lib/notifications/cron'
import { runRetention } from '@/lib/notifications/retention'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeCron(request)
  if (denied) return denied
  try {
    const report = await runRetention()
    return Response.json({ ok: true, report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[retention] run failed:', err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Retention failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
