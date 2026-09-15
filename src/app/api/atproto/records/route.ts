/**
 * GET /api/atproto/records?event=<slug>&collection=<nsid>&limit=<n>
 *
 * The AppView read for third parties: every indexed public record that belongs to one gathering —
 * what its actor wrote, the proposals offered to it, and the co-host / endorsement / RSVP /
 * time-preference records that chain to those.
 *
 * Visibility rules:
 *   - a public or unlisted gathering that has left `draft`: anyone
 *   - a private or draft gathering: members only; everyone else gets 404 (existence not disclosed)
 *   - a person's record is served only while it references this gathering; nothing app-side
 *     (RSVP rows, votes, rosters) is ever joined in
 * Everything returned is already on the network; this saves a client from crawling repos.
 */
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { eventRole, getViewer } from '@/lib/auth/viewer'
import { INDEXED_COLLECTIONS, NSID } from '@/lib/atproto/nsids'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

interface RecordRow {
  uri: string
  did: string
  collection: string
  rkey: string
  cid: string | null
  record: Record<string, unknown>
  indexed_at: string
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const slug = params.get('event')?.trim()
  const collection = params.get('collection')?.trim() || null
  const limitRaw = Number(params.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIMIT) : DEFAULT_LIMIT

  if (!slug) return NextResponse.json({ error: 'event is required', field: 'event' }, { status: 400 })
  if (collection && !(INDEXED_COLLECTIONS as readonly string[]).includes(collection)) {
    return NextResponse.json({ error: 'unknown collection', field: 'collection' }, { status: 400 })
  }

  const [event] = await sql<{ id: string; status: string; visibility: string; actor_did: string | null; gathering_uri: string | null; calendar_event_uri: string | null }[]>`
    select id, status, visibility, actor_did, gathering_uri, calendar_event_uri from events where slug = ${slug}
  `
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const openToAll = ['public', 'unlisted'].includes(event.visibility) && event.status !== 'draft'
  let cacheControl = 'public, max-age=60'
  if (!openToAll) {
    const viewer = await getViewer(request)
    const role = viewer ? await eventRole(event.id, viewer.accountId) : null
    if (!role) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    cacheControl = 'private, no-store'
  }

  const wanted = collection ? [collection] : [...INDEXED_COLLECTIONS]
  const gatheringUri = event.gathering_uri ?? (event.actor_did ? `at://${event.actor_did}/${NSID.gathering}/self` : null)

  const rows = await sql<RecordRow[]>`
    with proposals as (
      select proposal_uri as uri from sessions where event_id = ${event.id} and proposal_uri is not null
      union
      select uri from at_records where collection = ${NSID.proposal} and record ->> 'gathering' = ${gatheringUri ?? ''}
    ),
    calendar as (
      select calendar_event_uri as uri from sessions where event_id = ${event.id} and calendar_event_uri is not null
      union
      select ${event.calendar_event_uri ?? ''}::text
    )
    select uri, did, collection, rkey, cid, record, indexed_at from at_records
    where collection = any(${wanted}::text[])
      and (
        did = ${event.actor_did ?? ''}
        or (collection = ${NSID.proposal} and uri in (select uri from proposals))
        or (collection in (${NSID.cohost}, ${NSID.endorsement}, ${NSID.timePreference})
            and record -> 'proposal' ->> 'uri' in (select uri from proposals))
        or (collection = ${NSID.rsvp} and record -> 'subject' ->> 'uri' in (select uri from calendar))
      )
    order by indexed_at desc
    limit ${limit}
  `

  return NextResponse.json(
    rows.map((r) => ({ uri: r.uri, did: r.did, collection: r.collection, rkey: r.rkey, cid: r.cid, record: r.record, indexedAt: r.indexed_at })),
    { headers: { 'Cache-Control': cacheControl } },
  )
}
