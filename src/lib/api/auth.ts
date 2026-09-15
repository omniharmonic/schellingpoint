import 'server-only'
import crypto from 'crypto'
import type { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { badRequest, notFound } from '@/lib/api/response'

/**
 * Event scoping for the public AppView reads under `/api/v1/{tracks,venues,timeslots,schedule}`.
 *
 * The shared-key partner API is gone (spec §2: "that endpoint does not survive"). What replaced
 * it serves, without a key, only what a gathering has already published to the network, and only
 * for gatherings anyone may read: visibility `public` or `unlisted` (reachable by slug, exactly
 * like the gathering page) and not `draft` — the same boundary as `public.can_read_event` for a
 * signed-out reader.
 */

export const PUBLIC_READ_VISIBILITIES = ['public', 'unlisted'] as const

export interface PublicEvent {
  id: string
  slug: string
  name: string
  visibility: string
  status: string
  timezone: string
  actor_did: string | null
  gathering_uri: string | null
}

function eventSlugParam(request: Request): string | null {
  const slug = new URL(request.url).searchParams.get('event')?.trim()
  return slug ? slug : null
}

async function publicEventWhere(by: { slug: string } | { id: string }): Promise<PublicEvent | null> {
  const rows = await sql<PublicEvent[]>`
    select id, slug, name, visibility, status, timezone, actor_did, gathering_uri
    from events
    where ${'slug' in by ? sql`slug = ${by.slug}` : sql`id = ${by.id}`}
      and visibility in ${sql([...PUBLIC_READ_VISIBILITIES])}
      and coalesce(status, 'draft') <> 'draft'
  `
  return rows[0] ?? null
}

/**
 * Resolve the required `?event=<slug>`: 400 when missing, 404 when the slug is unknown or names a
 * private or draft gathering (existence is not disclosed).
 */
export async function resolvePublicEvent(request: Request): Promise<{ event: PublicEvent } | { error: NextResponse }> {
  const slug = eventSlugParam(request)
  if (!slug) return { error: badRequest('event query parameter (event slug) is required') }
  const event = await publicEventWhere({ slug })
  return event ? { event } : { error: notFound('Event') }
}

/**
 * The publicly readable event owning a row, or null (treat as not found). When the caller passed
 * `?event=<slug>` it must match.
 */
export async function publicEventForRow(request: Request, eventId: string | null | undefined): Promise<PublicEvent | null> {
  if (!eventId) return null
  const event = await publicEventWhere({ id: eventId })
  if (!event) return null
  const requested = eventSlugParam(request)
  if (requested && requested !== event.slug) return null
  return event
}

// ---------------------------------------------------------------------------
// Transitional: package B's GET /api/v1/sessions still gates on the shared key. The key API does
// not survive (spec §2); remove this with that caller.
// ---------------------------------------------------------------------------

/** @deprecated The shared-key API does not survive (spec §2). Kept only until /api/v1/sessions stops importing it. */
export function validateApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  const expected = process.env.API_KEY_BONFIRESAI
  if (!apiKey || !expected) return false
  const a = Buffer.from(apiKey, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
