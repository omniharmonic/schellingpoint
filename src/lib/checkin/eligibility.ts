import 'server-only'
/**
 * "Only checked-in people can vote during the event" (MT §12.14).
 *
 * A gathering may require that a person has actually been checked in at the door before their
 * attendance-round votes count. It is off by default, and it applies to the **attendance**
 * round only: pre-event voting happens before anyone is at the door, so gating it would close
 * the poll to everyone.
 *
 * This lives outside `src/lib/voting` on purpose. The voting library owns eligibility; this is
 * one additive predicate it can consult, so the two can be changed independently and the check
 * can be tested without a round.
 *
 * Call site for the voting library (one line, inside `checkEligibility` for `phase ===
 * 'attendance'`, after the membership and ticket checks have passed):
 *
 *     const gate = await checkinGate(db, eventId, accountId)
 *     if (!gate.eligible) return { eligible: false, code: gate.code, reason: gate.reason, override }
 */
import type { Sql } from '@/lib/db'

export interface CheckinGateResult {
  eligible: boolean
  /** Set only when `eligible` is false. Mirrors the shape the voting library returns. */
  code?: 'CheckinRequired'
  /** Written for the participant, not for a log. */
  reason?: string
}

const PASS: CheckinGateResult = { eligible: true }

/**
 * Whether `accountId` may vote in `eventId`'s attendance round under the gathering's check-in
 * rule. Passes when the gathering does not use the rule at all.
 *
 * "Checked in" means a ticket of theirs for this gathering is in the `checked_in` status, or
 * carries a `checked_in_at` stamp — check-in times are reduced to counts at 90 days
 * (retention, spec §9) while the status stays, so both have to count.
 */
export async function checkinGate(db: Sql, eventId: string, accountId: string): Promise<CheckinGateResult> {
  const [row] = await db<{ gated: boolean; checked_in: boolean }[]>`
    select coalesce(e.checkin_gates_voting, false) as gated,
           exists (
             select 1 from tickets t
             where t.event_id = e.id and t.user_id = ${accountId}
               and (t.status = 'checked_in' or t.checked_in_at is not null)
           ) as checked_in
    from events e
    where e.id = ${eventId}
  `
  if (!row || !row.gated || row.checked_in) return PASS
  return {
    eligible: false,
    code: 'CheckinRequired',
    reason: 'Check in at the door to vote while the gathering is running.',
  }
}

/** Whether the gathering requires check-in before attendance voting (for read models and UI copy). */
export async function checkinGatesVoting(db: Sql, eventId: string): Promise<boolean> {
  const [row] = await db<{ gated: boolean }[]>`
    select coalesce(checkin_gates_voting, false) as gated from events where id = ${eventId}
  `
  return row?.gated ?? false
}
