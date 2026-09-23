import 'server-only'
/**
 * Session mergers (PRD §4.4) under ballot-key privacy (spec §5.4). Inventory 3.8 / P2-16.
 *
 * Shape, and why it is this shape:
 *
 *   A proposer asks to fold THEIR session into ANOTHER. The other session's proposer accepts
 *   or declines. Nothing happens to anyone's repository: R9 says an organizer — or a fellow
 *   proposer — never edits someone else's record, and that holds for a merger too. The source
 *   proposal stays exactly as its author wrote it, in their own repo; the app marks it
 *   `merged_into` and hides it from the lists. If the author wants it gone from the network
 *   they withdraw it themselves, as they always could. The calendar event is only ever
 *   written for the target, so the network sees one session, not two.
 *
 *   Co-hosts are not moved. A co-host accepted an invitation to a particular session and
 *   wrote their own `cohost` record about it; we cannot re-point that record and we do not
 *   try. They keep it, and the target's proposer can invite them if they want them on stage.
 *
 * Votes. The PRD multiplies the combined total by 1.1 to "incentivize collaboration". That
 * bonus cannot survive this design and is deliberately NOT applied — see the note added to
 * `docs/ATPROTO_MIGRATION_SPEC.md` §5. What we do instead, at round close: the target's tally
 * counts entries for either session id, deduplicated by `ballot_token`, taking the larger of
 * the two votes when one token backed both. One person who wanted both sessions is one
 * person, not two, and after the key is destroyed a token is all we have to say so.
 */
import { sql, tx, type Sql } from '@/lib/db'
import { notify } from '@/lib/notifications'

export type MergeStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn'
export type MergeDecision = 'accept' | 'decline' | 'withdraw' | 'unmerge'

export class MergeError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'MergeRefused', readonly field?: string) {
    super(message)
    this.name = 'MergeError'
  }
}

export interface MergeRequestView {
  id: string
  status: MergeStatus
  message: string | null
  declineReason: string | null
  createdAt: string
  decidedAt: string | null
  source: { id: string; title: string }
  target: { id: string; title: string }
  /** What this viewer may do about it right now. */
  viewer: { isRequester: boolean; canDecide: boolean }
}

interface MergeSessionRow {
  id: string
  event_id: string
  title: string
  host_id: string | null
  status: string
  merged_into: string | null
  calendar_event_uri: string | null
}

const SESSION_COLUMNS = (t: Sql) => t`id, event_id, title, host_id, status, merged_into, calendar_event_uri`

/** Statuses in which a gathering still lets proposers rearrange their own proposals. */
const MERGEABLE_EVENT_STATUSES = ['published', 'proposals_open', 'voting_open', 'scheduling', 'live']

async function loadSession(db: Sql, sessionId: string, eventId: string): Promise<MergeSessionRow | null> {
  const [row] = await db<MergeSessionRow[]>`
    select ${SESSION_COLUMNS(db)} from sessions where id = ${sessionId} and event_id = ${eventId}
  `
  return row ?? null
}

function toView(
  row: {
    id: string; status: string; message: string | null; decline_reason: string | null
    created_at: string; decided_at: string | null; requested_by: string | null
    source_session_id: string; source_title: string; target_session_id: string; target_title: string
    target_host_id: string | null
  },
  accountId: string | null,
): MergeRequestView {
  return {
    id: row.id,
    status: row.status as MergeStatus,
    message: row.message,
    declineReason: row.decline_reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    source: { id: row.source_session_id, title: row.source_title },
    target: { id: row.target_session_id, title: row.target_title },
    viewer: {
      isRequester: !!accountId && row.requested_by === accountId,
      canDecide: row.status === 'pending' && !!accountId && row.target_host_id === accountId,
    },
  }
}

const REQUEST_QUERY = (db: Sql) => db`
  select r.id, r.status, r.message, r.decline_reason, r.created_at, r.decided_at, r.requested_by,
         r.source_session_id, src.title as source_title, src.host_id as source_host_id,
         r.target_session_id, tgt.title as target_title, tgt.host_id as target_host_id
  from session_merge_requests r
  join sessions src on src.id = r.source_session_id
  join sessions tgt on tgt.id = r.target_session_id
`

