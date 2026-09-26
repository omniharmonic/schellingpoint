import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireViewer } from '@/lib/auth/viewer'
import {
  NO_STORE,
  decodeDidParam,
  isDid,
  jsonError,
  memberCardColumns,
  type MemberCard,
} from '../../events/[slug]/participants/people'

/**
 * One person, as a fellow member sees them (spec §8).
 *
 *   GET /api/v1/members/[did] → { member: MemberCard, gatherings: [{ slug, name }] }
 *
 * 404 — not 403 — unless the viewer shares a gathering with that DID in which the person is
 * listed in the directory (or the DID is the viewer's own). A 403 would confirm that the DID
 * holds an account here; "another gathering is the public". `gatherings` lists only gatherings
 * both belong to, so nothing about the person's other memberships is disclosed.
 *
 * The two per-gathering sharing switches (design §3.3) are read across exactly those shared
 * gatherings: the messaging handle appears if the person shares it in any of them, the email
 * address only if they turned `share_email` on in one of them. This endpoint is cross-gathering
 * by construction, so it can say nothing narrower — the per-gathering card that the profile page
 * renders comes from `GET /api/v1/events/[slug]/participants/[did]`, which is scoped to one
 * gathering's switches.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ did: string }> }) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const did = decodeDidParam((await params).did)
  const notFound = () => jsonError(404, 'Member not found')
  if (!isDid(did)) return notFound()

  const isSelf = did === viewer.did
  // "In a gathering we both belong to, where they left this switch on." Their own view is gated
  // the same way, so what a person sees of themselves is what fellow members see.
  const sharesContact = sql`
    exists (
      select 1 from event_members theirs
      join event_members mine on mine.event_id = theirs.event_id and mine.user_id = ${viewer.accountId}
      where theirs.user_id = a.id and theirs.directory_listing and theirs.share_contact
    )
  `
  const sharesEmail = sql`
    exists (
      select 1 from event_members theirs
      join event_members mine on mine.event_id = theirs.event_id and mine.user_id = ${viewer.accountId}
      where theirs.user_id = a.id and theirs.directory_listing and theirs.share_email
    )
  `
  const [member] = await sql<MemberCard[]>`
    select ${memberCardColumns(sharesContact, sharesEmail)}
    from accounts a join profiles p on p.id = a.id
    where a.did = ${did}
  `
  if (!member) return notFound()

  const gatherings = await sql<{ slug: string; name: string }[]>`
    select e.slug, e.name
    from event_members theirs
    join event_members mine on mine.event_id = theirs.event_id and mine.user_id = ${viewer.accountId}
    join events e on e.id = theirs.event_id
    where theirs.user_id = ${member.id}
      and (theirs.directory_listing or ${isSelf})
    order by e.start_date desc nulls last, e.name
  `
  if (!isSelf && gatherings.length === 0) return notFound()

  return NextResponse.json({ member, gatherings }, { headers: NO_STORE })
}
