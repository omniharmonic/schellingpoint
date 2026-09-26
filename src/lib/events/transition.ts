import 'server-only'
import type postgres from 'postgres'
import { formatInEventTimezone } from './timezone'
import { notify } from '@/lib/notifications'
import { ATTENDANCE_MARK, claimMark } from '@/lib/notifications/marks'
import { openRound } from '@/lib/voting/rounds'
import { openAttendanceRound } from '@/lib/voting/attendance'
import type { EventStatus } from '@/types/event'

/**
 * The side effects of a lifecycle phase change, in one place.
 *
 * Two callers move a gathering between phases: an organizer through
 * `PATCH /api/events/[eventId]/settings`, and the scheduler through
 * `GET /api/jobs/lifecycle` when the organizer asked for automatic transitions
 * (`events.auto_lifecycle`). They must behave identically — the same rounds opened, the
 * same notifications written, the same feed posts queued — so both go through here
 * rather than each keeping their own copy (inventory P1-6, P2-3, P2-17).
 *
 * `transitionSideEffects` runs INSIDE the transaction that wrote the new status, so a
 * rolled-back transition leaves no notification and no open round behind.
 * `queueTransitionFeedPost` runs after that transaction commits.
 */

export interface TransitionEvent {
  id: string
  slug: string
  name: string
  timezone: string
  voting_closes_at: string | null
}

/** Every member of a gathering, as notification recipients. */
export async function eventMemberIds(t: postgres.TransactionSql, eventId: string): Promise<string[]> {
  const rows = await t<{ user_id: string }[]>`select user_id from event_members where event_id = ${eventId}`
  return rows.map((r) => r.user_id)
}

export interface TransitionOptions {
  /** The event row as it now stands (after the status update). */
  row: TransitionEvent
  /** Status before the update; equal to `to` when only `attendanceToggledOn` changed. */
  from: EventStatus
  to: EventStatus
  /**
   * The organizer switched attendance voting on while the gathering was already live.
   * Opens the round without announcing it a second time.
   */
  attendanceToggledOn?: boolean
}

/**
 * Opens the round a phase implies and writes the notifications members are owed.
 * Returns how many notification rows were written.
 */
export async function transitionSideEffects(
  t: postgres.TransactionSql,
  { row, from, to, attendanceToggledOn = false }: TransitionOptions,
): Promise<number> {
  const statusChanged = from !== to
  let notified = 0

  if (statusChanged && to === 'published') {
    // Members (so far: the organizing team, and anyone invited early) hear that the
    // gathering is visible. A feed post reaches Bluesky followers, not members.
    notified += await notify(t, {
      eventId: row.id,
      userIds: await eventMemberIds(t, row.id),
      type: 'event_published',
      title: `${row.name} is published`,
      body: 'The gathering page is live. Share it with the people you would like to see there.',
      actionUrl: `/e/${row.slug}`,
      data: {},
    })
  }

  if (statusChanged && to === 'proposals_open') {
    notified += await notify(t, {
      eventId: row.id,
      userIds: await eventMemberIds(t, row.id),
      type: 'proposals_open',
      title: `Proposals are open for ${row.name}`,
      body: 'Propose the session you want to run, or read what other people have proposed.',
      actionUrl: `/e/${row.slug}/propose`,
      data: {},
    })
  }

  if (statusChanged && to === 'voting_open') {
    await openRound(row.id, {}, t)
    const votingEndsAt = row.voting_closes_at
      ? formatInEventTimezone(new Date(row.voting_closes_at), row.timezone, 'full')
      : null
    notified += await notify(t, {
      eventId: row.id,
      userIds: await eventMemberIds(t, row.id),
      type: 'voting_opened',
      title: `Voting is open for ${row.name}`,
      body: votingEndsAt
        ? `Spend your credits on the sessions you want to see. Voting closes ${votingEndsAt}.`
        : 'Spend your credits on the sessions you want to see.',
      actionUrl: `/e/${row.slug}/sessions`,
      data: { voting_ends_at: votingEndsAt },
    })
  } else if (statusChanged && from === 'voting_open') {
    notified += await notify(t, {
      eventId: row.id,
      userIds: await eventMemberIds(t, row.id),
      type: 'voting_closed',
      title: `Voting has closed for ${row.name}`,
      body: 'Thanks for shaping the program. The organizers are putting the schedule together.',
      actionUrl: `/e/${row.slug}`,
      data: {},
    })
  }

  // Attendance voting (design §11) opens when the gathering goes live, or when an organizer
  // switches it on while already live. `openAttendanceRound` opens nothing when it is off.
  if (to === 'live' && (statusChanged || attendanceToggledOn)) {
    const attendanceRound = await openAttendanceRound(t, row.id)
    // Members hear about it once per gathering, whoever opened it. The mark is claimed in
    // THIS transaction and is the same one the lifecycle job claims, so a gathering the job
    // moves to `live` is not announced twice in the same tick.
    if (
      attendanceRound &&
      attendanceRound.status === 'open' &&
      statusChanged &&
      (await claimMark(t, row.id, ATTENDANCE_MARK.kind, ATTENDANCE_MARK.mark))
    ) {
      notified += await notify(t, {
        eventId: row.id,
        userIds: await eventMemberIds(t, row.id),
        type: 'voting_opened',
        title: `Attendance voting is open for ${row.name}`,
        body: `You have ${attendanceRound.credits} fresh credits. Vote for a session while you are in it, from My schedule or the session page.`,
        actionUrl: `/e/${row.slug}/schedule?view=mine`,
        data: { round: 'attendance', closes_at: attendanceRound.closesAt },
      })
    }
  }

  return notified
}

/**
 * Feed (design §7.3): a lifecycle transition claims its one post. `feed.ts` re-checks its own
 * gates (`feed_posts`, an actor, public, not draft), so this is safe to call unconditionally.
 * Returns true when a post was claimed and delivery is worth kicking.
 */
export async function queueTransitionFeedPost(
  eventId: string,
  to: EventStatus,
  callerUserId: string | null,
): Promise<boolean> {
  if (to !== 'proposals_open' && to !== 'voting_open') return false
  const kind = to === 'proposals_open' ? 'proposals-open' : 'voting-open'
  try {
    const feed = await import('@/lib/atproto/feed')
    const claimed = await feed.enqueueGatheringPost({ eventId, kind, callerUserId })
    return Boolean(claimed.queued)
  } catch (e) {
    console.warn('[transition] feed post could not be queued:', e instanceof Error ? e.name : 'error')
    return false
  }
}
