/**
 * Destructive-action approvals for a gathering (spec §6).
 *
 * GET  /api/v1/events/[slug]/approvals            owner/admin: open and recent requests, with who approved
 * POST /api/v1/events/[slug]/approvals            owner/admin, body { action, ... }:
 *        request-move   { sessionId, reason, target?: { timeSlotId, venueId? }, confirmPublicLinkage? }
 *        request-cancel { sessionId, reason, confirmPublicLinkage? }
 *        request-listing-removal { listingId, reason, confirmPublicLinkage? }
 *        approve        { requestId, confirmPublicLinkage? }
 *        withdraw       { requestId }   (your own approval; withdraws the request if you raised it)
 *
 * Each approval writes a `freeschool.draft.approval` record in the approving organiser's OWN repo.
 * Responses: `{ status: 'applied' | 'awaiting_approval', approvalsNeeded, requestId?, approvals?, threshold? }`.
 * An OAuth-door organiser who has not confirmed public linkage gets 409 `confirm_public_linkage`.
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { readPolicyThresholds } from '@/lib/events/policy'
import { sql } from '@/lib/db'
import {
  approveRequest,
  listApprovalRequests,
  requestListingRemoval,
  requestSessionCancel,
  requestSessionMove,
  withdrawApproval,
} from '@/lib/atproto/approvals'
import { atprotoErrorResponse } from '@/lib/atproto/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Params = { params: Promise<{ slug: string }> }

export async function GET(request: Request, { params }: Params) {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ['owner', 'admin'])
  if (auth instanceof Response) return auth
  const [event] = await sql<{ policy_thresholds: unknown }[]>`select policy_thresholds from events where id = ${auth.event.id}`
  const requests = await listApprovalRequests(auth.event.id)
  return Response.json(
    { threshold: readPolicyThresholds(event?.policy_thresholds).destructiveActionStewards, viewerAccountId: auth.viewer.accountId, requests },
    { headers: NO_STORE },
  )
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function POST(request: Request, { params }: Params) {
  const denied = assertSameOrigin(request)
  if (denied) return denied
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ['owner', 'admin'])
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const action = str(body?.action)
  const base = { eventId: auth.event.id, callerUserId: auth.viewer.accountId }
  const confirmPublicLinkage = body?.confirmPublicLinkage === true
  try {
    switch (action) {
      case 'request-move': {
        const t = body?.target as { timeSlotId?: unknown; venueId?: unknown } | undefined
        const target = t && typeof t.timeSlotId === 'string' ? { timeSlotId: t.timeSlotId, venueId: typeof t.venueId === 'string' ? t.venueId : null } : undefined
        return Response.json(await requestSessionMove({ ...base, sessionId: str(body?.sessionId), reason: str(body?.reason), target, confirmPublicLinkage }), { headers: NO_STORE })
      }
      case 'request-cancel':
        return Response.json(await requestSessionCancel({ ...base, sessionId: str(body?.sessionId), reason: str(body?.reason), confirmPublicLinkage }), { headers: NO_STORE })
      case 'request-listing-removal':
        return Response.json(await requestListingRemoval({ ...base, listingId: str(body?.listingId), reason: str(body?.reason), confirmPublicLinkage }), { headers: NO_STORE })
      case 'approve':
        return Response.json(await approveRequest({ ...base, requestId: str(body?.requestId), confirmPublicLinkage }), { headers: NO_STORE })
      case 'withdraw':
        return Response.json(await withdrawApproval({ ...base, requestId: str(body?.requestId) }), { headers: NO_STORE })
      default:
        return Response.json({ error: 'action must be one of request-move, request-cancel, request-listing-removal, approve, withdraw', field: 'action' }, { status: 400 })
    }
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === '22P02') return Response.json({ error: 'Invalid id' }, { status: 400 })
    return atprotoErrorResponse(e, 'approvals')
  }
}
