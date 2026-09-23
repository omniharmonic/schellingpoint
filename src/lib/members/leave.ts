import 'server-only'
/**
 * Leaving a gathering (spec §8 "Leaving and ending").
 *
 * One function serves both doors, because the consequences must be identical whichever side
 * asks: a person leaving from their own settings, and an organizer removing someone from the
 * moderation queue. What happens:
 *
 *   membership          deleted — the roster is the gathering's, and they are no longer on it
 *   RSVPs               cancelled, so the seat goes back to the room and the waitlist moves up;
 *                       an opt-in *public* RSVP record in their own repo is retracted too
 *   co-host invites     the pending ones they sent are revoked: naming an invited person before
 *                       they accept is the thing double opt-in exists to prevent (spec §9), and
 *                       an invite from someone who has left names them for nothing
 *   proposals           KEPT. A proposal is the proposer's own record in their own repo and the
 *                       gathering has no authority over it (spec §8). They are marked
 *                       `author_left_at` so organizers can see nobody is answering for them.
 *   ballot entries      UNTOUCHED, and deliberately so. After a round closes an entry is a
 *                       ballot token with no author; there is nothing left to remove, and
 *                       "delete my votes" cannot be honoured without re-linking them first.
 *   role claim          re-synced: a published claim that no longer holds is retracted.
 *
 * The last owner may never leave: a gathering with no owner cannot be administered, and the
 * caller is told to hand the gathering over first.
 *
 * The database work and the network work are separate on purpose. `leaveGatheringIn` does the
 * database half inside the caller's transaction, so a caller that is already in one (the
 * moderation queue resolving a report) commits the departure and its decision together instead
 * of half-committing one of them. `retractAfterLeave` does the network half, and must run
 * *after* that commit — it talks to a PDS, which can be slow or down, and a transaction held
 * open across a network call is a lock held open across a network call.
 */
import { sql, tx, type Sql } from '@/lib/db'
import type { EventRoleName } from '@/types/event'

export type LeaveFailure = 'not-a-member' | 'last-owner'

export interface LeaveOutcome {
  ok: true
  role: EventRoleName
  /** Counts only — never identifiers. Safe to show the person and to log. */
  rsvpsCancelled: number
  cohostInvitesRevoked: number
  proposalsKept: number
  /** Public RSVP records this account had written; retraction is attempted after the commit. */
  publicRsvpUris: string[]
}

export type LeaveResult = LeaveOutcome | { ok: false; reason: LeaveFailure }

/**
 * The database half of leaving, inside `t`. Locks the gathering's owner rows with the target
 * so two concurrent departures cannot both pass the last-owner check.
 *
 * On success the caller MUST call `retractAfterLeave` once `t` has committed.
 */
export async function leaveGatheringIn(t: Sql, eventId: string, accountId: string): Promise<LeaveResult> {
  const locked = await t<{ user_id: string; role: EventRoleName }[]>`
    select user_id, role from event_members
    where event_id = ${eventId} and (role = 'owner' or user_id = ${accountId})
    order by user_id
    for update
  `
  const mine = locked.find((m) => m.user_id === accountId)
  if (!mine) return { ok: false, reason: 'not-a-member' }
  if (mine.role === 'owner' && locked.filter((m) => m.role === 'owner').length <= 1) {
    return { ok: false, reason: 'last-owner' }
  }

  const cancelled = await t<{ rsvp_uri: string | null }[]>`
    update session_rsvps set status = 'cancelled', waitlist_position = null, updated_at = now()
    where event_id = ${eventId} and user_id = ${accountId} and status <> 'cancelled'
    returning rsvp_uri
  `
  const revoked = await t`
    update cohost_invites set status = 'revoked'
    where event_id = ${eventId} and created_by = ${accountId} and status = 'pending'
  `
  const kept = await t`
    update sessions set author_left_at = now()
    where event_id = ${eventId} and host_id = ${accountId} and author_left_at is null
  `
  await t`delete from event_members where event_id = ${eventId} and user_id = ${accountId}`

  return {
    ok: true,
    role: mine.role,
    rsvpsCancelled: cancelled.length,
    cohostInvitesRevoked: revoked.count,
    proposalsKept: kept.count,
    publicRsvpUris: cancelled.map((r) => r.rsvp_uri).filter((u): u is string => typeof u === 'string' && u.length > 0),
  }
}

/**
 * Remove `accountId` from `eventId` in a transaction of its own, then retract what they had
 * published about this gathering. The door a person uses on themselves.
 */
export async function leaveGathering(eventId: string, accountId: string): Promise<LeaveResult> {
  const outcome = await tx<LeaveResult>((t) => leaveGatheringIn(t, eventId, accountId))
  if (!outcome.ok) return outcome
  await retractAfterLeave(eventId, accountId, outcome.publicRsvpUris)
  return outcome
}

/**
 * After the commit: retract what the departing person had published about this gathering.
 * Every step is best-effort and logged without identifiers — a network failure must not undo
 * a departure that has already happened.
 */
export async function retractAfterLeave(eventId: string, accountId: string, rsvpUris: string[]): Promise<void> {
  if (rsvpUris.length) {
    try {
      const { retractPublicRsvp } = await import('@/lib/atproto/participant')
      const rows = await sql<{ session_id: string }[]>`
        select session_id from session_rsvps
        where event_id = ${eventId} and user_id = ${accountId} and rsvp_uri is not null
      `
      for (const row of rows) {
        await retractPublicRsvp({ sessionId: row.session_id, userId: accountId }).catch(() => undefined)
      }
      await sql`update session_rsvps set rsvp_uri = null where event_id = ${eventId} and user_id = ${accountId}`
    } catch (e) {
      console.warn('[leave] public RSVP retraction failed:', e instanceof Error ? e.name : 'error')
    }
  }
  try {
    const [claim] = await sql`select 1 from role_claims where event_id = ${eventId} and account_id = ${accountId}`
    if (claim) {
      const { syncRoleClaim } = await import('@/lib/atproto/role-claims')
      await syncRoleClaim(eventId, accountId)
    }
  } catch (e) {
    console.warn('[leave] role claim re-sync failed:', e instanceof Error ? e.name : 'error')
  }
}
