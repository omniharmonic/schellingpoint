/**
 * `POST /api/v1/events/[slug]/admin/clone` — copy this gathering's shape into a new draft
 * (MT §11.3).
 *
 * Owners and admins of the source gathering. The copy carries settings, venues, tracks and the
 * slot grid re-dated onto its own days; it carries nothing about people, and it starts as a
 * draft owned by whoever made it.
 *
 *   { name, slug, startDate } → 201 { event: { id, slug, name }, copied: { venues, tracks, timeSlots } }
 */
import { NextResponse } from 'next/server'
import { requireOrganizer, fail, readBody } from '@/lib/scheduling/admin-api'
import { cloneGathering, CloneError } from '@/lib/events/clone'

export const dynamic = 'force-dynamic'

const ROLES = ['owner', 'admin'] as const

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  if (typeof body.name !== 'string') return fail(400, 'Give the new gathering a name.', { field: 'name' })
  if (typeof body.slug !== 'string') return fail(400, 'Choose a web address for the new gathering.', { field: 'slug' })
  if (typeof body.startDate !== 'string') return fail(400, 'Choose a start date.', { field: 'startDate' })

  try {
    const result = await cloneGathering({
      sourceEventId: ctx.event.id,
      createdBy: ctx.viewer.accountId,
      name: body.name,
      slug: body.slug.trim().toLowerCase(),
      startDate: body.startDate,
    })
    return NextResponse.json(
      {
        event: { id: result.id, slug: result.slug, name: result.name },
        copied: { venues: result.venues, tracks: result.tracks, timeSlots: result.timeSlots },
      },
      { status: 201, headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    if (e instanceof CloneError) return fail(e.status, e.message, e.field ? { field: e.field } : {})
    console.error('[clone] failed:', e instanceof Error ? e.message : e)
    return fail(500, 'The gathering could not be copied. Try again.')
  }
}
