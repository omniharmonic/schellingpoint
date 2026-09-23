import 'server-only'
/**
 * A participant's allocation while a round is open (spec §5.3 step 2): mutable and
 * author-linked, held in `credit_ledger`, with the budget enforced here on every write.
 *
 * `setAllocation` is one transaction:
 *   round    FOR SHARE on the open round (so `closeRound` cannot run underneath it)
 *   ledger   INSERT … ON CONFLICT DO NOTHING, then SELECT … FOR UPDATE on the voter's
 *            ledger row, so two concurrent writes by one voter are serialized and the
 *            second sees the first's spend
 *   checks   window + event status, eligibility, session votable, mechanism, budget
 */
import { sql, tx, type Sql } from '@/lib/db'
import type postgres from 'postgres'
import { VotingError } from './errors'
import {
  allocationCost,
  isValidVoteCount,
  maxVotesFor,
  type RoundPhase,
  type VotingMechanism,
} from './mechanism'
import { isHappeningNow } from './attendance'
import { checkinGate } from '@/lib/checkin/eligibility'
import { isUuid, roundState, toRoundInfo, WRITABLE_STATUS, type RoundInfo, type RoundStatus } from './rounds'

export interface Eligibility {
  eligible: boolean
  code?: 'NotMember' | 'TicketRequired' | 'CheckinRequired'
  reason?: string
  /** The member's credit override (event_members.vote_credits, else a voting ticket tier's), if any. */
  override: number | null
}

export interface AllocationView {
  round: RoundInfo | null
  status: RoundStatus
  mechanism: VotingMechanism | null
  /** session id → votes; empty once the round is closed (the ledger is gone). */
  allocation: Record<string, number>
  spent: number
  budget: number
  remaining: number
  eligibility: Eligibility
  /** True while allocations are accepted: round open, event in its voting status, voter eligible. */
  canVote: boolean
  /** Why `canVote` is false, written for the participant. */
  reason: string | null
  /** True once the round is finalized: the voter's own allocation no longer exists anywhere. */
  sealed: boolean
}

interface LockedRound {
  id: string
  event_id: string
  phase: string
  mechanism: string
  credits: number
  opens_at: string
  closes_at: string
  finalized_at: string | null
  event_status: string
  now: string
}

/**
 * Eligibility (spec §5.5): an event member; for a ticketed event, a confirmed ticket in a voting tier.
 * In the attendance round a gathering may additionally require that the voter has been checked in
 * at the door (MT §12.14) — a no-op unless `events.checkin_gates_voting` is on.
 */
export async function checkEligibility(
  db: Sql,
  eventId: string,
  accountId: string,
  phase: RoundPhase = 'pre-event',
): Promise<Eligibility> {
  const [row] = await db<{
    role: string | null
    member_credits: number | null
    gated: boolean
    has_ticket: boolean
    tier_credits: number | null
  }[]>`
    select m.role,
           m.vote_credits as member_credits,
           e.ticketing_enabled as gated,
           exists (
             select 1 from tickets k join ticket_tiers tt on tt.id = k.tier_id
             where k.event_id = e.id and k.user_id = ${accountId}
               and k.status in ('confirmed', 'checked_in') and tt.allows_voting
           ) as has_ticket,
           (
             select max(tt.vote_credits_override) from tickets k join ticket_tiers tt on tt.id = k.tier_id
             where k.event_id = e.id and k.user_id = ${accountId}
               and k.status in ('confirmed', 'checked_in') and tt.allows_voting
           ) as tier_credits
    from events e
    left join event_members m on m.event_id = e.id and m.user_id = ${accountId}
    where e.id = ${eventId}
  `
  if (!row || !row.role) {
    return { eligible: false, code: 'NotMember', reason: 'Join this gathering to vote.', override: null }
  }
  const override = row.member_credits ?? row.tier_credits ?? null
  if (row.gated && !row.has_ticket) {
    return {
      eligible: false,
      code: 'TicketRequired',
      reason: 'Voting at this gathering needs a confirmed ticket that includes voting.',
      override,
    }
  }
  if (phase === 'attendance') {
    const gate = await checkinGate(db, eventId, accountId)
    if (!gate.eligible) return { eligible: false, code: gate.code!, reason: gate.reason!, override }
  }
  return { eligible: true, override }
}

function positiveOrNull(n: number | null): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

