/**
 * GET /api/atproto/records?event=<slug>&collection=<nsid>&limit=<n>
 *
 * The "AppView read" for third parties: every indexed public record that
 * belongs to one gathering — what its actor wrote, plus the proposals offered
 * to it and the co-host / endorsement / RSVP records that chain to those.
 * Public, read-only, only for public/unlisted non-draft events. Everything
 * returned is already world-readable on the network; this just saves a
 * client from crawling repos.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { INDEXED_COLLECTIONS, NSID } from '@/lib/atproto/nsids'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const CACHE = 'public, max-age=60'

interface RecordRow {
  uri: string
  did: string
  collection: string
  rkey: string
  cid: string | null
  record: Record<string, unknown>
  indexed_at: string
}

function shape(row: RecordRow) {
  return {
    uri: row.uri,
    did: row.did,
    collection: row.collection,
    rkey: row.rkey,
    cid: row.cid,
    record: row.record,
    indexedAt: row.indexed_at,
  }
}

const SELECT = 'uri, did, collection, rkey, cid, record, indexed_at'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const slug = params.get('event')?.trim()
  const collection = params.get('collection')?.trim() || null
  const limitRaw = Number(params.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIMIT) : DEFAULT_LIMIT

  if (!slug) return NextResponse.json({ error: 'event is required' }, { status: 400 })
  if (collection && !(INDEXED_COLLECTIONS as readonly string[]).includes(collection)) {
    return NextResponse.json({ error: 'unknown collection', collections: INDEXED_COLLECTIONS }, { status: 400 })
  }

  const db = await createAdminClient()
  const { data: event, error: eventError } = await db
    .from('events')
    .select('id, slug, status, visibility, actor_did, gathering_uri, calendar_event_uri')
    .eq('slug', slug)
    .maybeSingle()
  if (eventError) return NextResponse.json({ error: eventError.message }, { status: 500 })
  if (!event || event.status === 'draft' || !['public', 'unlisted'].includes(event.visibility as string)) {
    return NextResponse.json({ error: 'event not found' }, { status: 404 })
  }

  const wanted = collection ? [collection] : [...INDEXED_COLLECTIONS]
  const byUri = new Map<string, RecordRow>()
  const take = (rows: RecordRow[] | null | undefined) => {
    for (const r of rows ?? []) if (!byUri.has(r.uri)) byUri.set(r.uri, r)
  }

  // 1. Everything the gathering actor wrote, in the wanted collections.
  if (event.actor_did) {
    const { data, error } = await db
      .from('at_records')
      .select(SELECT)
      .eq('did', event.actor_did)
      .in('collection', wanted)
      .order('indexed_at', { ascending: false })
      .limit(limit)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    take(data as RecordRow[])
  }

  // 2. Proposals offered to this gathering: by `gathering` URI, and by the
  //    sessions that link to a proposer's record.
  const proposalUris = new Set<string>()
  const { data: sessions, error: sessionError } = await db
    .from('sessions')
    .select('proposal_uri, calendar_event_uri')
    .eq('event_id', event.id)
    .not('proposal_uri', 'is', null)
  if (sessionError) return NextResponse.json({ error: sessionError.message }, { status: 500 })
  const calendarUris = new Set<string>()
  if (event.calendar_event_uri) calendarUris.add(event.calendar_event_uri as string)
  for (const s of (sessions ?? []) as { proposal_uri: string | null; calendar_event_uri: string | null }[]) {
    if (s.proposal_uri) proposalUris.add(s.proposal_uri)
    if (s.calendar_event_uri) calendarUris.add(s.calendar_event_uri)
  }

  if (wanted.includes(NSID.proposal)) {
    if (event.gathering_uri) {
      const { data, error } = await db
        .from('at_records')
        .select(SELECT)
        .eq('collection', NSID.proposal)
        .eq('record->>gathering', event.gathering_uri as string)
        .order('indexed_at', { ascending: false })
        .limit(limit)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      take(data as RecordRow[])
      for (const r of (data ?? []) as RecordRow[]) proposalUris.add(r.uri)
    }
    if (proposalUris.size) {
      const { data, error } = await db
        .from('at_records')
        .select(SELECT)
        .eq('collection', NSID.proposal)
        .in('uri', [...proposalUris])
        .limit(limit)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      take(data as RecordRow[])
    }
  }

  // 3. Records that strongRef one of those proposals (co-host, endorsement) …
  if (proposalUris.size) {
    for (const nsid of [NSID.cohost, NSID.endorsement]) {
      if (!wanted.includes(nsid)) continue
      const { data, error } = await db
        .from('at_records')
        .select(SELECT)
        .eq('collection', nsid)
        .in('record->proposal->>uri', [...proposalUris])
        .order('indexed_at', { ascending: false })
        .limit(limit)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      take(data as RecordRow[])
    }
  }

  // 4. … and opt-in RSVPs on the gathering's calendar events.
  if (wanted.includes(NSID.rsvp) && calendarUris.size) {
    const { data, error } = await db
      .from('at_records')
      .select(SELECT)
      .eq('collection', NSID.rsvp)
      .in('record->subject->>uri', [...calendarUris])
      .order('indexed_at', { ascending: false })
      .limit(limit)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    take(data as RecordRow[])
  }

  const records = [...byUri.values()]
    .sort((a, b) => (a.indexed_at < b.indexed_at ? 1 : a.indexed_at > b.indexed_at ? -1 : 0))
    .slice(0, limit)
    .map(shape)

  return NextResponse.json(records, { headers: { 'Cache-Control': CACHE } })
}
