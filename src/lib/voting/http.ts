import 'server-only'
/**
 * Route helpers shared by the voting and feedback API handlers.
 */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { dbErrorResponse, sql } from '@/lib/db'
import { eventRole, getViewer, type Viewer } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'
import { RoundOpenError, VotingError } from './errors'

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

export const ORGANIZER_ROLES: readonly EventRoleName[] = ['owner', 'admin', 'moderator']

export interface ResolvedEvent {
  event: { id: string; slug: string; status: string; visibility: string; actor_did: string | null }
  viewer: Viewer | null
  role: EventRoleName | null
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE })
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

/**
 * Resolve an event by slug for a read or write. Private and draft events answer 404 to
 * anyone who is not a member (existence is not disclosed). No viewer is required here;
 * callers that need one check `viewer`.
 */
export async function resolveEvent(request: Request, slug: string): Promise<ResolvedEvent | NextResponse> {
  const [viewer, events] = await Promise.all([
    getViewer(request),
    sql<ResolvedEvent['event'][]>`select id, slug, status, visibility, actor_did from events where slug = ${slug}`,
  ])
  const event = events[0]
  if (!event) return jsonError(404, 'Event not found')
  const role = viewer ? await eventRole(event.id, viewer.accountId) : null
  if ((event.visibility === 'private' || event.status === 'draft') && !role) return jsonError(404, 'Event not found')
  return { event, viewer, role }
}

/** Map a thrown error to a JSON response; logs and answers 500 for anything unexpected. */
export function errorResponse(e: unknown, context: string): Response {
  if (e instanceof RoundOpenError) {
    return jsonError(409, 'RoundOpen', { code: 'RoundOpen', message: e.message, roundId: e.roundId })
  }
  if (e instanceof VotingError) {
    return jsonError(e.status, e.message, { code: e.code, ...(e.field ? { field: e.field } : {}) })
  }
  const mapped = dbErrorResponse(e)
  if (mapped) return mapped
  console.error(`[voting] ${context} failed:`, e)
  return jsonError(500, 'Something went wrong. Please try again.')
}

/** Parse a JSON body into an object, or a 400. */
export async function readJson(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, 'Expected a JSON object')
    return body as Record<string, unknown>
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
}

/**
 * Cron auth (plan §7.2 Jobs): `Authorization: Bearer $CRON_SECRET`, 401 otherwise. In
 * development without CRON_SECRET the request is allowed; elsewhere an unset secret is 503.
 */
export function verifyCron(request: Request, job: string): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(`CRON_SECRET not set, allowing ${job} in development`)
      return null
    }
    console.error(`CRON_SECRET not configured; refusing ${job}`)
    return jsonError(503, 'CRON_SECRET not configured')
  }
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return jsonError(401, 'Unauthorized')
  }
  return null
}