/**
 * Every merge request that touches `sessionId`, newest first. Visible to the two proposers
 * and to organizers; the route authorizes, this function does not.
 */
export async function listMergeRequests(sessionId: string, accountId: string | null): Promise<MergeRequestView[]> {
  const rows = await sql<Parameters<typeof toView>[0][]>`
    ${REQUEST_QUERY(sql)}
    where r.source_session_id = ${sessionId} or r.target_session_id = ${sessionId}
    order by r.created_at desc
    limit 50
  `
  return rows.map((r) => toView(r, accountId))
}

export interface RequestMergeInput {
  eventId: string
  eventSlug: string
  sourceSessionId: string
  targetSessionId: string
  accountId: string
  message: string | null
}

/**
 * Ask to fold `source` into `target`. Only the source's own proposer may ask: a merger gives
 * away their audience and their slot, and nobody gives that away on someone else's behalf.
 */
export async function requestMerge(input: RequestMergeInput): Promise<MergeRequestView> {
  if (input.sourceSessionId === input.targetSessionId) {
    throw new MergeError('A session cannot be merged into itself.', 400, 'MergeRefused', 'target_session_id')
  }
  const [event] = await sql<{ status: string }[]>`select status from events where id = ${input.eventId}`
  if (!event || !MERGEABLE_EVENT_STATUSES.includes(event.status)) {
    throw new MergeError('This gathering is no longer taking changes to proposals.', 409, 'MergeClosed')
  }

  const source = await loadSession(sql, input.sourceSessionId, input.eventId)
  const target = await loadSession(sql, input.targetSessionId, input.eventId)
  if (!source || !target) throw new MergeError('Session not found', 404, 'NotFound')
  if (source.host_id !== input.accountId) {
    throw new MergeError('Only the proposer of a session can offer to merge it.', 403, 'NotProposer')
  }
  if (!target.host_id) {
    throw new MergeError('That session has no proposer to accept a merger. Ask an organizer.', 409, 'MergeRefused', 'target_session_id')
  }
  if (source.merged_into) throw new MergeError('This session has already been merged.', 409, 'AlreadyMerged')
  if (target.merged_into) throw new MergeError('That session has itself been merged into another one.', 409, 'AlreadyMerged', 'target_session_id')
  if (source.calendar_event_uri) {
    throw new MergeError('This session is already on the published schedule. Ask an organizer to cancel it first.', 409, 'MergePublished')
  }
  const [incoming] = await sql`select 1 from sessions where merged_into = ${source.id} limit 1`
  if (incoming) {
    throw new MergeError('Another session was merged into this one, so it cannot be merged away.', 409, 'MergeRefused')
  }

  const [existing] = await sql<{ id: string }[]>`
    select id from session_merge_requests
    where source_session_id = ${source.id} and status = 'pending'
  `
  if (existing) throw new MergeError('You already have a merge offer waiting for an answer.', 409, 'MergePending')

  const [row] = await sql<{ id: string }[]>`
    insert into session_merge_requests (event_id, source_session_id, target_session_id, requested_by, message)
    values (${input.eventId}, ${source.id}, ${target.id}, ${input.accountId}, ${input.message})
    returning id
  `

  await tx(async (t) => {
    const who = await proposerName(t, input.accountId)
    await notify(t, {
      eventId: input.eventId,
      userIds: await sessionPeople(t, target.id),
      type: 'proposal_needs_review',
      title: 'Someone would like to merge into your session',
      body: `${who} asks to fold “${source.title}” into “${target.title}”. Votes combine; no bonus, because votes are unlinkable.`,
      actionUrl: `/e/${input.eventSlug}/sessions/${target.id}`,
      data: { session_id: target.id, merge_request_id: row.id, source_session_id: source.id },
    })
  })

  const [view] = await sql<Parameters<typeof toView>[0][]>`${REQUEST_QUERY(sql)} where r.id = ${row.id}`
  return toView(view, input.accountId)
}

