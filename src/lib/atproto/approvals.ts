import 'server-only'
/**
 * Destructive actions and their approvals (spec §6 "Re-scheduling and cancellation").
 *
 * Moving or cancelling a session that is already on the PUBLISHED schedule, or removing a
 * listing, changes something people have put in their calendars. It needs the gathering policy's
 * `destructiveActionStewards` organiser approvals (default 2). Each approval is a
 * `freeschool.draft.approval` record written by the approving organiser IN THEIR OWN REPO, so the
 * threshold is verifiable from records rather than from our process state (Free School R3
 * invariant 10). The app keeps an `approval_requests` row and one `approval_request_approvals`
 * row per organiser; the gathering actor port re-checks the approvals when the action is applied.
 *
 *   requestSessionMove / requestSessionCancel / requestListingRemoval / requestFeedPostDeletion
 *     └─ caller must be owner/admin
 *     └─ not published yet? → nothing destructive: applied immediately (no approvals)
 *     └─ find-or-create the open request, then approve it as the caller:
 *          write the caller's approval record → insert the approval row
 *          → first approval: notify the other organisers (`approval_requested`)
 *          → approvals >= threshold: apply (new slot with `supersedes` + calendar event
 *            `#rescheduled`, or `#cancelled` + slot `cancelled`, or listing `removed`, or the
 *            feed post deleted from the gathering's repo) and notify the host and co-hosts
 *            (`session_rescheduled` / `session_cancelled`)
 *
 * A proposal is never deleted: it belongs to the proposer. An OAuth-door organiser who has not
 * confirmed public linkage (`profiles.publish_proposals`) is asked to (`confirmPublicLinkage`),
 * because the approval is a public record naming their DID as an organiser of this gathering.
 */
import type { TransactionSql } from 'postgres'
import { sql } from '@/lib/db'
import { readPolicyThresholds } from '@/lib/events/policy'
import { notify, type NotificationType } from '@/lib/notifications'
import { agentForAccount } from './agent'
import type { Approval } from './actor'
import { applyListingRemoval } from './listings'
import { NSID } from './nsids'
import { syncRoleClaim } from './role-claims'
import { publishingIdentity } from './participant'
import {
  cancelSession,
  currentSlotRkey,
  moveSession,
  movedSlotRkey,
  type PublishDeps,
  type PublishResult,
} from './publish'
import { assertNoForeignDid, buildApprovalRecord } from './records'
import { deterministicRkey } from './rkey'
import type { ApprovalRecord } from './types'
import { getRecord, isInvalidSwap, putRecord, deleteRecord } from './write'

export type ApprovalAction = 'move' | 'cancel' | 'remove-listing' | 'delete-post'
export type ApprovalStatus = 'pending' | 'applying' | 'applied' | 'withdrawn' | 'failed'

export interface DestructiveRequestResult {
  status: 'applied' | 'awaiting_approval'
  /** Approvals still needed before the action applies (0 once applied). */
  approvalsNeeded: number
  requestId?: string
  approvals?: number
  threshold?: number
  results?: PublishResult[]
}

export type ApprovalErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_target'
  | 'conflicting_request'
  | 'not_pending'
  | 'confirm_public_linkage'
  | 'relink_account'
  | 'invalid_reason'
  | 'apply_failed'

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApprovalError'
  }
}

interface EventRow {
  id: string
  slug: string
  name: string
  timezone: string
  actor_did: string | null
  policy_thresholds: unknown
}

interface SessionRow {
  id: string
  title: string
  host_id: string | null
  time_slot_id: string | null
  venue_id: string | null
  slot_uri: string | null
  slot_cid: string | null
  calendar_event_uri: string | null
  cancelled_at: string | null
}

interface RequestRow {
  id: string
  event_id: string
  session_id: string | null
  listing_id: string | null
  feed_post_id: string | null
  action: ApprovalAction
  status: ApprovalStatus
  requested_by: string | null
  reason: string
  target: { timeSlotId?: string; venueId?: string | null }
  threshold: number
  subject_uri: string | null
  proposal_uri: string
  error: string | null
  created_at: string
}

