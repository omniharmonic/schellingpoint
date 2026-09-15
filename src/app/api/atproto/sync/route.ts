/**
 * GET /api/atproto/sync — reconciliation job (scheduler, hourly).
 *
 * `listRecords` every repo we follow (discovered with `com.atproto.sync.listRepos` on our PDS,
 * plus linked OAuth accounts, gathering actors and peers), upsert what they hold, remove what they
 * no longer hold, route peer listings, refresh the skills cache. The at-least-once safety net
 * behind the Jetstream consumer, and the only index path where the consumer is not running.
 *
 * `Authorization: Bearer $CRON_SECRET`; 401 otherwise (allowed without the secret in development).
 * The response carries counts and error summaries, never record bodies.
 */
import { authorizeCron } from '@/lib/notifications/cron'
import { reconcileAll } from '@/lib/atproto/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeCron(request)
  if (denied) return denied
  try {
    const result = await reconcileAll()
    return Response.json(
      { ...result, errors: result.errors.map((e) => ({ repo: e.did.startsWith('did:') ? 'repo' : e.did, error: e.error.slice(0, 300) })) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    console.error('[atproto:sync] reconcileAll failed:', e instanceof Error ? e.name : 'error')
    return Response.json({ error: 'Reconciliation failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
