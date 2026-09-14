/**
 * GET /api/atproto/sync — reconciliation (Vercel cron, hourly; see vercel.json).
 *
 * `listRecords` every gathering actor and every linked profile, upsert what
 * they hold, delete what they no longer hold. This is the at-least-once safety
 * net behind the Jetstream consumer and the only index path when that
 * consumer is not deployed (docs/ATPROTO_IMPLEMENTATION.md §4).
 *
 * Auth mirrors /api/notifications/dispatch: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; a wrong bearer is 401, an unset secret
 * is 503 outside development.
 */
import { NextRequest, NextResponse } from 'next/server'
import { reconcileAll } from '@/lib/atproto/ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function verifyAuth(request: NextRequest): NextResponse | null {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('CRON_SECRET not set, allowing /api/atproto/sync in development')
      return null
    }
    console.error('CRON_SECRET not configured; refusing to reconcile')
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 })
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

export async function GET(request: NextRequest) {
  const denied = verifyAuth(request)
  if (denied) return denied

  try {
    const result = await reconcileAll()
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[atproto:sync] reconcileAll failed', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
