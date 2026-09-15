/**
 * Voting mechanisms as pure functions (spec §5.3 step 2). Client-safe: the server
 * enforces them in `setAllocation`, the browser uses them only to preview a cost.
 *
 *   quadratic  cost(v) = v²      Σ cost ≤ budget
 *   linear     cost(v) = v       Σ cost ≤ budget
 *   approval   v ∈ {0, 1}        count ≤ budget
 */

export type VotingMechanism = 'quadratic' | 'linear' | 'approval'
export type RoundPhase = 'pre-event' | 'attendance'

export const MECHANISMS: readonly VotingMechanism[] = ['quadratic', 'linear', 'approval']
export const PHASES: readonly RoundPhase[] = ['pre-event', 'attendance']

/** Upper bound on votes for one session; keeps v² far inside int4. */
export const MAX_VOTES_PER_SESSION = 1000

export function isMechanism(value: unknown): value is VotingMechanism {
  return typeof value === 'string' && (MECHANISMS as readonly string[]).includes(value)
}

export function isPhase(value: unknown): value is RoundPhase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value)
}

/** Credits that `votes` on one session cost. Zero votes cost nothing. */
export function voteCost(votes: number, mechanism: VotingMechanism): number {
  if (!Number.isFinite(votes) || votes <= 0) return 0
  const v = Math.trunc(votes)
  switch (mechanism) {
    case 'quadratic':
      return v * v
    case 'linear':
      return v
    case 'approval':
      return 1
  }
}

/** Total credits an allocation costs. */
export function allocationCost(allocation: Record<string, number>, mechanism: VotingMechanism): number {
  let total = 0
  for (const v of Object.values(allocation)) total += voteCost(v, mechanism)
  return total
}

/** Largest vote count one session may carry under a mechanism. */
export function maxVotesFor(mechanism: VotingMechanism): number {
  return mechanism === 'approval' ? 1 : MAX_VOTES_PER_SESSION
}

/** Whether `votes` is a well-formed vote count for the mechanism (0 means "remove"). */
export function isValidVoteCount(votes: unknown, mechanism: VotingMechanism): votes is number {
  return typeof votes === 'number' && Number.isInteger(votes) && votes >= 0 && votes <= maxVotesFor(mechanism)
}

/** "3 votes = 9 credits" */
export function costLabel(votes: number, mechanism: VotingMechanism): string {
  const cost = voteCost(votes, mechanism)
  return `${votes} ${votes === 1 ? 'vote' : 'votes'} = ${cost} ${cost === 1 ? 'credit' : 'credits'}`
}
