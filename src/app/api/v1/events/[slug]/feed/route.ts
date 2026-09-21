/**
 * The gathering feed ledger, for organisers (design §7.4).
 *   GET  /api/v1/events/[slug]/feed                 { enabled, digestThreshold, blocked, actorHandle, counts, posts[≤20] }
 *   POST /api/v1/events/[slug]/feed  { action: 'retry', postId }   put a failed post back in the queue
 *                                    { action: 'deliver' }          run the gathering's queued posts now
 *
 * Settings themselves (`feed_posts`, `feed_digest_threshold`) are saved through
 * `PATCH /api/events/[eventId]/settings`; the person-level mention consent through
 * `PATCH …/participants/me`. Nothing here writes a record directly: retries and deliveries go
 * through the `publish_jobs` feed job, which calls the gathering actor port for every post.
 */
import { after } from 'next/server'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { feedState, kickFeedDelivery, retryFeedPost } from '@/lib/atproto/feed'
import { enqueueFeedJob } from '@/lib/atproto/publish-jobs'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('editEventSettings')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const state = await feedState(ctx.event.id, 20)
    if (!state) return fail(404, 'Event not found')
    return json(state)
  } catch (e) {
    return errorResponse(e, 'feed status')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body
  const eventId = ctx.event.id
  try {
    if (body.action === 'retry') {
      if (!isUuid(body.postId)) return fail(400, 'Choose a post to retry', { field: 'postId' })
      const queued = await retryFeedPost({ eventId, postId: body.postId, callerUserId: ctx.viewer.accountId })
      if (!queued) return fail(404, 'No failed post with that id')
      after(() => kickFeedDelivery(eventId))
      return json({ status: 'queued', jobId: queued.jobId })
    }
    if (body.action === 'deliver') {
      const state = await feedState(eventId, 1)
      if (!state) return fail(404, 'Event not found')
      if (state.blocked) return fail(409, `Nothing can be posted: ${state.blocked}.`)
      if (state.counts.queued === 0) return json({ status: 'idle', queued: 0 })
      const { job } = await enqueueFeedJob({ eventId, callerUserId: ctx.viewer.accountId })
      // Synchronous so the caller (and the tests) see the outcome; the scheduler resumes anything cut short.
      await kickFeedDelivery(eventId, 120_000)
      return json({ status: 'delivered', jobId: job.id, ...(await feedState(eventId, 20)) })
    }
    return fail(400, 'Unknown action', { field: 'action' })
  } catch (e) {
    return errorResponse(e, 'feed')
  }
}
