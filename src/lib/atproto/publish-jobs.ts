import 'server-only'
/**
 * Resumable schedule publishes (`publish_jobs`, migration 0011).
 *
 * A schedule of more than `JOB_THRESHOLD_SESSIONS` sessions is not written inside the organiser's
 * request: the route queues a job (one live job per gathering) and answers with its id; the job is
 * drained by `runDuePublishJobs` — kicked off right after the response (`after()`), and resumed by
 * the scheduler's `/api/jobs/publish` every minute. The organiser UI polls the job's progress.
 *
 *   - the session list is resolved when the job is queued; `position` of them are done
 *   - work happens in chunks of `SCHEDULE_BATCH_SESSIONS` through `publishSchedule` (idempotent:
 *     deterministic rkeys + CAS), so a crash or a timeout simply re-runs the chunk in flight
 *   - a chunk the PDS rate-limits is NOT counted: the job goes back to `queued` with `run_after`
 *     = when the limit lifts, and the same chunk runs again then
 *   - any other thrown error (credential unavailable, PDS down) re-queues with exponential backoff,
 *     up to `MAX_ATTEMPTS`; a denial (the requester is no longer an organiser) fails the job
 *   - claims use `for update skip locked`, and a `running` job whose lock is older than
 *     `STALE_LOCK_MS` is considered abandoned and reclaimed
 */
import { sql } from '@/lib/db'
import { publishSchedule, SCHEDULE_BATCH_SESSIONS, type PublishDeps, type PublishResult } from './publish'

export const JOB_THRESHOLD_SESSIONS = 25
export const MAX_ATTEMPTS = 6
const STALE_LOCK_MS = 10 * 60 * 1000
const MAX_STORED_RESULTS = 2000

export type PublishJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface PublishJob {
  id: string
  eventId: string
  status: PublishJobStatus
  total: number
  position: number
  published: number
  skipped: number
  failed: number
  lastError: string | null
  runAfter: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /**
   * Per-record results, plus `{ kind: 'feed', id }` markers: sessions whose slot this job FIRST
   * published, persisted per chunk so a resumed job still flushes ONE feed digest at the end.
   */
  results: Array<Pick<PublishResult, 'kind' | 'id' | 'uri' | 'error' | 'skipped'> | { kind: 'feed'; id: string }>
}

interface JobRow {
  id: string
  event_id: string
  /** `'schedule'` (session chunks) or `'feed'` (drain the gathering's queued `feed_posts`, design §7.4). */
  kind: 'schedule' | 'feed'
  requested_by: string | null
  session_ids: string[]
  position: number
  status: PublishJobStatus
  published: number
  skipped: number
  failed: number
  results: PublishJob['results']
  attempts: number
  last_error: string | null
  run_after: Date | string
  created_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
}

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString())

function toJob(row: JobRow): PublishJob {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    total: row.session_ids.length,
    position: row.position,
    published: row.published,
    skipped: row.skipped,
    failed: row.failed,
    lastError: row.last_error,
    runAfter: iso(row.run_after)!,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    results: row.results ?? [],
  }
}

/**
 * Every scheduled session with a time slot, in `publishSchedule`'s order.
 *
 * A session hidden by moderation is not published or re-published: the gathering has decided
 * not to carry it, and a publish run must not keep refreshing its calendar event afterwards.
 * (Withdrawing one that is *already* published is a destructive action and goes through the
 * approvals flow, which addresses sessions by id and so is unaffected by this filter.)
 */