export interface DecideMergeInput {
  eventId: string
  eventSlug: string
  requestId: string
  accountId: string
  decision: MergeDecision
  reason: string | null
}

/**
 * Accept, decline or withdraw a merge offer.
 *
 * Accepting is the only thing that writes anything into `sessions`: the source gets
 * `merged_into = target` and stops taking new votes. It stays readable at its own URL (so a
 * link in a chat still lands somewhere honest) and disappears from the lists. Its author's
 * record is not touched, and no co-host row moves.
 */
export async function decideMerge(input: DecideMergeInput): Promise<MergeRequestView> {
  const result = await tx(async (t) => {
    const [request] = await t<{
      id: string; status: string; source_session_id: string; target_session_id: string
      requested_by: string | null; event_id: string
    }[]>`
      select id, status, source_session_id, target_session_id, requested_by, event_id
      from session_merge_requests where id = ${input.requestId} and event_id = ${input.eventId}
      for update
    `
    if (!request) throw new MergeError('Merge request not found', 404, 'NotFound')
    if (input.decision === 'unmerge') {
      if (request.status !== 'accepted') throw new MergeError('That merger is not in force.', 409, 'MergeDecided')
    } else if (request.status !== 'pending') {
      throw new MergeError('That merge offer has already been answered.', 409, 'MergeDecided')
    }

    const source = await loadSession(t, request.source_session_id, input.eventId)
    const target = await loadSession(t, request.target_session_id, input.eventId)
    if (!source || !target) throw new MergeError('Session not found', 404, 'NotFound')

    if (input.decision === 'withdraw') {
      if (request.requested_by !== input.accountId) {
        throw new MergeError('Only the proposer who offered the merger can withdraw it.', 403, 'NotProposer')
      }
    } else if (input.decision === 'unmerge') {
      // Undoing a merger needs one of the two proposers: either may change their mind.
      if (source.host_id !== input.accountId && target.host_id !== input.accountId) {
        throw new MergeError('Only one of the two proposers can undo a merger.', 403, 'NotProposer')
      }
    } else if (target.host_id !== input.accountId) {
      throw new MergeError('Only the proposer of the other session can answer a merge offer.', 403, 'NotProposer')
    }

    const status: MergeStatus = input.decision === 'accept' ? 'accepted' : input.decision === 'decline' ? 'declined' : 'withdrawn'
    await t`
      update session_merge_requests
      set status = ${status}, decided_by = ${input.accountId}, decided_at = now(),
          decline_reason = ${input.decision === 'decline' ? input.reason : null}
      where id = ${request.id}
    `

    if (input.decision === 'accept') {
      // Everything checked when the offer was made is checked again here, under the row lock:
      // an offer can sit for days, and in that time the source can reach the published
      // schedule or the gathering can move past the phase where proposals may be rearranged.
      // Accepting either of those would orphan a published calendar event or rewrite a
      // finished programme.
      if (source.merged_into) throw new MergeError('This session has already been merged.', 409, 'AlreadyMerged')
      if (target.merged_into) throw new MergeError('That session has itself been merged into another one.', 409, 'AlreadyMerged')
      if (source.calendar_event_uri) {
        throw new MergeError('That session reached the published schedule while this offer was waiting. Ask an organizer to cancel it first.', 409, 'MergePublished')
      }
      const [event] = await t<{ status: string }[]>`select status from events where id = ${input.eventId}`
      if (!event || !MERGEABLE_EVENT_STATUSES.includes(event.status)) {
        throw new MergeError('This gathering is no longer taking changes to proposals.', 409, 'MergeClosed')
      }
      // Service-side: `merged_into` is organizer-only to the session guard (migration 0031),
      // and the target's proposer is not an organizer of the source.
      await t`
        update sessions
        set merged_into = ${target.id}, is_votable = false, venue_id = null, time_slot_id = null
        where id = ${source.id}
      `
      // Every other pending offer on either session is moot.
      await t`
        update session_merge_requests
        set status = 'withdrawn', decided_at = now()
        where status = 'pending' and id <> ${request.id}
          and (source_session_id in (${source.id}, ${target.id}) or target_session_id = ${source.id})
      `
    }

    if (input.decision === 'unmerge') {
      if (source.merged_into !== target.id) throw new MergeError('That merger is not in force.', 409, 'MergeDecided')
      // `unmergeSession` is the only way `merged_into` is ever cleared: it restores
      // `is_votable` in the same statement, so the proposal never sits visible-but-unvotable.
      const undone = await unmergeSession(t, source.id)
      if (!undone) throw new MergeError('That merger is not in force.', 409, 'MergeDecided')
    }

    const decider = await proposerName(t, input.accountId)
    const other = input.decision === 'withdraw' ? target.id : source.id
    const recipients = (await sessionPeople(t, input.decision === 'unmerge' ? source.id : other))
      .concat(input.decision === 'unmerge' ? await sessionPeople(t, target.id) : [])
      .filter((id) => id !== input.accountId)
    const copy = {
      accept: {
        title: 'Your merge offer was accepted',
        body: `“${source.title}” is now part of “${target.title}”. Votes combine; no bonus, because votes are unlinkable.`,
      },
      decline: {
        title: 'Your merge offer was declined',
        body: `${decider} would rather keep “${target.title}” separate.${input.reason ? ` They said: ${input.reason}` : ''}`,
      },
      withdraw: {
        title: 'A merge offer was withdrawn',
        body: `${decider} withdrew the offer to fold “${source.title}” into “${target.title}”.`,
      },
      unmerge: {
        title: 'A merger was undone',
        body: `${decider} separated “${source.title}” from “${target.title}”. It is back in the lists and takes votes again.`,
      },
    }[input.decision]
    await notify(t, {
      eventId: input.eventId,
      userIds: recipients,
      type: 'proposal_needs_review',
      title: copy.title,
      body: copy.body,
      actionUrl: `/e/${input.eventSlug}/sessions/${other}`,
      data: { session_id: other, merge_request_id: request.id },
    })
    return request.id
  })

  const [view] = await sql<Parameters<typeof toView>[0][]>`${REQUEST_QUERY(sql)} where r.id = ${result}`
  return toView(view, input.accountId)
}

