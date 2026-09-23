import 'server-only'
/**
 * Organizer controls over a voting round (inventory 5.10 / P2-14).
 *
 * Until now a round opened only as a side effect of the lifecycle transition into
 * `voting_open` and closed only when `closes_at` passed (cron, or the lazy sweep). Scheduling
 * was therefore hostage to a timestamp. These three actions give an organizer the handle:
 *
 *   openRoundNow    open (or re-window) the phase's round through `openRound`
 *   extendRound     move `closes_at` later — never earlier: shortening a round by stealth is
 *                   how you close voting on a result you have already peeked at, and nobody
 *                   can peek anyway (spec §5.3). To end early, close.
 *   forceCloseRound run exactly the job's path, `closeRound`, right now
 *
 * **The ballot-key invariants are untouched.** Nothing here reads a count, nothing here
 * touches `ballot_key`, `credit_ledger`, `vote_ballots` or `vote_entries`, and the close is
 * the same one transaction the sweep runs: token = hmac(key, account), randomized explode,
 * ledger deleted, key NULLed. An organizer can decide *when* a round ends; they still learn
 * nothing about it until it has.
 *
 * Every action writes a `round_actions` row (migration 0031): who, when, which round, and the
 * window that changed. Never a count.
 */
import { sql, tx } from '@/lib/db'
import type postgres from 'postgres'
import { VotingError } from './errors'
import type { RoundPhase } from './mechanism'
import {
  closeRound,
  getRound,
  isUuid,
  KEEP_OPEN_STATUSES,
  openRound,
  roundState,
  toRoundInfo,
  type CloseRoundResult,
  type RoundInfo,
  type RoundRow,
} from './rounds'
import { attendanceClosesAt } from './attendance'

export type RoundAction = 'open' | 'extend' | 'close'

export interface RoundActionRow {
  id: string
  roundId: string | null
  phase: RoundPhase
  action: RoundAction
  /** The organizer's display name, or null when the account is gone. Never a DID or an email. */
  actor: string | null
  detail: Record<string, unknown>
  createdAt: string
}

