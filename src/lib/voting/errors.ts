/**
 * Errors the voting and feedback machinery throws. Each carries the HTTP status and a
 * stable `code` so route handlers map them without string matching. Client-safe.
 */

export type VotingErrorCode =
  | 'RoundOpen'
  | 'NoRound'
  | 'RoundClosed'
  | 'RoundNotOpen'
  | 'NotEligible'
  | 'NotMember'
  | 'TicketRequired'
  /** The attendance round is gated on check-in at the door and this voter is not checked in. */
  | 'CheckinRequired'
  | 'SessionNotVotable'
  | 'SessionNotHappening'
  | 'InvalidVotes'
  | 'OverBudget'
  | 'InvalidRound'
  /** The gathering's phase does not keep a round of this kind open (organizer controls). */
  | 'WrongPhase'
  | 'WindowNotOpen'
  | 'WindowClosed'
  | 'SelfFeedback'
  | 'InvalidFeedback'
  | 'NotFound'

export class VotingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: VotingErrorCode,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'VotingError'
  }
}

/**
 * Thrown by every read of counts while a round is not finalized (spec §5.3 step 3):
 * nobody — not attendees, not organizers — sees a count mid-round.
 */
export class RoundOpenError extends VotingError {
  constructor(readonly roundId: string) {
    super('Results are sealed until the voting round closes', 409, 'RoundOpen')
    this.name = 'RoundOpenError'
  }
}

export function isVotingError(e: unknown): e is VotingError {
  return e instanceof VotingError
}
