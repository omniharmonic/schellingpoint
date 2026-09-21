import 'server-only'
/**
 * Knowledge jobs (design §10.3 "ingest job"): a small queue of their own, separate from the
 * network publish jobs. Two kinds per gathering — `embed` (embed every chunk of the current
 * transcripts that is missing an embedding for the configured model) and `summaries` (per-session
 * summaries plus the gathering's themes). Drained by `GET /api/jobs/knowledge` every five minutes
 * from the scheduler, and kicked right after a request that queued one (`after()`).
 *
 * Claims use `for update skip locked`; a `running` job whose lock is older than STALE_LOCK_MS is
 * reclaimed. Out of time → back to `queued` and resumed next tick. Provider errors back off up
 * to MAX_ATTEMPTS. Every run also purges transcripts replaced more than 30 days ago.
 */
import { sql, type Sql } from '@/lib/db'
import { embedTexts, embeddingsConfig, EMBED_BATCH } from './embeddings'
import { runSummaries } from './summaries'

export type KnowledgeJobKind = 'embed' | 'summaries'
export type KnowledgeJobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

const STALE_LOCK_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 4
const REPLACED_RETENTION = '30 days'

export interface KnowledgeJobRow {
  id: string
  event_id: string
  kind: KnowledgeJobKind
  status: KnowledgeJobStatus
  attempts: number
  processed: number
  last_error: string | null
}

/** Queue a job unless one of that kind is already live for the gathering. */
export async function enqueueKnowledgeJob(db: Sql, eventId: string, kind: KnowledgeJobKind, requestedBy: string | null): Promise<{ id: string; created: boolean }> {
  const [existing] = await db<{ id: string }[]>`
    select id from knowledge_jobs where event_id = ${eventId} and kind = ${kind} and status in ('queued', 'running')
  `
  if (existing) return { id: existing.id, created: false }
  const [row] = await db<{ id: string }[]>`
    insert into knowledge_jobs (event_id, kind, requested_by) values (${eventId}, ${kind}, ${requestedBy}) returning id
  `
  return { id: row.id, created: true }
}

async function claimJob(onlyId?: string): Promise<KnowledgeJobRow | null> {
  const [row] = await sql<KnowledgeJobRow[]>`
    update knowledge_jobs set
      status = 'running', locked_at = now(), started_at = coalesce(started_at, now()), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from knowledge_jobs
      where ${onlyId ? sql`id = ${onlyId} and` : sql``}
        ((status = 'queued' and run_after <= now())
         or (status = 'running' and locked_at < now() - ${`${STALE_LOCK_MS} milliseconds`}::interval))
      order by run_after, created_at
      for update skip locked
      limit 1
    )
    returning id, event_id, kind, status, attempts, processed, last_error
  `
  return row ?? null
}

function describe(e: unknown): string {
  return (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500)
}

/** Embed chunks until none are left or the deadline passes. Returns whether everything is done. */
async function runEmbed(job: KnowledgeJobRow, deadline: number): Promise<{ done: boolean; processed: number }> {
  const cfg = embeddingsConfig()
  if (!cfg) return { done: true, processed: 0 } // nothing to do without a provider: a clean no-op
  let processed = 0
  while (Date.now() < deadline) {
    const rows = await sql<{ id: string; text: string }[]>`
      select c.id, c.text from transcript_chunks c
      join session_transcripts t on t.id = c.transcript_id and t.replaced_at is null and t.status = 'ready'
      where c.event_id = ${job.event_id} and (c.embedding is null or c.embedding_model is distinct from ${cfg.model})
      order by c.session_id, c.chunk_index
      limit ${EMBED_BATCH}
    `
    if (!rows.length) return { done: true, processed }
    const vectors = await embedTexts(rows.map((r) => r.text), 'document', cfg)
    await sql.begin(async (t) => {
      for (let i = 0; i < rows.length; i++) {
        await t`update transcript_chunks set embedding = ${vectors[i]}::real[], embedding_model = ${cfg.model} where id = ${rows[i].id}`
      }
    })
    processed += rows.length
    await sql`update knowledge_jobs set processed = processed + ${rows.length}, updated_at = now() where id = ${job.id}`
  }
  return { done: false, processed }
}

export interface RunJobsOptions {
  /** Stop after this long (default 240 s; the scheduler's curl allows 280). */
  timeBudgetMs?: number
  /** Run only this job (used right after queueing one). */
  jobId?: string
}

export interface JobOutcome {
  id: string
  kind: KnowledgeJobKind
  status: KnowledgeJobStatus
  processed: number
  error?: string
}

export async function runDueKnowledgeJobs(options: RunJobsOptions = {}): Promise<{ jobs: JobOutcome[]; purged: number }> {
  const deadline = Date.now() + (options.timeBudgetMs ?? 240_000)
  const purgedRows = await sql`delete from session_transcripts where replaced_at < now() - ${REPLACED_RETENTION}::interval returning id`
  const outcomes: JobOutcome[] = []
  while (Date.now() < deadline) {
    const job = await claimJob(options.jobId)
    if (!job) break
    try {
      const result = job.kind === 'embed' ? await runEmbed(job, deadline) : await runSummaries(job.event_id, deadline)
      if (result.done) {
        await sql`update knowledge_jobs set status = 'succeeded', finished_at = now(), locked_at = null, last_error = null, updated_at = now() where id = ${job.id}`
        outcomes.push({ id: job.id, kind: job.kind, status: 'succeeded', processed: job.processed + result.processed })
      } else {
        // Out of time: resume on the next tick without counting an attempt against the job.
        await sql`update knowledge_jobs set status = 'queued', run_after = now(), locked_at = null, attempts = attempts - 1, updated_at = now() where id = ${job.id}`
        outcomes.push({ id: job.id, kind: job.kind, status: 'queued', processed: job.processed + result.processed })
      }
    } catch (e) {
      const error = describe(e)
      console.error(`[knowledge:${job.kind}] job ${job.id} failed (attempt ${job.attempts}): ${error}`)
      if (job.attempts >= MAX_ATTEMPTS) {
        await sql`update knowledge_jobs set status = 'failed', finished_at = now(), locked_at = null, last_error = ${error}, updated_at = now() where id = ${job.id}`
        outcomes.push({ id: job.id, kind: job.kind, status: 'failed', processed: job.processed, error })
      } else {
        const backoffMinutes = 2 ** job.attempts
        await sql`update knowledge_jobs set status = 'queued', run_after = now() + ${`${backoffMinutes} minutes`}::interval, locked_at = null, last_error = ${error}, updated_at = now() where id = ${job.id}`
        outcomes.push({ id: job.id, kind: job.kind, status: 'queued', processed: job.processed, error })
      }
    }
    if (options.jobId) break
  }
  return { jobs: outcomes, purged: purgedRows.length }
}
