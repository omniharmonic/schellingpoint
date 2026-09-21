/**
 * GET /api/jobs/knowledge — drain queued knowledge jobs (`knowledge_jobs`, migration 0024):
 * embeddings and summaries, plus the purge of transcripts replaced more than 30 days ago.
 *
 * Run every five minutes by the scheduler (`deploy/unconference/compose.yml`). Each tick claims
 * due jobs (`for update skip locked`) and works for up to ~4 minutes; a job that runs out of time
 * goes back to `queued` and resumes on a later tick.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`, 401 otherwise (allowed in development without
 * CRON_SECRET).
 */
import { runDueKnowledgeJobs } from '@/lib/knowledge/jobs'
import { json, jsonError, verifyCron } from '@/lib/voting/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const denied = verifyCron(request, '/api/jobs/knowledge')
  if (denied) return denied
  try {
    const out = await runDueKnowledgeJobs({ timeBudgetMs: 240_000 })
    return json({ purged: out.purged, jobs: out.jobs.map((j) => ({ ...j, ...(j.error ? { error: j.error.slice(0, 200) } : {}) })) })
  } catch (e) {
    console.error('[jobs:knowledge] failed', e instanceof Error ? e.name : 'error')
    return jsonError(500, 'knowledge jobs failed')
  }
}