/** Only the keys of an allocation that name sessions still in the event, as integers > 0. */
async function pruneAllocation(db: Sql, eventId: string, allocated: unknown): Promise<Record<string, number>> {
  const source = allocated && typeof allocated === 'object' && !Array.isArray(allocated) ? (allocated as Record<string, unknown>) : {}
  const ids = Object.keys(source).filter(isUuid)
  if (ids.length === 0) return {}
  const present = await db<{ id: string }[]>`select id from sessions where event_id = ${eventId} and id in ${db(ids)}`
  const keep = new Set(present.map((r) => r.id))
  const out: Record<string, number> = {}
  for (const id of ids) {
    const v = source[id]
    if (keep.has(id) && typeof v === 'number' && Number.isInteger(v) && v > 0) out[id] = v
  }
  return out
}

function explainNotOpen(round: RoundInfo | null, status: RoundStatus, eventStatus: string | null, phase: RoundPhase = 'pre-event'): string {
  const what = phase === 'attendance' ? 'Attendance voting' : 'Voting'
  if (!round || status === 'none') {
    return phase === 'attendance' ? 'Attendance voting opens when the gathering is live.' : 'Voting has not opened for this gathering.'
  }
  if (status === 'closed') return `${what} has closed. Ballots are sealed.`
  if (status === 'upcoming') return `${what} opens ${new Date(round.opensAt).toUTCString()}.`
  if (eventStatus !== WRITABLE_STATUS[round.phase]) return `${what} is paused right now.`
  return `${what} is not open right now.`
}

/**
 * The budget a voter has in a round. Pre-event rounds honour the member's or ticket tier's
 * override; the attendance round is the same fresh amount for everyone (PRD §2.3).
 */
function budgetFor(phase: RoundPhase, roundCredits: number, override: number | null): number {
  return phase === 'attendance' ? roundCredits : (positiveOrNull(override) ?? roundCredits)
}

/** The viewer's own allocation and budget for the event's current round of `phase`. */
export async function getAllocation(eventId: string, accountId: string, phase: RoundPhase = 'pre-event'): Promise<AllocationView> {
  const state = await roundState(eventId, phase)
  const [eventRow] = await sql<{ status: string; vote_credits_per_user: number | null; attendance_credits: number | null }[]>`
    select status, vote_credits_per_user, attendance_credits from events where id = ${eventId}
  `
  const eligibility = await checkEligibility(sql, eventId, accountId, phase)
  const round = state.round
  const baseCredits = round?.credits ?? (phase === 'attendance' ? eventRow?.attendance_credits : eventRow?.vote_credits_per_user) ?? 0
  const budget = budgetFor(phase, baseCredits, eligibility.override)

  let allocation: Record<string, number> = {}
  if (round && round.status !== 'closed') {
    const [ledger] = await sql<{ allocated: unknown }[]>`
      select allocated from credit_ledger where round_id = ${round.id} and account_id = ${accountId}
    `
    allocation = await pruneAllocation(sql, eventId, ledger?.allocated)
  }
  const spent = round ? allocationCost(allocation, round.mechanism) : 0
  const writable = !!round && state.status === 'open' && eventRow?.status === WRITABLE_STATUS[round.phase]
  const canVote = writable && eligibility.eligible
  const reason = !writable
    ? explainNotOpen(round, state.status, eventRow?.status ?? null, phase)
    : eligibility.eligible ? null : (eligibility.reason ?? 'You cannot vote in this gathering.')

  return {
    round,
    status: state.status,
    mechanism: round?.mechanism ?? null,
    allocation,
    spent,
    budget,
    remaining: Math.max(0, budget - spent),
    eligibility,
    canVote,
    reason,
    sealed: state.status === 'closed',
  }
}

/**
 * Set the viewer's votes for one session in the event's open round. `votes = 0` removes
 * the entry. Throws `VotingError` (400/403/404/409) with a participant-facing message.
 */
export async function setAllocation(
  eventId: string,
  accountId: string,
  sessionId: string,
  votes: number,
  phase: RoundPhase = 'pre-event',
): Promise<AllocationView> {
  if (!isUuid(eventId)) throw new VotingError('Event not found', 404, 'NotFound')
  if (!isUuid(accountId)) throw new VotingError('Sign in to vote', 401, 'NotEligible')
  if (!isUuid(sessionId)) throw new VotingError('Session not found', 404, 'NotFound', 'sessionId')
  if (typeof votes !== 'number' || !Number.isInteger(votes) || votes < 0) {
    throw new VotingError('votes must be a whole number of 0 or more', 400, 'InvalidVotes', 'votes')
  }

  await tx((t) => setAllocationIn(t, eventId, accountId, sessionId, votes, phase))
  return getAllocation(eventId, accountId, phase)
}

