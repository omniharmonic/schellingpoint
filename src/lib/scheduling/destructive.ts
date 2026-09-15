import 'server-only'
/**
 * Destructive changes to sessions already published on the network (spec §6): moving or
 * cancelling one needs the policy's steward approvals, each written as a
 * `freeschool.draft.approval` in the approving organizer's own repo. Package F owns the
 * request/approve machinery; the schedule builder asks and reports the state.
 */
import { ApprovalError, requestSessionCancel, requestSessionMove } from '@/lib/atproto/approvals'
import { InputError } from './admin-api'

export interface DestructiveOutcome {
  status: 'applied' | 'awaiting_approval'
  approvalsNeeded: number
  requestId?: string
  approvals?: number
  threshold?: number
  results?: Array<{ kind: string; id: string; uri?: string; error?: string }>
}

interface Common {
  eventId: string
  sessionId: string
  callerUserId: string
  reason: string
  /** An OAuth-door organizer confirms that their approval record names them publicly. */
  confirmPublicLinkage?: boolean
}

function mapError(e: unknown): never {
  if (e instanceof ApprovalError) throw new InputError(e.message, e.code === 'invalid_reason' ? 'reason' : undefined, e.status, e.code)
  throw e
}

function outcome(result: Awaited<ReturnType<typeof requestSessionMove>>): DestructiveOutcome {
  return {
    status: result.status,
    approvalsNeeded: result.approvalsNeeded,
    requestId: result.requestId,
    approvals: result.approvals,
    threshold: result.threshold,
    results: result.results?.map((r) => ({ kind: r.kind, id: r.id, uri: r.uri, error: r.error })),
  }
}

export async function requestMove(input: Common & { timeSlotId: string; venueId: string }): Promise<DestructiveOutcome> {
  try {
    return outcome(
      await requestSessionMove({
        eventId: input.eventId,
        sessionId: input.sessionId,
        callerUserId: input.callerUserId,
        reason: input.reason,
        confirmPublicLinkage: input.confirmPublicLinkage,
        target: { timeSlotId: input.timeSlotId, venueId: input.venueId },
      }),
    )
  } catch (e) {
    mapError(e)
  }
}

export async function requestCancel(input: Common): Promise<DestructiveOutcome> {
  try {
    return outcome(
      await requestSessionCancel({
        eventId: input.eventId,
        sessionId: input.sessionId,
        callerUserId: input.callerUserId,
        reason: input.reason,
        confirmPublicLinkage: input.confirmPublicLinkage,
      }),
    )
  } catch (e) {
    mapError(e)
  }
}
