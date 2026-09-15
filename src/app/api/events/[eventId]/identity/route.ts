import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { canRolePerform } from '@/lib/permissions'
import { GatheringIdentityError, previewGatheringHandle } from '@/lib/events/identity'
import { mintGatheringActor } from '@/lib/atproto/actors'
import { isHiddenEvent } from '@/lib/events'
import type { EventRoleName } from '@/types/event'

/**
 * POST /api/events/[eventId]/identity — organizer retry for a gathering whose DID could not
 * be minted at creation (the PDS was unreachable, say). Idempotent: an event that already
 * has an identity answers with it. Owner/admin only.
 *
 * → 200 { did, handle, minted }   503 { error, code: 'IdentityMintFailed' }
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { eventId } = await params
  if (!UUID.test(eventId)) return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })

  const [event] = await sql<{ id: string; slug: string; status: string; visibility: string }[]>`
    select id, slug, status, visibility from events where id = ${eventId}
  `
  const [member] = event
    ? await sql<{ role: EventRoleName }[]>`select role from event_members where event_id = ${eventId} and user_id = ${viewer.accountId}`
    : []
  if (!event || (isHiddenEvent(event) && !member)) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  }
  if (!member || !canRolePerform(member.role, 'editEventSettings')) {
    return NextResponse.json({ error: 'Only this event’s organizers can create its identity.' }, { status: 403, headers: NO_STORE })
  }

  try {
    const identity = await mintGatheringActor(event.id, viewer.accountId)
    return NextResponse.json(
      { did: identity.did, handle: identity.handle, minted: identity.minted, preview: previewGatheringHandle(event.slug) },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof GatheringIdentityError && e.status === 404) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
    }
    console.error('[events/identity] mint failed:', e)
    const message = e instanceof GatheringIdentityError ? e.message : 'The network identity could not be created.'
    return NextResponse.json({ error: `${message} Try again shortly.`, code: 'IdentityMintFailed' }, { status: 503, headers: NO_STORE })
  }
}