/** Audit one control action. Runs inside the caller's transaction when one is given. */
export async function recordRoundAction(
  db: postgres.TransactionSql | typeof sql,
  input: { eventId: string; roundId: string | null; phase: RoundPhase; action: RoundAction; actorId: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  await db`
    insert into round_actions (event_id, round_id, phase, action, actor_id, detail)
    values (${input.eventId}, ${input.roundId}, ${input.phase}, ${input.action}, ${input.actorId},
            ${sql.json((input.detail ?? {}) as Parameters<typeof sql.json>[0])})
  `
}

/** The gathering's control history, newest first. Organizer-only; counts never appear. */
export async function listRoundActions(eventId: string, limit = 25): Promise<RoundActionRow[]> {
  const rows = await sql<{
    id: string; round_id: string | null; phase: string; action: string
    actor: string | null; detail: Record<string, unknown>; created_at: string
  }[]>`
    select a.id, a.round_id, a.phase, a.action, p.display_name as actor, a.detail, a.created_at
    from round_actions a
    left join profiles p on p.id = a.actor_id
    where a.event_id = ${eventId}
    order by a.created_at desc
    limit ${Math.min(Math.max(1, Math.floor(limit)), 100)}
  `
  return rows.map((r) => ({
    id: r.id,
    roundId: r.round_id,
    phase: r.phase as RoundPhase,
    action: r.action as RoundAction,
    actor: r.actor,
    detail: r.detail ?? {},
    createdAt: r.created_at,
  }))
}

interface EventWindow {
  id: string
  status: string
  end_date: string
  timezone: string
  attendance_credits: number | null
  attendance_voting_enabled: boolean | null
}

async function loadEvent(eventId: string): Promise<EventWindow> {
  const [event] = await sql<EventWindow[]>`
    select id, status, end_date::text as end_date, timezone, attendance_credits, attendance_voting_enabled
    from events where id = ${eventId}
  `
  if (!event) throw new VotingError('Event not found', 404, 'NotFound')
  return event
}

/**
 * A round that stays open only while the gathering is in a phase that keeps it open: opening
 * one outside that window would be closed again by the very next sweep, which reads as the
 * button not working. Say so instead.
 */
function assertPhaseAllows(event: EventWindow, phase: RoundPhase): void {
  const allowed = KEEP_OPEN_STATUSES[phase]
  if (allowed.includes(event.status)) return
  throw new VotingError(
    phase === 'attendance'
      ? 'An attendance round runs only while the gathering is live. Set the gathering live first.'
      : `Voting rounds stay open only while the gathering is in ${allowed.join(' or ')}. Move the gathering into that phase first.`,
    409,
    'WrongPhase',
    'status',
  )
}

export interface OpenNowInput {
  eventId: string
  phase: RoundPhase
  actorId: string
  closesAt?: Date | string | null
  credits?: number
  mechanism?: 'quadratic' | 'linear' | 'approval'
}

/** Open the phase's round now (idempotent per (event, phase) — see `openRound`). */
export async function openRoundNow(input: OpenNowInput): Promise<RoundInfo> {
  const event = await loadEvent(input.eventId)
  assertPhaseAllows(event, input.phase)
  if (input.phase === 'attendance' && !event.attendance_voting_enabled) {
    throw new VotingError('Switch attendance voting on in Voting settings first.', 409, 'InvalidRound', 'attendance_voting_enabled')
  }
  const now = new Date()
  // "Now" is stamped a minute back: the round's status is decided against the DATABASE clock,
  // and an `opens_at` a few milliseconds ahead of it would read as 'upcoming' rather than open.
  const opensAt = new Date(now.getTime() - 60_000)
  const closesAt = input.closesAt
    ?? (input.phase === 'attendance' ? attendanceClosesAt(event.end_date, event.timezone, now) : undefined)
  return tx(async (t) => {
    const round = await openRound(
      input.eventId,
      {
        phase: input.phase,
        opensAt,
        ...(closesAt ? { closesAt } : {}),
        ...(input.credits !== undefined ? { credits: input.credits } : input.phase === 'attendance' && event.attendance_credits ? { credits: event.attendance_credits } : {}),
        ...(input.mechanism ? { mechanism: input.mechanism } : {}),
      },
      t,
    )
    await recordRoundAction(t, {
      eventId: input.eventId,
      roundId: round.id,
      phase: input.phase,
      action: 'open',
      actorId: input.actorId,
      detail: { opensAt: round.opensAt, closesAt: round.closesAt, credits: round.credits, mechanism: round.mechanism },
    })
    return round
  })
}

export interface ExtendInput {
  eventId: string
  phase: RoundPhase
  actorId: string
  closesAt: Date | string
}

/**
 * Move an open round's `closes_at` later. Refuses to shorten it and refuses a closed round.
 *
 * This writes `closes_at` and nothing else. It deliberately does NOT go through `openRound`:
 * that function re-derives mechanism, credits and `opens_at` from the event when no ballot has
 * been cast yet — which would reset an attendance round's credits to the pre-event budget and
 * could push `opens_at` forward to a future `voting_opens_at`, closing voting while claiming to
 * have extended it. Worse, its two branches differ only on whether anyone has voted, so the
 * round it hands back would tell an organizer whether a ballot exists in an open round. Spec
 * §5.3 step 3: no fact about an open round's participation leaves the database.
 */
export async function extendRound(input: ExtendInput): Promise<RoundInfo> {
  const state = await roundState(input.eventId, input.phase)
  const current = state.round
  if (!current || state.status === 'closed') {
    throw new VotingError('There is no open round of this kind to extend.', 409, 'NoRound', 'round')
  }
  const next = input.closesAt instanceof Date ? input.closesAt : new Date(input.closesAt)
  if (Number.isNaN(next.getTime())) throw new VotingError('closesAt is not a valid date', 400, 'InvalidRound', 'closesAt')
  if (next.getTime() <= Date.now()) throw new VotingError('Voting must close in the future', 400, 'InvalidRound', 'closesAt')
  if (next.getTime() <= new Date(current.closesAt).getTime()) {
    throw new VotingError('A new closing time must be later than the current one. To end voting early, close the round.', 400, 'InvalidRound', 'closesAt')
  }
  return tx(async (t) => {
    const [row] = await t<RoundRow[]>`
      update vote_rounds r set closes_at = ${next}
      where r.id = ${current.id} and r.event_id = ${input.eventId} and r.finalized_at is null
      returning r.id, r.event_id, r.phase, r.mechanism, r.credits, r.opens_at, r.closes_at, r.finalized_at
    `
    if (!row) throw new VotingError('That round closed while you were extending it.', 409, 'RoundClosed', 'round')
    const round = toRoundInfo(row)
    await recordRoundAction(t, {
      eventId: input.eventId,
      roundId: round.id,
      phase: input.phase,
      action: 'extend',
      actorId: input.actorId,
      detail: { from: current.closesAt, to: round.closesAt },
    })
    return round
  })
}

export interface ForceCloseInput {
  eventId: string
  phase: RoundPhase
  actorId: string
  roundId?: string
}

/**
 * Close the phase's open round now, through the job's own `closeRound` — the audit row is
 * written after the close commits, so a failed close leaves no claim that one happened.
 */
export async function forceCloseRound(input: ForceCloseInput): Promise<{ round: RoundInfo; result: CloseRoundResult }> {
  const target = input.roundId && isUuid(input.roundId)
    ? await getRound(input.eventId, input.roundId)
    : (await roundState(input.eventId, input.phase)).round
  if (!target) throw new VotingError('There is no round of this kind to close.', 409, 'NoRound', 'round')
  if (target.status === 'closed') {
    throw new VotingError('That round is already closed.', 409, 'RoundClosed', 'round')
  }
  const result = await closeRound(target.id, { publish: 'await' })
  await recordRoundAction(sql, {
    eventId: input.eventId,
    roundId: target.id,
    phase: target.phase,
    action: 'close',
    actorId: input.actorId,
    detail: { closedEarly: new Date(target.closesAt).getTime() > Date.now(), scheduledClose: target.closesAt },
  })
  const closed = await getRound(input.eventId, target.id)
  return { round: closed ?? { ...target, status: 'closed' }, result }
}
