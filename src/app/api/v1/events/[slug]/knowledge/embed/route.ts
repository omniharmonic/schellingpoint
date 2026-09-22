import { after } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { json } from '@/app/api/v1/sessions/_lib/access'
import { embeddingsConfig } from '@/lib/knowledge/embeddings'
import { enqueueKnowledgeJob, runDueKnowledgeJobs } from '@/lib/knowledge/jobs'
import { ORGANIZER_ROLES } from '@/lib/knowledge/store'

/**
 * POST /api/v1/events/[slug]/knowledge/embed  (design §10.3, organizers)
 *
 * Queue the embed job for every ready transcript of the gathering and start draining it right
 * after the response; the scheduler resumes it if it runs out of time. The default provider is the
 * on-box model, so this needs no API key; with `EMBEDDINGS_PROVIDER=none` it is a clean no-op:
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
  const cfg = embeddingsConfig()
  if (!cfg) return json({ configured: false, queued: false, message: 'Embeddings are switched off on this server (EMBEDDINGS_PROVIDER=none).' })
  const job = await enqueueKnowledgeJob(sql, gate.event.id, 'embed', gate.viewer.accountId)
  if (job.created) after(() => runDueKnowledgeJobs({ jobId: job.id, timeBudgetMs: 240_000 }).then(() => undefined).catch(() => undefined))
  return json({ configured: true, queued: job.created, job_id: job.id, provider: cfg.provider, model: cfg.model })
}
