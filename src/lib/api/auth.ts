import crypto from 'crypto'
import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { badRequest, notFound } from '@/lib/api/response'

export function validateApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey) return false

  const expected = process.env.API_KEY_BONFIRESAI
  if (!expected) return false

  try {
    const keyBuffer = Buffer.from(apiKey, 'utf8')
    const expectedBuffer = Buffer.from(expected, 'utf8')
    if (keyBuffer.length !== expectedBuffer.length) return false
    return crypto.timingSafeEqual(keyBuffer, expectedBuffer)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Partner API event scoping
//
// The partner read API (/api/v1/*) runs with the admin client, so every route
// must scope its queries to a single event and must never expose events that
// are private or still in draft.
// ---------------------------------------------------------------------------

export const PARTNER_VISIBLE_VISIBILITIES = ['public', 'unlisted'] as const

export interface PartnerEvent {
  id: string
  slug: string
  visibility: string
  status: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>

function partnerVisibleEvents(supabase: AnySupabaseClient) {
  return supabase
    .from('events')
    .select('id,slug,visibility,status')
    .in('visibility', [...PARTNER_VISIBLE_VISIBILITIES])
    .neq('status', 'draft')
}

function eventSlugParam(request: Request): string | null {
  const slug = new URL(request.url).searchParams.get('event')?.trim()
  return slug ? slug : null
}

/**
 * Resolve the required `?event=<slug>` query parameter for list routes.
 * Returns a 400 when the parameter is missing and a 404 when the slug does not
 * belong to a partner-visible (public/unlisted, non-draft) event.
 */
export async function resolvePartnerEvent(
  request: Request,
  supabase: AnySupabaseClient
): Promise<{ event: PartnerEvent } | { error: NextResponse }> {
  const slug = eventSlugParam(request)
  if (!slug) {
    return { error: badRequest('event query parameter (event slug) is required') }
  }

  const { data, error } = await partnerVisibleEvents(supabase).eq('slug', slug).maybeSingle()
  if (error || !data) {
    return { error: notFound('Event') }
  }

  return { event: data as PartnerEvent }
}

/**
 * Check whether a row (identified by its `event_id`) may be returned to the
 * partner API. The owning event must be partner-visible, and when the caller
 * supplied `?event=<slug>` it must match the row's event. Returns the event on
 * success or null when the row should be treated as not found.
 */
export async function partnerEventForRow(
  request: Request,
  supabase: AnySupabaseClient,
  eventId: string | null | undefined
): Promise<PartnerEvent | null> {
  if (!eventId) return null

  const { data, error } = await partnerVisibleEvents(supabase).eq('id', eventId).maybeSingle()
  if (error || !data) return null

  const requestedSlug = eventSlugParam(request)
  if (requestedSlug && requestedSlug !== data.slug) return null

  return data as PartnerEvent
}

/** IDs of every partner-visible event, for filtering cross-event lookups. */
export async function partnerVisibleEventIds(supabase: AnySupabaseClient): Promise<string[]> {
  const { data } = await partnerVisibleEvents(supabase)
  return (data ?? []).map((e: { id: string }) => e.id)
}