export async function schedulableSessionIds(eventId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from sessions
    where event_id = ${eventId} and status = 'scheduled' and time_slot_id is not null
      and not coalesce(hidden_by_moderation, false)
    order by created_at, id
  `
  return rows.map((r) => r.id)
}

/** Should this publish run as a job? */
export function needsJob(sessionCount: number): boolean {
  return sessionCount > JOB_THRESHOLD_SESSIONS
}

/**
 * Queue a schedule publish. When one is already queued or running for the gathering, that job is
 * returned instead (`created: false`).
 */
export async function enqueueSchedulePublish(input: { eventId: string; callerUserId: string; sessionIds?: string[] }): Promise<{ job: PublishJob; created: boolean }> {
  const ids = input.sessionIds ?? (await schedulableSessionIds(input.eventId))
  const inserted = await sql<JobRow[]>`
    insert into publish_jobs (event_id, kind, requested_by, session_ids)
    values (${input.eventId}, 'schedule', ${input.callerUserId}, ${ids}::uuid[])
    on conflict (event_id, kind) where status in ('queued', 'running') do nothing
    returning *
  `
  if (inserted[0]) return { job: toJob(inserted[0]), created: true }
  const [active] = await sql<JobRow[]>`
    select * from publish_jobs where event_id = ${input.eventId} and kind = 'schedule' and status in ('queued', 'running')
    order by created_at desc limit 1
  `
  if (!active) throw new Error('could not queue the publish job')
  return { job: toJob(active), created: false }
}

/**
 * Queue a feed delivery job (design §7.4): one live `kind='feed'` job per gathering drains every
 * queued `feed_posts` row through `deliverQueuedPosts`. When one is already queued or running it
 * is returned (`created: false`) and, if queued, made due now so newly claimed rows go out promptly.
 * A `null` caller is a trusted server-side job (the port then runs `publish-post` as `system`).
 */
export async function enqueueFeedJob(input: { eventId: string; callerUserId: string | null }): Promise<{ job: PublishJob; created: boolean }> {
  const inserted = await sql<JobRow[]>`
    insert into publish_jobs (event_id, kind, requested_by, session_ids)
    values (${input.eventId}, 'feed', ${input.callerUserId}, '{}'::uuid[])
    on conflict (event_id, kind) where status in ('queued', 'running') do nothing
    returning *
  `
  if (inserted[0]) return { job: toJob(inserted[0]), created: true }
  const [active] = await sql<JobRow[]>`
    update publish_jobs set run_after = least(run_after, now()), updated_at = now()
    where id = (
      select id from publish_jobs where event_id = ${input.eventId} and kind = 'feed' and status in ('queued', 'running')
      order by created_at desc limit 1
    )
    returning *
  `
  if (!active) throw new Error('could not queue the feed delivery job')
  return { job: toJob(active), created: false }
}

/** One job of one gathering (tenant-scoped), or the latest when `jobId` is omitted. */
export async function getPublishJob(eventId: string, jobId?: string | null): Promise<PublishJob | null> {
  if (jobId && !/^[0-9a-f-]{36}$/i.test(jobId)) return null
  const rows = jobId
    ? await sql<JobRow[]>`select * from publish_jobs where id = ${jobId} and event_id = ${eventId}`
    : await sql<JobRow[]>`select * from publish_jobs where event_id = ${eventId} order by created_at desc limit 1`
  return rows[0] ? toJob(rows[0]) : null
}

async function claimJob(onlyId?: string): Promise<JobRow | null> {
  const [row] = await sql<JobRow[]>`
    update publish_jobs set
      status = 'running', locked_at = now(), started_at = coalesce(started_at, now()), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from publish_jobs
      where ${onlyId ? sql`id = ${onlyId} and` : sql``}
        ((status = 'queued' and run_after <= now())
         or (status = 'running' and locked_at < now() - ${`${STALE_LOCK_MS} milliseconds`}::interval))
      order by run_after, created_at
      for update skip locked
      limit 1
    )
    returning *
  `
  return row ?? null
}

function describe(e: unknown): string {
  return (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500)
}

/** What one chunk's results add to the job's counters (the same arithmetic as the publish routes). */
export function tallyChunk(results: PublishResult[]): { published: number; failed: number; skipped: number } {
  const failedIds = new Set(results.filter((r) => r.error).map((r) => r.id))
  const publishedIds = new Set(results.filter((r) => r.kind === 'slot' && !r.error && !r.skipped).map((r) => r.id))
  for (const id of failedIds) publishedIds.delete(id)
  return { published: publishedIds.size, failed: failedIds.size, skipped: results.filter((r) => r.skipped).length }
}

export interface RunJobsOptions {
  /** Stop claiming new chunks after this long (default 240 s; the scheduler's curl allows 280). */
  timeBudgetMs?: number
  /** Injected writer (tests). */
  deps?: PublishDeps
  /** Only this job. */
  jobId?: string
  /** Progress hook (tests, logs). */
  onProgress?: (job: { id: string; position: number; total: number }) => void
}

export interface RunJobsResult {
  jobs: Array<{ id: string; status: PublishJobStatus; position: number; total: number; error?: string }>
}

/** Drain due jobs until the time budget runs out. Never throws for one job. */
export async function runDuePublishJobs(opts: RunJobsOptions = {}): Promise<RunJobsResult> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 240_000)
  const out: RunJobsResult = { jobs: [] }
  while (Date.now() < deadline) {
    const row = await claimJob(opts.jobId)
    if (!row) break
    out.jobs.push(await runClaimed(row, deadline, opts))
    if (opts.jobId) break
  }
  return out
}

async function runClaimed(row: JobRow, deadline: number, opts: RunJobsOptions): Promise<RunJobsResult['jobs'][number]> {
  const total = row.session_ids.length
  let position = row.position
  const summary = (status: PublishJobStatus, error?: string) => ({ id: row.id, status, position, total, ...(error ? { error } : {}) })
  if (row.kind === 'feed') return runFeedClaimed(row, deadline, summary)
  if (!row.requested_by) {
    await sql`update publish_jobs set status = 'failed', last_error = 'the organiser who queued this publish no longer has an account', finished_at = now(), locked_at = null, updated_at = now() where id = ${row.id}`
    return summary('failed', 'requester gone')
  }
  try {
    while (position < total) {
      if (Date.now() >= deadline) {
        // Out of time: hand the rest to the next tick.
        await sql`update publish_jobs set status = 'queued', locked_at = null, run_after = now(), updated_at = now() where id = ${row.id} and status = 'running'`
        return summary('queued')
      }
      const [current] = await sql<{ status: PublishJobStatus }[]>`select status from publish_jobs where id = ${row.id}`
      if (current?.status === 'cancelled') return summary('cancelled')

      const slice = row.session_ids.slice(position, position + SCHEDULE_BATCH_SESSIONS)
      // A session unscheduled since the job was queued is not published by it.
      const still = await sql<{ id: string }[]>`
        select id from sessions where event_id = ${row.event_id} and id = any(${slice}::uuid[]) and status = 'scheduled' and time_slot_id is not null
      `
      const ids = slice.filter((id) => still.some((s) => s.id === id))
      // Feed (design §7.4): first-published sessions accumulate across chunks; flushed once below.
      const feedBatch: string[] = []
      const { results } = ids.length
        ? await publishSchedule({ eventId: row.event_id, callerUserId: row.requested_by, sessionIds: ids, feedBatch }, opts.deps)
        : { results: [] as PublishResult[] }

      const limited = results.filter((r) => typeof r.retryAfterMs === 'number')
      if (limited.length) {
        const waitMs = Math.max(1_000, ...limited.map((r) => r.retryAfterMs!))
        await sql`
          update publish_jobs set status = 'queued', locked_at = null, attempts = greatest(attempts - 1, 0),
            run_after = now() + ${`${waitMs} milliseconds`}::interval,
            last_error = ${`rate limited by the PDS; resuming in ${Math.ceil(waitMs / 1000)}s`}, updated_at = now()
          where id = ${row.id}
        `
        return summary('queued', 'rate-limited')
      }

      const t = tallyChunk(results)
      const stored = results.map((r) => ({ kind: r.kind, id: r.id, ...(r.uri ? { uri: r.uri } : {}), ...(r.error ? { error: r.error } : {}), ...(r.skipped ? { skipped: r.skipped } : {}) }))
      position += slice.length
      await sql`
        update publish_jobs set
          position = ${position},
          published = published + ${t.published}, failed = failed + ${t.failed}, skipped = skipped + ${t.skipped},
          results = (case when jsonb_array_length(results) >= ${MAX_STORED_RESULTS} then results else results || ${sql.json(stored as never)}::jsonb end)
                    || ${sql.json(feedBatch.map((id) => ({ kind: 'feed', id })) as never)}::jsonb,
          locked_at = now(), last_error = null, updated_at = now()
        where id = ${row.id}
      `
      opts.onProgress?.({ id: row.id, position, total })
    }
    // Feed (design §7.4): ONE flush for the whole job, from the markers persisted per chunk (so a
    // resumed job loses nothing). Claim-before-write in the ledger makes a repeated flush a no-op.
    await flushFeedMarkers(row.id, row.event_id, row.requested_by)
    await sql`update publish_jobs set status = 'succeeded', finished_at = now(), locked_at = null, updated_at = now() where id = ${row.id}`
    return summary('succeeded')
  } catch (e) {
    const detail = describe(e)
    const permanent = (e as { name?: string })?.name === 'GatheringActionDeniedError' || (e as { name?: string })?.name === 'GatheringNotLinkedError' || row.attempts >= MAX_ATTEMPTS
    if (permanent) {
      await sql`update publish_jobs set status = 'failed', last_error = ${detail}, finished_at = now(), locked_at = null, updated_at = now() where id = ${row.id}`
      return summary('failed', detail)
    }
    const backoffMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, row.attempts - 1))
    await sql`
      update publish_jobs set status = 'queued', last_error = ${detail}, locked_at = null,
        run_after = now() + ${`${backoffMs} milliseconds`}::interval, updated_at = now()
      where id = ${row.id}
    `
    return summary('queued', detail)
  }
}

/**
 * A `kind='feed'` job (design §7.4): post the gathering's queued `feed_posts` rows, oldest first,
 * until none are left or the time budget runs out. A rate limit re-queues the job for when the
 * limit lifts; any other thrown error backs off like a schedule job. Per-row failures are recorded
 * on the rows themselves (organisers retry from the Feed section) and never fail the job.
 */
/**
 * Flush the schedule job's persisted `{ kind: 'feed', id }` markers as ONE `session-scheduled`
 * enqueue (a digest when over the threshold). Idempotent: rows already claimed insert nothing.
 */
async function flushFeedMarkers(jobId: string, eventId: string, callerUserId: string | null): Promise<void> {
  const [row] = await sql<{ results: PublishJob['results'] }[]>`select results from publish_jobs where id = ${jobId}`
  const ids = Array.from(new Set((row?.results ?? []).filter((r) => r.kind === 'feed').map((r) => r.id)))
  if (!ids.length) return
  const { enqueueSessionPosts } = await import('./feed')
  await enqueueSessionPosts({ eventId, kind: 'session-scheduled', sessionIds: ids, callerUserId })
}

async function runFeedClaimed(
  row: JobRow,
  deadline: number,
  summary: (status: PublishJobStatus, error?: string) => RunJobsResult['jobs'][number],
): Promise<RunJobsResult['jobs'][number]> {
  try {
    const { deliverQueuedPosts } = await import('./feed')
    let posted = 0
    let failed = 0
    for (let pass = 0; pass < 100; pass++) {
      if (Date.now() >= deadline) {
        await sql`update publish_jobs set status = 'queued', locked_at = null, run_after = now(), updated_at = now() where id = ${row.id} and status = 'running'`
        return summary('queued')
      }
      const [current] = await sql<{ status: PublishJobStatus }[]>`select status from publish_jobs where id = ${row.id}`
      if (current?.status === 'cancelled') return summary('cancelled')
      const out = await deliverQueuedPosts({ eventId: row.event_id, callerUserId: row.requested_by })
      posted += out.posted
      failed += out.failed
      await sql`update publish_jobs set published = published + ${out.posted}, failed = failed + ${out.failed}, locked_at = now(), updated_at = now() where id = ${row.id}`
      if (typeof out.retryAfterMs === 'number') {
        const waitMs = Math.max(1_000, out.retryAfterMs)
        await sql`
          update publish_jobs set status = 'queued', locked_at = null, attempts = greatest(attempts - 1, 0),
            run_after = now() + ${`${waitMs} milliseconds`}::interval,
            last_error = ${`rate limited by the PDS; resuming in ${Math.ceil(waitMs / 1000)}s`}, updated_at = now()
          where id = ${row.id}
        `
        return summary('queued', 'rate-limited')
      }
      if (out.remaining === 0 || (out.posted === 0 && out.failed === 0)) break
    }
    await sql`update publish_jobs set status = 'succeeded', last_error = ${failed ? `${failed} post(s) failed; see the feed ledger` : null}, finished_at = now(), locked_at = null, updated_at = now() where id = ${row.id}`
    return summary('succeeded', failed ? `${posted} posted, ${failed} failed` : undefined)
  } catch (e) {
    const detail = describe(e)
    const permanent = (e as { name?: string })?.name === 'GatheringNotLinkedError' || row.attempts >= MAX_ATTEMPTS
    if (permanent) {
      await sql`update publish_jobs set status = 'failed', last_error = ${detail}, finished_at = now(), locked_at = null, updated_at = now() where id = ${row.id}`
      return summary('failed', detail)
    }
    const backoffMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, row.attempts - 1))
    await sql`
      update publish_jobs set status = 'queued', last_error = ${detail}, locked_at = null,
        run_after = now() + ${`${backoffMs} milliseconds`}::interval, updated_at = now()
      where id = ${row.id}
    `
    return summary('queued', detail)
  }
}
