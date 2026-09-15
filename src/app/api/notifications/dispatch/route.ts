/**
 * Notification outbox dispatch (scheduler, every 5 minutes — plan §1, §7.2 "Jobs").
 *
 *   GET|POST /api/notifications/dispatch   Authorization: Bearer $CRON_SECRET
 *
 * 401 without the bearer; 503 outside development when CRON_SECRET is unset.
 * Responds with counts only.
 */
import { dispatchPending } from '@/lib/notifications'
import { authorizeCron } from '@/lib/notifications/cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const denied = authorizeCron(request)
  if (denied) return denied
  try {
    const result = await dispatchPending({ limit: 50 })
    const status = result.error === 'mail_not_configured' ? 503 : 200
    return Response.json(result, { status, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[notifications:dispatch] run failed:', err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Dispatch failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export const GET = handle
export const POST = handle