const ORGANIZER_ROLES = ['owner', 'admin']

async function loadEvent(eventId: string): Promise<EventRow> {
  const [event] = await sql<EventRow[]>`
    select id, slug, name, timezone, actor_did, policy_thresholds from events where id = ${eventId}
  `
  if (!event) throw new ApprovalError('not_found', 'Event not found', 404)
  return event
}

async function requireOrganizer(eventId: string, accountId: string): Promise<void> {
  const [row] = await sql<{ role: string }[]>`select role from event_members where event_id = ${eventId} and user_id = ${accountId}`
  if (!row || !ORGANIZER_ROLES.includes(row.role)) {
    throw new ApprovalError('forbidden', 'Only an owner or admin of this gathering can request or approve this change', 403)
  }
}

async function thresholdFor(event: EventRow): Promise<number> {
  return readPolicyThresholds(event.policy_thresholds).destructiveActionStewards
}

function cleanReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : ''
  if (!r || r.length > 2000) throw new ApprovalError('invalid_reason', 'Give a reason (up to 2000 characters); it is recorded with every approval', 400)
  return r
}

async function loadSession(eventId: string, sessionId: string): Promise<SessionRow> {
  const [s] = await sql<SessionRow[]>`
    select id, title, host_id, time_slot_id, venue_id, slot_uri, slot_cid, calendar_event_uri, cancelled_at
    from sessions where id = ${sessionId} and event_id = ${eventId}
  `
  if (!s) throw new ApprovalError('not_found', 'Session not found in this gathering', 404)
  return s
}

async function loadRequest(eventId: string, requestId: string): Promise<RequestRow> {
  const [r] = await sql<RequestRow[]>`
    select id, event_id, session_id, listing_id, feed_post_id, action, status, requested_by, reason, target, threshold, subject_uri, proposal_uri, error, created_at
    from approval_requests where id = ${requestId} and event_id = ${eventId}
  `
  if (!r) throw new ApprovalError('not_found', 'Approval request not found', 404)
  return r
}

async function approvalsOf(requestId: string): Promise<Approval[]> {
  const rows = await sql<{ account_id: string; record_uri: string; record_cid: string; created_at: string }[]>`
    select account_id, record_uri, record_cid, created_at from approval_request_approvals where request_id = ${requestId} order by created_at
  `
  return rows.map((r) => ({ accountId: r.account_id, recordUri: r.record_uri, recordCid: r.record_cid, at: r.created_at }))
}

/* ─────────────────────────────── notifications ─────────────────────────────── */

/** Notify inside a savepoint: a notification failure never undoes the action it describes. */
async function notifySafely(t: TransactionSql, input: Parameters<typeof notify>[1]): Promise<void> {
  try {
    await t.savepoint((s) => notify(s, input))
  } catch (e) {
    console.warn('[atproto:approvals] notification not written:', e instanceof Error ? e.name : 'error')
  }
}

