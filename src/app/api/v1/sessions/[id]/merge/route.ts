/**
 * Session mergers (PRD §4.4). `[id]` is always the SOURCE session — the one whose proposer is
 * offering to fold it into another.
 *
 *   GET    → { requests: [...] }                      offers touching this session
 *   POST   { target_session_id, message? }            offer the merger (source's proposer only)
 *   PATCH  { request_id, action, reason? }            accept / decline (target's proposer),
 *                                                     withdraw (the requester),
 *                                                     unmerge (either proposer, after an accept)
 *
 * Authorization is by authorship, not by role: an organizer curates the program but does not
 * merge someone's proposal for them (R9). Reads are open to the two proposers, their accepted
 * co-hosts and organizers.
 */
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { decideMerge, listMergeRequests, MergeError, requestMerge, type MergeDecision } from '@/lib/sessions/merge'
import {
  canSeeSession,
  isUuid,
  json,
  jsonError,
  loadSessionEventAccess,
  readJsonObject,
  sessionRelation,
} from '@/app/api/v1/sessions/_lib/access'
import { sql } from '@/lib/db'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ id: string }> }

const DECISIONS: MergeDecision[] = ['accept', 'decline', 'withdraw', 'unmerge']

function fail(e: unknown): Response {
  if (e instanceof MergeError) {
    return jsonError(e.status, e.message, { code: e.code, ...(e.field ? { field: e.field } : {}) })
  }
  throw e
}

export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params
  const access = await loadSessionEventAccess(request, id)
  if (access instanceof Response) return access
  const accountId = access.viewer?.accountId ?? null
  const relation = await sessionRelation(sql, id, access.sessionEventId, accountId)
  if (!relation || !canSeeSession(relation, access)) return jsonError(404, 'Session not found')
  const visible = relation.isHost || relation.isCohost || access.isOrganizer
  if (!visible) return json({ requests: [] })
  return json({ requests: await listMergeRequests(id, accountId) })
}

export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { id } = await params
  const access = await loadSessionEventAccess(request, id)
  if (access instanceof Response) return access
  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const target = body.target_session_id
  if (!isUuid(target)) return jsonError(400, 'Choose the session to merge into', { field: 'target_session_id' })
  const raw = body.message
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return jsonError(400, 'message must be text', { field: 'message' })
  }
  const message = typeof raw === 'string' ? raw.trim().slice(0, 1000) || null : null

  try {
    const merge = await requestMerge({
      eventId: access.sessionEventId,
      eventSlug: access.event.slug,
      sourceSessionId: id,
      targetSessionId: target,
      accountId: viewer.accountId,
      message,
    })
    return json({ request: merge }, { status: 201 })
  } catch (e) {
    return fail(e)
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { id } = await params
  const access = await loadSessionEventAccess(request, id)
  if (access instanceof Response) return access
  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  if (!isUuid(body.request_id)) return jsonError(400, 'request_id is required', { field: 'request_id' })
  const action = body.action
  if (typeof action !== 'string' || !DECISIONS.includes(action as MergeDecision)) {
    return jsonError(400, `action must be one of ${DECISIONS.join(', ')}`, { field: 'action' })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) || null : null

  try {
    const merge = await decideMerge({
      eventId: access.sessionEventId,
      eventSlug: access.event.slug,
      requestId: body.request_id,
      accountId: viewer.accountId,
      decision: action as MergeDecision,
      reason,
    })
    return json({ request: merge })
  } catch (e) {
    return fail(e)
  }
}