async function setAllocationIn(
  t: postgres.TransactionSql,
  eventId: string,
  accountId: string,
  sessionId: string,
  votes: number,
  phase: RoundPhase,
): Promise<void> {
  // The round of this phase, locked against a concurrent close.
  const rounds = await t<LockedRound[]>`
    select r.id, r.event_id, r.phase, r.mechanism, r.credits, r.opens_at, r.closes_at, r.finalized_at,
           e.status as event_status, now() as now
    from vote_rounds r
    join events e on e.id = r.event_id
    where r.event_id = ${eventId} and r.phase = ${phase} and r.finalized_at is null
    order by r.opens_at asc
    for share of r
  `
  const now = rounds[0] ? new Date(rounds[0].now).getTime() : Date.now()
  const open = rounds.find(
    (r) =>
      !r.finalized_at &&
      new Date(r.opens_at).getTime() <= now &&
      now < new Date(r.closes_at).getTime() &&
      r.event_status === WRITABLE_STATUS[r.phase as RoundPhase],
  )
  if (!open) {
    const first = rounds[0]
    if (!first) throw new VotingError(explainNotOpen(null, 'none', null, phase), 409, 'NoRound')
    const info = toRoundInfo(first, now)
    if (now >= new Date(first.closes_at).getTime()) {
      throw new VotingError(explainNotOpen(info, 'closed', first.event_status, phase), 409, 'RoundClosed')
    }
    throw new VotingError(explainNotOpen(info, info.status, first.event_status, phase), 409, 'RoundNotOpen')
  }
  const mechanism = open.mechanism as VotingMechanism

  const eligibility = await checkEligibility(t, eventId, accountId, phase)
  if (!eligibility.eligible) {
    throw new VotingError(eligibility.reason ?? 'You cannot vote in this gathering.', 403, eligibility.code ?? 'NotEligible')
  }

  if (!isValidVoteCount(votes, mechanism)) {
    const max = maxVotesFor(mechanism)
    throw new VotingError(
      mechanism === 'approval'
        ? 'Approval voting allows at most 1 vote per session.'
        : `A session can take at most ${max} votes.`,
      400,
      'InvalidVotes',
      'votes',
    )
  }

  const [session] = await t<{ id: string; status: string; is_votable: boolean | null }[]>`
    select id, status, is_votable from sessions where id = ${sessionId} and event_id = ${eventId}
  `
  if (votes > 0) {
    if (!session) throw new VotingError('Session not found', 404, 'NotFound', 'sessionId')
    if (!['approved', 'scheduled'].includes(session.status) || session.is_votable === false) {
      throw new VotingError('This session is not open for voting.', 403, 'SessionNotVotable', 'sessionId')
    }
    // Attendance votes name only what is happening: the slot ± grace, checked on the
    // server's clock (design §11). Removing a vote is always allowed.
    if (phase === 'attendance' && !(await isHappeningNow(t, eventId, sessionId))) {
      throw new VotingError(
        'This session is not happening right now. Attendance votes open 15 minutes before a session starts and close 15 minutes after it ends.',
        403,
        'SessionNotHappening',
        'sessionId',
      )
    }
  }

  // Serialize this voter's writes: create the row if needed, then lock it.
  await t`
    insert into credit_ledger (round_id, event_id, account_id)
    values (${open.id}, ${eventId}, ${accountId})
    on conflict (round_id, account_id) do nothing
  `
  const [ledger] = await t<{ allocated: unknown }[]>`
    select allocated from credit_ledger
    where round_id = ${open.id} and account_id = ${accountId}
    for update
  `
  if (!ledger) throw new Error('credit_ledger row missing under lock')
  const before = await pruneAllocation(t, eventId, ledger?.allocated)
  const after: Record<string, number> = { ...before }
  if (votes === 0) delete after[sessionId]
  else after[sessionId] = votes

  const budget = budgetFor(phase, open.credits, eligibility.override)
  const oldCost = allocationCost(before, mechanism)
  const newCost = allocationCost(after, mechanism)
  // A reduction is always allowed, even if an organizer lowered the budget below the spend.
  if (newCost > budget && newCost > oldCost) {
    const noun = mechanism === 'approval' ? 'approvals' : 'credits'
    throw new VotingError(
      `Not enough ${noun}: this would use ${newCost} of your ${budget}.`,
      400,
      'OverBudget',
      'votes',
    )
  }

  // The row is kept even when empty: a concurrent writer holding its lock must never
  // find it gone. Empty ledgers cast no ballot at close, and every ledger row is
  // deleted there.
  const updated = await t`
    update credit_ledger
    set allocated = ${t.json(after)}, spent = ${newCost}, updated_at = now()
    where round_id = ${open.id} and account_id = ${accountId}
  `
  if (updated.count !== 1) throw new Error('credit_ledger row vanished under lock')
}
