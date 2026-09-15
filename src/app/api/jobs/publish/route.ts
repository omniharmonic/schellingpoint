/**
 * GET /api/jobs/publish — drain queued network publishes (`publish_jobs`, migration 0011).
 *
 * Run every minute by the scheduler (`deploy/unconference/compose.yml`). Each tick claims due jobs
 * (`for update skip locked`) and works through them for up to ~4 minutes; a job that runs out of
 * time, or that the PDS rate-limits, goes back to `queued` and resumes on a later tick.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`, 401 otherwise (allowed in development without
 * CRON_SECRET).
 */
import { runDuePublishJobs } from '@/lib/atproto/publish-jobs'
import { json, jsonError, verifyCron } from '@/lib/voting/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const denied = verifyCron(request, '/api/jobs/publish')
  if (denied) return denied
  try {
    const out = await runDuePublishJobs({ timeBudgetMs: 240_000 })
    return json({ jobs: out.jobs.map((j) => ({ id: j.id, status: j.status, position: j.position, total: j.total, ...(j.error ? { error: j.error.slice(0, 200) } : {}) })) })
  } catch (e) {
    console.error('[jobs:publish] failed', e instanceof Error ? e.name : 'error')
    return jsonError(500, 'publish jobs failed')
  }
}
