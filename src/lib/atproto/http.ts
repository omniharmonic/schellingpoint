import 'server-only'
/**
 * One mapping from ATProto-layer errors to `{ error, code?, field? }` JSON (plan §3.4).
 * Messages written for the person acting pass through; anything unexpected becomes a generic 502
 * and is logged by name only (never a DID, handle, record body or credential).
 */
import { XRPCError } from '@atproto/api'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function json(status: number, error: string, code?: string, field?: string): Response {
  return Response.json({ error, ...(code ? { code } : {}), ...(field ? { field } : {}) }, { status, headers: NO_STORE })
}

export function atprotoErrorResponse(e: unknown, context = 'atproto'): Response {
  const err = e as { name?: string; message?: string; status?: number; code?: string; field?: string; error?: string }
  switch (err?.name) {
    case 'ParticipantError':
    case 'ApprovalError':
    case 'RoleClaimError':
    case 'PeerError':
    case 'PolicyThresholdsError':
    case 'SeriesError':
      return json(err.status ?? 400, err.message ?? 'Request rejected', err.code, err.field)
    case 'GatheringActionDeniedError':
      return json(403, err.message ?? 'Not allowed', err.code ?? 'ErrPermissionDenied')
    case 'GatheringNotLinkedError':
      return json(409, 'This gathering has no network identity yet.', 'GatheringNotLinked')
    case 'GatheringCredentialError':
      return json(503, err.message ?? 'The gathering cannot publish right now.', 'GatheringCredentialUnavailable')
    case 'NoActorCredentialError':
    case 'ProfileNotLinkedError':
      return json(409, 'Your ATProto session has expired or custody ended. Sign in with ATProto again to publish.', 'relink_atproto')
    case 'ForeignDidError':
    case 'RecordValidationError':
      return json(409, err.message ?? 'The record failed validation.', 'invalid_record')
    case 'GatheringIdentityError':
      return json(err.status ?? 502, err.message ?? 'Identity error', err.code)
  }
  if (e instanceof XRPCError && e.error === 'InvalidSwap') {
    return json(409, 'The record changed on the network while you were editing. Reload and try again.', 'InvalidSwap')
  }
  console.error(`[${context}] unexpected failure:`, err?.name ?? 'error')
  return json(502, 'The network write failed. Please try again.', 'NetworkWriteFailed')
}
