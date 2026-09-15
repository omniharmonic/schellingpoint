import 'server-only'
/**
 * Ballot-key voting and feedback ballots (spec §5, plan §7.2 "Voting (C owns)").
 *
 * Lifecycle (who calls what):
 *   openRound(eventId, opts?, tx?)   package A, when an event enters `voting_open`
 *                                    (pass the transition's transaction to open atomically)
 *   setAllocation(...)               PUT /api/v1/events/[slug]/votes/mine
 *   closeDueRounds()                 GET /api/jobs/close-rounds (every minute), which also
 *                                    closes rounds whose event left the voting phase
 *   closeRound(roundId)              the sweep, or an explicit organizer close
 *
 * Reads (every one refuses counts while a round is open — RoundOpenError, HTTP 409):
 *   roundState(eventId)              → { round | null, status: 'none'|'upcoming'|'open'|'closed' }
 *   organizerResults(eventId)        → [{ sessionId, voters, votes, credits }]   (organizers only; caller authorizes)
 *   schedulingInputs(eventId)        → { roundId, bySession: Map<sessionId, { votes, tokens: Set<hex> }> }
 *   publicTally(eventId, k?)         → k-suppressed entries, ballotsCast
 *
 * Feedback:
 *   openFeedbackWindow(sessionId), submitFeedback, getOwnFeedback, retractFeedback,
 *   closeDueFeedbackWindows(), feedbackSummary(sessionId, k?, { includeComments })
 */
export {
  closeDueRounds,
  closeRound,
  eventK,
  getRound,
  KEEP_OPEN_STATUSES,
  openRound,
  organizerResults,
  publicTally,
  publishRoundTally,
  roundState,
  schedulingInputs,
  suppressEntries,
  WRITABLE_STATUS,
  type CloseRoundOptions,
  type CloseRoundResult,
  type OpenRoundOptions,
  type PublicTally,
  type RoundInfo,
  type RoundStateResult,
  type RoundStatus,
  type SchedulingInputs,
  type SessionResult,
  type TallyEntry,
} from './rounds'
export { checkEligibility, getAllocation, setAllocation, type AllocationView, type Eligibility } from './allocation'
export {
  closeDueFeedbackWindows,
  FEEDBACK_WINDOW_HOURS,
  feedbackSummary,
  getOwnFeedback,
  openFeedbackWindow,
  parseFeedbackInput,
  retractFeedback,
  submitFeedback,
  type FeedbackInput,
  type FeedbackSummary,
  type FeedbackWindowInfo,
  type FeedbackWindowStatus,
  type OwnFeedback,
} from './feedback'
export { isVotingError, RoundOpenError, VotingError, type VotingErrorCode } from './errors'
export {
  allocationCost,
  costLabel,
  isMechanism,
  isPhase,
  isValidVoteCount,
  maxVotesFor,
  voteCost,
  type RoundPhase,
  type VotingMechanism,
} from './mechanism'