async function organizersExcept(eventId: string, accountId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select user_id from event_members where event_id = ${eventId} and role in ('owner', 'admin') and user_id <> ${accountId}
  `
  return rows.map((r) => r.user_id)
}

async function hostsOf(sessionId: string): Promise<string[]> {
  const rows = await sql<{ id: string | null }[]>`
    select host_id as id from sessions where id = ${sessionId}
    union
    select user_id as id from session_cohosts where session_id = ${sessionId}
  `
  return rows.map((r) => r.id).filter((id): id is string => !!id)
}

function whenIn(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso))
  } catch {
    return new Date(iso).toISOString()
  }
}

/* ─────────────────────────────── the approval record ─────────────────────────────── */

const ACTION_OF: Record<ApprovalAction, ApprovalRecord['action']> = {
  move: 'other',
  cancel: 'other',
  'remove-listing': 'remove-listing',
  'delete-post': 'other',
}

/**
 * Write the caller's `freeschool.draft.approval` into THEIR OWN repo. Deterministic rkey per
 * request, so a retried approval rewrites the same record instead of adding a second one.
 */
async function writeApprovalRecord(request: RequestRow, event: EventRow, accountId: string): Promise<{ uri: string; cid: string }> {
  const identity = await publishingIdentity(accountId, { requireLinkage: false })
  const reasonPrefix =
    request.action === 'move'
      ? 'Move a published session'
      : request.action === 'cancel'
        ? 'Cancel a published session'
        : request.action === 'delete-post'
          ? 'Retract a post from the gathering’s feed'
          : 'Remove a listing'
  const record = buildApprovalRecord({
    proposal: request.proposal_uri,
    action: ACTION_OF[request.action],
    subjectRecord: request.subject_uri,
    reason: `${reasonPrefix} of ${event.name}: ${request.reason}`,
    createdAt: new Date(),
  })
  // R9: names records, never people. At-URIs to the gathering's records are references.
  assertNoForeignDid(record, identity.did)
  let agent
  try {
    agent = await agentForAccount(accountId)
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NoActorCredentialError' || name === 'ProfileNotLinkedError') {
      throw new ApprovalError('relink_account', 'Your ATProto session has expired or you took ownership of your account; sign in with ATProto again to approve', 409)
    }
    throw e
  }
  const rkey = deterministicRkey('approval', request.id)
  try {
    return await putRecord(agent, { repo: identity.did, collection: NSID.approval, rkey, record: record as unknown as Record<string, unknown>, swapRecord: null })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    // Already written by an earlier attempt that failed before its row committed: reuse it.
    const existing = await getRecord<ApprovalRecord>(identity.did, NSID.approval, rkey)
    if (existing && existing.value.proposal === request.proposal_uri) return { uri: existing.uri, cid: existing.cid }
    return putRecord(agent, { repo: identity.did, collection: NSID.approval, rkey, record: record as unknown as Record<string, unknown>, swapRecord: existing?.cid ?? null })
  }
}

/* ─────────────────────────────── core ─────────────────────────────── */

async function findOrCreateRequest(input: {
  event: EventRow
  sessionId: string | null
  listingId: string | null
  feedPostId?: string | null
  action: ApprovalAction
  callerUserId: string
  reason: string
  target: Record<string, unknown>
  subjectUri: string | null
  proposalUri: string
  threshold: number
}): Promise<{ request: RequestRow; created: boolean }> {
  return sql.begin(async (t) => {
    const subjectId = input.sessionId ?? input.listingId ?? input.feedPostId ?? null
    await t`select pg_advisory_xact_lock(hashtext(${`approval:${input.event.id}:${subjectId}:${input.action}`}))`
    const open = await t<RequestRow[]>`
      select id, event_id, session_id, listing_id, feed_post_id, action, status, requested_by, reason, target, threshold, subject_uri, proposal_uri, error, created_at
      from approval_requests
      where event_id = ${input.event.id} and action = ${input.action} and status in ('pending', 'applying')
        and ${input.sessionId ? t`session_id = ${input.sessionId}` : input.listingId ? t`listing_id = ${input.listingId}` : t`feed_post_id = ${input.feedPostId ?? null}`}
    `
    if (open[0]) {
      if (open[0].proposal_uri !== input.proposalUri) {
        throw new ApprovalError('conflicting_request', 'A different change to this is already awaiting approval; approve or withdraw it first', 409)
      }
      return { request: open[0], created: false }
    }
    const [request] = await t<RequestRow[]>`
      insert into approval_requests (event_id, session_id, listing_id, feed_post_id, action, requested_by, reason, target, threshold, subject_uri, proposal_uri)
      values (
        ${input.event.id}, ${input.sessionId}, ${input.listingId}, ${input.feedPostId ?? null}, ${input.action}, ${input.callerUserId}, ${input.reason},
        ${t.json(input.target as never)}, ${input.threshold}, ${input.subjectUri}, ${input.proposalUri}
      )
      returning id, event_id, session_id, listing_id, feed_post_id, action, status, requested_by, reason, target, threshold, subject_uri, proposal_uri, error, created_at
    `
    return { request: request!, created: true }
  })
}

async function approveInternal(
  request: RequestRow,
  event: EventRow,
  callerUserId: string,
  opts: { created: boolean; confirmPublicLinkage?: boolean; deps?: PublishDeps },
): Promise<DestructiveRequestResult> {
  if (request.status !== 'pending') {
    throw new ApprovalError('not_pending', `This request is ${request.status}`, 409)
  }
  await publishingIdentity(callerUserId, { confirmPublicLinkage: opts.confirmPublicLinkage, forApproval: true })

  const already = await sql<{ id: string }[]>`
    select id from approval_request_approvals where request_id = ${request.id} and account_id = ${callerUserId}
  `
  if (!already[0]) {
    const record = await writeApprovalRecord(request, event, callerUserId)
    await sql.begin(async (t) => {
      await t`
        insert into approval_request_approvals (event_id, request_id, account_id, record_uri, record_cid)
        values (${event.id}, ${request.id}, ${callerUserId}, ${record.uri}, ${record.cid})
        on conflict (request_id, account_id) do update set record_uri = excluded.record_uri, record_cid = excluded.record_cid
      `
      await t`update approval_requests set updated_at = now() where id = ${request.id}`
      if (opts.created) {
        const others = await organizersExcept(event.id, callerUserId)
        const subject = request.session_id
          ? (await t<{ title: string }[]>`select title from sessions where id = ${request.session_id}`)[0]?.title ?? 'a session'
          : request.feed_post_id
            ? 'a feed post'
            : 'a listing'
        await notifySafely(t, {
          eventId: event.id,
          userIds: others,
          type: 'approval_requested',
          title:
            request.action === 'move'
              ? `Approve moving “${subject}”`
              : request.action === 'cancel'
                ? `Approve cancelling “${subject}”`
                : request.action === 'delete-post'
                  ? 'Approve retracting a feed post'
                  : 'Approve removing a listing',
          body: `An organiser asked for this change to the published schedule. It needs ${request.threshold} organiser approvals. Reason: ${request.reason}`.slice(0, 1000),
          actionUrl: `/e/${event.slug}/admin/atproto#approvals`,
          data: { requestId: request.id, action: request.action },
        })
      }
    })
  }

  const approvals = await approvalsOf(request.id)
  const threshold = Math.max(request.threshold, await thresholdFor(event))
  if (approvals.length < threshold) {
    return { status: 'awaiting_approval', approvalsNeeded: threshold - approvals.length, requestId: request.id, approvals: approvals.length, threshold }
  }
  return applyRequest(request, event, callerUserId, approvals, threshold, opts.deps)
}

