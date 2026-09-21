import { after } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { json } from '@/app/api/v1/sessions/_lib/access'
import { chatConfig } from '@/lib/knowledge/anthropic'
import { enqueueKnowledgeJob, runDueKnowledgeJobs } from '@/lib/knowledge/jobs'
import { ORGANIZER_ROLES } from '@/lib/knowledge/store'

/**
 * POST /api/v1/events/[slug]/knowledge/summaries  (design §10.3, organizers)
 *
 * Queue the summaries job: a summary for every transcript without one, then the gathering's
 * themes. Stored members-only, never records. Without `ANTHROPIC_API_KEY` this is a clean no-op:
 * 200 `{ configured: false, queued: false }`.
 */

export const runtime = 'nodejs'

type RouteParams = { params: Promise<{ slug: string }> }

export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (gate instanceof Response) return gate
  const cfg = chatConfig()
  if (!cfg) return json({ configured: false, queued: false, message: 'No answer model is configured on this server.' })
  const job = await enqueueKnowledgeJob(sql, gate.event.id, 'summaries', gate.viewer.accountId)
  if (job.created) after(() => runDueKnowledgeJobs({ jobId: job.id, timeBudgetMs: 240_000 }).then(() => undefined).catch(() => undefined))
  return json({ configured: true, queued: job.created, job_id: job.id, model: cfg.model })
}
