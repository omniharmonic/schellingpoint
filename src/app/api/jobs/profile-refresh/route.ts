/**
 * Hourly network-profile refresh (release design §5.2), run by the scheduler.
 *
 *   GET /api/jobs/profile-refresh   Authorization: Bearer $CRON_SECRET
 *
 * Re-imports the network profile (own PDS record first, AppView fallback) of every OAuth account
 * with a session created in the last 24 hours, at most once an hour per account, never
 * overwriting a field edited here. Custodial accounts are a no-op. 401 without the bearer; 503
 * outside development when CRON_SECRET is unset. Responds with counts only, never identifiers.
 */
import { authorizeCron } from '@/lib/notifications/cron'
import { refreshActiveNetworkProfiles } from '@/lib/atproto/profile-refresh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeCron(request)
  if (denied) return denied
  try {
    const report = await refreshActiveNetworkProfiles({ timeBudgetMs: 240_000 })
    return Response.json({ ok: true, report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[profile-refresh] run failed:', err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Profile refresh failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