/**
 * Sessions folded into `sessionId` by an accepted merger. Anything that would remove a session
 * has to ask first: `sessions.merged_into` is ON DELETE RESTRICT precisely so that a target
 * cannot vanish and silently un-merge its sources (migration 0031).
 */
export async function mergedSources(sessionId: string, db: Sql = sql): Promise<Array<{ id: string; title: string }>> {
  return db<{ id: string; title: string }[]>`
    select id, title from sessions where merged_into = ${sessionId} order by title
  `
}

/**
 * Undo an accepted merger. The source becomes an ordinary proposal again — and `is_votable`
 * goes back to true in the same statement, because a session that is visible but unvotable
 * has its votes dropped at close with nobody told. Every path that clears `merged_into` goes
 * through here.
 */
export async function unmergeSession(
  db: Sql,
  sessionId: string,
): Promise<{ id: string; merged_into: string } | null> {
  const [row] = await db<{ id: string; merged_into: string }[]>`
    update sessions set merged_into = null, is_votable = true
    where id = ${sessionId} and merged_into is not null
    returning id, merged_into
  `
  return row ?? null
}

/** The session's host plus its accepted co-hosts: who should hear about it. */
async function sessionPeople(db: Sql, sessionId: string): Promise<string[]> {
  const rows = await db<{ user_id: string }[]>`
    select host_id as user_id from sessions where id = ${sessionId} and host_id is not null
    union
    select user_id from session_cohosts where session_id = ${sessionId} and cohost_inactive_at is null
  `
  return rows.map((r) => r.user_id)
}

async function proposerName(db: Sql, accountId: string): Promise<string> {
  const [row] = await db<{ display_name: string | null }[]>`select display_name from profiles where id = ${accountId}`
  return row?.display_name?.trim() || 'A proposer'
}