async function applyRequest(
  request: RequestRow,
  event: EventRow,
  callerUserId: string,
  approvals: Approval[],
  threshold: number,
  deps?: PublishDeps,
): Promise<DestructiveRequestResult> {
  const claimed = await sql`
    update approval_requests set status = 'applying', updated_at = now() where id = ${request.id} and status = 'pending' returning id
  `
  if (!claimed.length) {
    const current = await loadRequest(event.id, request.id)
    return { status: current.status === 'applied' ? 'applied' : 'awaiting_approval', approvalsNeeded: 0, requestId: request.id, approvals: approvals.length, threshold }
  }

  let results: PublishResult[] = []
  let deletedPost = false
  try {
    if (request.action === 'delete-post') {
      const { deleteFeedPost } = await import('./feed')
      const done = await deleteFeedPost({
        eventId: event.id,
        postId: request.feed_post_id!,
        callerUserId,
        reason: `Retract a post of ${event.name}: ${request.reason}`,
        approvals,
      })
      if (!done) throw new Error('that post is no longer on the network')
      deletedPost = true
    } else if (request.action === 'move') {
      const target = request.target.timeSlotId ? { timeSlotId: request.target.timeSlotId, venueId: request.target.venueId ?? null } : undefined
      results = (await moveSession({ eventId: event.id, callerUserId, sessionId: request.session_id!, approvals, target }, deps)).results
    } else if (request.action === 'cancel') {
      results = (await cancelSession({ eventId: event.id, callerUserId, sessionId: request.session_id!, approvals }, deps)).results
    } else {
      results = await applyListingRemoval({ eventId: event.id, listingId: request.listing_id!, callerUserId, approvals, reason: request.reason }, deps)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await sql`update approval_requests set status = 'pending', error = ${message.slice(0, 1000)}, updated_at = now() where id = ${request.id}`
    throw new ApprovalError('apply_failed', `The approved change could not be written: ${message}`, 502)
  }

  const destructiveKinds = request.action === 'remove-listing' ? ['listing'] : ['session-event', 'slot']
  const failure = results.find((r) => r.error && destructiveKinds.includes(r.kind))
  const wrote = deletedPost || results.some((r) => !r.error && !r.skipped && destructiveKinds.includes(r.kind))
  if (failure || (!wrote && !results.some((r) => r.skipped === 'unchanged'))) {
    const message = failure?.error ?? results.find((r) => r.error)?.error ?? 'nothing was written'
    await sql`update approval_requests set status = 'pending', error = ${message.slice(0, 1000)}, updated_at = now() where id = ${request.id}`
    throw new ApprovalError('apply_failed', `The approved change could not be written: ${message}`, 502)
  }

  await sql.begin(async (t) => {
    await t`update approval_requests set status = 'applied', applied_at = now(), error = null, updated_at = now() where id = ${request.id}`
    if (request.session_id) {
      const [s] = await t<{ title: string; start_time: string | null }[]>`
        select s.title, ts.start_time from sessions s left join time_slots ts on ts.id = s.time_slot_id where s.id = ${request.session_id}
      `
      const type: NotificationType = request.action === 'move' ? 'session_rescheduled' : 'session_cancelled'
      await notifySafely(t, {
        eventId: event.id,
        userIds: await hostsOf(request.session_id),
        type,
        title: request.action === 'move' ? `“${s?.title ?? 'Your session'}” was moved` : `“${s?.title ?? 'Your session'}” was cancelled`,
        body:
          request.action === 'move' && s?.start_time
            ? `It now starts ${whenIn(s.start_time, event.timezone)}. Calendars that follow the schedule update automatically.`
            : `The organisers cancelled it on the published schedule. Your proposal stays yours. Reason: ${request.reason}`.slice(0, 1000),
        actionUrl: `/e/${event.slug}/sessions/${request.session_id}`,
        data: { sessionId: request.session_id, requestId: request.id },
      })
    }
  })

  if (request.action === 'cancel' && request.session_id) {
    // Cancelling can drop a host below the role-claim bar; re-evaluate their public claim.
    for (const accountId of await hostsOf(request.session_id)) await syncRoleClaim(event.id, accountId).catch(() => undefined)
  }
  return { status: 'applied', approvalsNeeded: 0, requestId: request.id, approvals: approvals.length, threshold, results }
}

/* ─────────────────────────────── public API ─────────────────────────────── */

export interface SessionChangeInput {
  eventId: string
  sessionId: string
  callerUserId: string
  reason: string
  /** Required for an OAuth-door organiser who has not yet confirmed public linkage. */
  confirmPublicLinkage?: boolean
}

export interface SessionMoveInput extends SessionChangeInput {
  /**
   * Where the session moves to. When omitted, the session row's current `time_slot_id` /
   * `venue_id` — an organiser already moved it in the schedule draft. The target is snapshotted
   * on the request, so later draft edits never change what the approvers approved.
   */
  target?: { timeSlotId: string; venueId?: string | null }
}

/** Move a session. Published → needs approvals; unpublished → applied app-side at once. */
export async function requestSessionMove(input: SessionMoveInput, deps?: PublishDeps): Promise<DestructiveRequestResult> {
  const reason = cleanReason(input.reason)
  const event = await loadEvent(input.eventId)
  await requireOrganizer(event.id, input.callerUserId)
  const session = await loadSession(event.id, input.sessionId)
  const timeSlotId = input.target?.timeSlotId ?? session.time_slot_id
  if (!timeSlotId) throw new ApprovalError('invalid_target', 'Choose the time slot to move the session to', 400)
  const [slot] = await sql<{ id: string; start_time: string; venue_id: string | null }[]>`
    select id, start_time, venue_id from time_slots where id = ${timeSlotId} and event_id = ${event.id}
  `
  if (!slot) throw new ApprovalError('invalid_target', 'That time slot is not part of this gathering', 400)
  const venueId = input.target ? (input.target.venueId ?? slot.venue_id) : (session.venue_id ?? slot.venue_id)
  if (venueId) {
    const [venue] = await sql`select 1 from venues where id = ${venueId} and event_id = ${event.id}`
    if (!venue) throw new ApprovalError('invalid_target', 'That venue is not part of this gathering', 400)
  }

  if (!session.slot_uri || !event.actor_did) {
    // Not on the published network schedule: moving it destroys nothing anyone relies on.
    await sql`update sessions set time_slot_id = ${slot.id}, venue_id = ${venueId} where id = ${session.id} and event_id = ${event.id}`
    return { status: 'applied', approvalsNeeded: 0, results: [] }
  }

  const threshold = await thresholdFor(event)
  const { request, created } = await findOrCreateRequest({
    event,
    sessionId: session.id,
    listingId: null,
    action: 'move',
    callerUserId: input.callerUserId,
    reason,
    target: { timeSlotId: slot.id, venueId },
    subjectUri: session.slot_uri,
    proposalUri: `at://${event.actor_did}/${NSID.slot}/${movedSlotRkey(session.id, slot.start_time)}`,
    threshold,
  })
  return approveInternal(request, event, input.callerUserId, { created, confirmPublicLinkage: input.confirmPublicLinkage, deps })
}

/** Cancel a session. Published → needs approvals (base-lexicon `#cancelled`); the proposal is never deleted. */
export async function requestSessionCancel(input: SessionChangeInput, deps?: PublishDeps): Promise<DestructiveRequestResult> {
  const reason = cleanReason(input.reason)
  const event = await loadEvent(input.eventId)
  await requireOrganizer(event.id, input.callerUserId)
  const session = await loadSession(event.id, input.sessionId)
  if (session.cancelled_at) return { status: 'applied', approvalsNeeded: 0, results: [] }
  if (!session.calendar_event_uri || !session.slot_uri || !event.actor_did) {
    return { status: 'applied', approvalsNeeded: 0, results: [] }
  }
  const threshold = await thresholdFor(event)
  const slotUri = `at://${event.actor_did}/${NSID.slot}/${currentSlotRkey(session)}`
  const { request, created } = await findOrCreateRequest({
    event,
    sessionId: session.id,
    listingId: null,
    action: 'cancel',
    callerUserId: input.callerUserId,
    reason,
    target: {},
    subjectUri: session.calendar_event_uri,
    proposalUri: slotUri,
    threshold,
  })
  return approveInternal(request, event, input.callerUserId, { created, confirmPublicLinkage: input.confirmPublicLinkage, deps })
}

/** Remove a listing (moderation). Always destructive: the listing is already public. */
export async function requestListingRemoval(
  input: { eventId: string; listingId: string; callerUserId: string; reason: string; confirmPublicLinkage?: boolean },
  deps?: PublishDeps,
): Promise<DestructiveRequestResult> {
  const reason = cleanReason(input.reason)
  const event = await loadEvent(input.eventId)
  await requireOrganizer(event.id, input.callerUserId)
  const [listing] = await sql<{ id: string; subject_uri: string; record_uri: string | null; status: string }[]>`
    select id, subject_uri, record_uri, status from listings where id = ${input.listingId} and event_id = ${event.id}
  `
  if (!listing?.record_uri) throw new ApprovalError('not_found', 'Listing not found in this gathering', 404)
  if (listing.status === 'removed') return { status: 'applied', approvalsNeeded: 0, results: [] }
  const threshold = await thresholdFor(event)
  const { request, created } = await findOrCreateRequest({
    event,
    sessionId: null,
    listingId: listing.id,
    action: 'remove-listing',
    callerUserId: input.callerUserId,
    reason,
    target: {},
    subjectUri: listing.subject_uri,
    proposalUri: listing.record_uri,
    threshold,
  })
  return approveInternal(request, event, input.callerUserId, { created, confirmPublicLinkage: input.confirmPublicLinkage, deps })
}

/**
 * Retract a post from the gathering's feed. Always destructive: the post is already out, people
 * may have seen or shared it, and deleting it is exactly the kind of change spec §6 puts behind
 * `destructiveActionStewards` approvals. The ledger row is kept (`status = 'deleted'`) so the
 * retraction itself is visible to organisers.
 */
export async function requestFeedPostDeletion(
  input: { eventId: string; postId: string; callerUserId: string; reason: string; confirmPublicLinkage?: boolean },
  deps?: PublishDeps,
): Promise<DestructiveRequestResult> {
  const reason = cleanReason(input.reason)
  const event = await loadEvent(input.eventId)
  await requireOrganizer(event.id, input.callerUserId)
  const [post] = await sql<{ id: string; uri: string | null; status: string }[]>`
    select id, uri, status from feed_posts where id = ${input.postId} and event_id = ${event.id}
  `
  if (!post) throw new ApprovalError('not_found', 'No such post in this gathering', 404)
  if (post.status === 'deleted') return { status: 'applied', approvalsNeeded: 0, results: [] }
  if (post.status !== 'posted' || !post.uri) {
    // Never written to the repo: there is nothing destructive to approve.
    throw new ApprovalError('invalid_target', 'That post is not on the network, so there is nothing to retract', 409)
  }
  const threshold = await thresholdFor(event)
  const { request, created } = await findOrCreateRequest({
    event,
    sessionId: null,
    listingId: null,
    feedPostId: post.id,
    action: 'delete-post',
    callerUserId: input.callerUserId,
    reason,
    target: {},
    subjectUri: post.uri,
    proposalUri: post.uri,
    threshold,
  })
  return approveInternal(request, event, input.callerUserId, { created, confirmPublicLinkage: input.confirmPublicLinkage, deps })
}

/** A further organiser approves an open request (or retries applying one that failed to write). */
export async function approveRequest(
  input: { eventId: string; requestId: string; callerUserId: string; confirmPublicLinkage?: boolean },
  deps?: PublishDeps,
): Promise<DestructiveRequestResult> {
  const event = await loadEvent(input.eventId)
  await requireOrganizer(event.id, input.callerUserId)
  const request = await loadRequest(event.id, input.requestId)
  return approveInternal(request, event, input.callerUserId, { created: false, confirmPublicLinkage: input.confirmPublicLinkage, deps })
}

/**
 * Withdraw the caller's own approval (deleting their record from their repo). When the caller
 * requested it, the request is withdrawn too. Other organisers' records are theirs; we never
 * delete them.
 */
export async function withdrawApproval(input: { eventId: string; requestId: string; callerUserId: string }): Promise<{ status: ApprovalStatus }> {
  const event = await loadEvent(input.eventId)
  await requireOrganizer(event.id, input.callerUserId)
  const request = await loadRequest(event.id, input.requestId)
  if (request.status !== 'pending') throw new ApprovalError('not_pending', `This request is ${request.status}`, 409)
  const [mine] = await sql<{ record_uri: string; record_cid: string }[]>`
    select record_uri, record_cid from approval_request_approvals where request_id = ${request.id} and account_id = ${input.callerUserId}
  `
  if (mine) {
    const identity = await publishingIdentity(input.callerUserId, { requireLinkage: false })
    const rkey = mine.record_uri.slice(mine.record_uri.lastIndexOf('/') + 1)
    try {
      await deleteRecord(await agentForAccount(input.callerUserId), { repo: identity.did, collection: NSID.approval, rkey, swapRecord: mine.record_cid })
    } catch (e) {
      if (!isInvalidSwap(e)) throw e
    }
    await sql`delete from approval_request_approvals where request_id = ${request.id} and account_id = ${input.callerUserId}`
  }
  const status: ApprovalStatus = request.requested_by === input.callerUserId ? 'withdrawn' : 'pending'
  if (status === 'withdrawn') await sql`update approval_requests set status = 'withdrawn', updated_at = now() where id = ${request.id}`
  return { status }
}

export interface ApprovalRequestView {
  id: string
  action: ApprovalAction
  status: ApprovalStatus
  reason: string
  threshold: number
  sessionId: string | null
  sessionTitle: string | null
  listingId: string | null
  feedPostId: string | null
  target: { timeSlotId?: string; venueId?: string | null; startsAt?: string | null; endsAt?: string | null }
  requestedBy: { accountId: string; handle: string | null } | null
  approvals: Array<{ accountId: string; handle: string | null; recordUri: string; createdAt: string }>
  error: string | null
  createdAt: string
}

/** Organiser view of open and recent requests. */
export async function listApprovalRequests(eventId: string, opts: { limit?: number } = {}): Promise<ApprovalRequestView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await sql<Array<RequestRow & { session_title: string | null; requester_handle: string | null; starts_at: string | null; ends_at: string | null }>>`
    select r.id, r.event_id, r.session_id, r.listing_id, r.feed_post_id, r.action, r.status, r.requested_by, r.reason, r.target, r.threshold,
           r.subject_uri, r.proposal_uri, r.error, r.created_at,
           s.title as session_title, a.handle as requester_handle, ts.start_time as starts_at, ts.end_time as ends_at
    from approval_requests r
    left join sessions s on s.id = r.session_id
    left join accounts a on a.id = r.requested_by
    left join time_slots ts on ts.id = nullif(r.target ->> 'timeSlotId', '')::uuid
    where r.event_id = ${eventId}
    order by (r.status in ('pending', 'applying')) desc, r.created_at desc
    limit ${limit}
  `
  if (!rows.length) return []
  const approvals = await sql<{ request_id: string; account_id: string; handle: string | null; record_uri: string; created_at: string }[]>`
    select ap.request_id, ap.account_id, a.handle, ap.record_uri, ap.created_at
    from approval_request_approvals ap join accounts a on a.id = ap.account_id
    where ap.event_id = ${eventId} and ap.request_id in ${sql(rows.map((r) => r.id))}
    order by ap.created_at
  `
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    status: r.status,
    reason: r.reason,
    threshold: r.threshold,
    sessionId: r.session_id,
    sessionTitle: r.session_title,
    listingId: r.listing_id,
    feedPostId: r.feed_post_id,
    target: { ...r.target, startsAt: r.starts_at, endsAt: r.ends_at },
    requestedBy: r.requested_by ? { accountId: r.requested_by, handle: r.requester_handle } : null,
    approvals: approvals
      .filter((a) => a.request_id === r.id)
      .map((a) => ({ accountId: a.account_id, handle: a.handle, recordUri: a.record_uri, createdAt: a.created_at })),
    error: r.error,
    createdAt: r.created_at,
  }))
}
