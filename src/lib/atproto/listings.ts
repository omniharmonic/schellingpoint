/**
 * Listings and peers (spec §6 step 3, §10): the gathering's curation surface.
 *
 * A `coop.lexicon.event.listing` is written by the CURATING gathering, into its own repo, with a
 * full strongRef (uri AND cid — interop audit gap 3) to the `community.lexicon.calendar.event`
 * it lists. Curation is not authorship: removing a listing never touches the event record.
 *
 *   own sessions   a scheduled session is listed when its config tags intersect the
 *                  gathering's routing tags (`events.atproto_tags`)
 *   peers' events  an event AUTHORED by a peer (never merely listed by one — a listing is not a
 *                  reason to list, or two gatherings loop) whose config tags route, and only
 *                  once an organiser has enabled cross-listing for that peer
 *
 * Removal is sticky (Free School `decideListingEdit`): once a listing was ever written for an
 * event, re-routing never creates another; only an explicit steward restore does. A moderation
 * removal is DESTRUCTIVE and goes through `approvals.ts` (`requestListingRemoval`).
 *
 * Server-only; the pure routing decision lives in `records.ts`, the writer in `publish.ts`.
 */
import 'server-only'
import { sql } from '@/lib/db'
import type { Approval } from './actor'
import { NSID } from './nsids'
import { attempt, loadPublishContext, publishGathering, putWithCas, type PublishContext, type PublishDeps, type PublishResult } from './publish'
import { buildListingRecord, decideListingEdit, normalizeTags, routesOnTags } from './records'
import { deterministicRkey } from './rkey'
import type { StrongRef } from './types'

export { decideListingEdit, type ListingEditAction } from './records'

export function listingRkey(eventId: string, subjectUri: string): string {
  return deterministicRkey('listing', eventId, subjectUri)
}

interface ListingRow {
  id: string
  event_id: string
  session_id: string | null
  subject_uri: string
  subject_cid: string
  origin: 'own' | 'peer'
  record_uri: string | null
  record_cid: string | null
  status: 'listed' | 'removed'
  tags: string[]
}

async function listingFor(eventId: string, subjectUri: string): Promise<ListingRow | null> {
  const rows = await sql<ListingRow[]>`
    select id, event_id, session_id, subject_uri, subject_cid, origin, record_uri, record_cid, status, tags
    from listings where event_id = ${eventId} and subject_uri = ${subjectUri}
  `
  return rows[0] ?? null
}

async function writeListing(
  ctx: PublishContext,
  results: PublishResult[],
  input: {
    id: string
    subject: StrongRef
    status: 'listed' | 'removed'
    tags: string[]
    origin: 'own' | 'peer'
    sessionId: string | null
    action: 'publish-listing' | 'remove-listing' | 'restore-listing'
    reason: string
    prior: ListingRow | null
    approvals?: Approval[]
  },
): Promise<StrongRef | null> {
  const ref = await attempt(results, 'listing', input.id, () =>
    putWithCas(
      ctx,
      {
        action: input.action,
        collection: NSID.eventListing,
        rkey: listingRkey(ctx.event.id, input.subject.uri),
        record: buildListingRecord({ event: input.subject, gatheringDid: ctx.actorDid, status: input.status, tags: input.tags, createdAt: new Date() }),
        reason: input.reason,
        approvals: input.approvals,
      },
      input.prior?.record_cid,
    ),
  )
  if (!ref || !ctx.deps.persist) return ref
  await ctx.sql`
    insert into listings (event_id, session_id, subject_uri, subject_cid, origin, record_uri, record_cid, status, tags, removed_at)
    values (
      ${ctx.event.id}, ${input.sessionId}, ${input.subject.uri}, ${input.subject.cid}, ${input.origin}, ${ref.uri}, ${ref.cid},
      ${input.status}, ${input.tags}, ${input.status === 'removed' ? new Date() : null}
    )
    on conflict (event_id, subject_uri) do update set
      subject_cid = excluded.subject_cid, record_uri = excluded.record_uri, record_cid = excluded.record_cid,
      status = excluded.status, tags = excluded.tags,
      removed_at = case when excluded.status = 'removed' then coalesce(listings.removed_at, now()) else null end,
      updated_at = now()
  `
  return ref
}

/** Called by `publishSchedule` after a session's calendar event is written. */
export async function routeSessionListing(
  ctx: PublishContext,
  input: { sessionId: string; event: StrongRef; tags: string[] },
  results: PublishResult[],
): Promise<void> {
  const prior = await listingFor(ctx.event.id, input.event.uri)
  const routesNow = routesOnTags(input.tags, ctx.event.atproto_tags ?? [])
  const action = decideListingEdit({
    everListed: !!prior,
    isActivelyListed: prior?.status === 'listed',
    routesNow,
    cidChanged: !!prior && prior.subject_cid !== input.event.cid,
  })
  if (action === 'none') return
  await writeListing(ctx, results, {
    id: input.sessionId,
    subject: input.event,
    status: action === 'remove' ? 'removed' : 'listed',
    tags: normalizeTags(input.tags),
    origin: 'own',
    sessionId: input.sessionId,
    action: 'publish-listing',
    reason:
      action === 'create' ? 'list a scheduled session whose tags route on this gathering'
      : action === 'update' ? 're-pin a listing to the session\'s current calendar event'
      : 'the session no longer carries a routed tag; its listing is withdrawn (sticky)',
    prior,
  })
}

/** Steward restore of a removed listing (the only way back from a sticky removal). */
export async function restoreListing(input: { eventId: string; listingId: string; callerUserId: string }, deps?: PublishDeps): Promise<PublishResult[]> {
  const ctx = await loadPublishContext({ eventId: input.eventId, callerUserId: input.callerUserId }, deps)
  const [row] = await sql<ListingRow[]>`
    select id, event_id, session_id, subject_uri, subject_cid, origin, record_uri, record_cid, status, tags
    from listings where id = ${input.listingId} and event_id = ${input.eventId}
  `
  const results: PublishResult[] = []
  if (!row) return [{ kind: 'listing', id: input.listingId, error: 'listing not found in this event' }]
  if (row.status === 'listed') return [{ kind: 'listing', id: row.id, skipped: 'already-listed' }]
  await writeListing(ctx, results, {
    id: row.id,
    subject: { uri: row.subject_uri, cid: row.subject_cid },
    status: 'listed',
    tags: row.tags,
    origin: row.origin,
    sessionId: row.session_id,
    action: 'restore-listing',
    reason: 'steward restored a removed listing',
    prior: row,
  })
  return results
}

/** Applied by `approvals.ts` once the removal has its approvals. */
export async function applyListingRemoval(
  input: { eventId: string; listingId: string; callerUserId: string; approvals: Approval[]; reason: string },
  deps?: PublishDeps,
): Promise<PublishResult[]> {
  const ctx = await loadPublishContext({ eventId: input.eventId, callerUserId: input.callerUserId }, deps)
  const [row] = await sql<ListingRow[]>`
    select id, event_id, session_id, subject_uri, subject_cid, origin, record_uri, record_cid, status, tags
    from listings where id = ${input.listingId} and event_id = ${input.eventId}
  `
  const results: PublishResult[] = []
  if (!row) return [{ kind: 'listing', id: input.listingId, error: 'listing not found in this event' }]
  await writeListing(ctx, results, {
    id: row.id,
    subject: { uri: row.subject_uri, cid: row.subject_cid },
    status: 'removed',
    tags: row.tags,
    origin: row.origin,
    sessionId: row.session_id,
    action: 'remove-listing',
    reason: `moderation removal: ${input.reason}`.slice(0, 2000),
    prior: row,
    approvals: input.approvals,
  })
  return results
}

/* ─────────────────────────────── peers ─────────────────────────────── */

export interface PeerRow {
  peer_did: string
  label: string | null
  cross_listing_enabled: boolean
  created_at: string
}

export async function listPeers(eventId: string): Promise<PeerRow[]> {
  return sql<PeerRow[]>`
    select peer_did, label, cross_listing_enabled, created_at from peers where event_id = ${eventId} order by created_at
  `
}

export class PeerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'PeerError'
  }
}

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+(:[a-zA-Z0-9._%-]+)*)$/

async function requireSteward(eventId: string, callerUserId: string): Promise<void> {
  const [row] = await sql<{ role: string }[]>`select role from event_members where event_id = ${eventId} and user_id = ${callerUserId}`
  if (row?.role !== 'owner' && row?.role !== 'admin') throw new PeerError('Only an owner or admin can manage peers', 403)
}

/**
 * Add or update a peer. `peers` in `gathering@self` is a public statement of federation, so the
 * gathering record is re-published when the gathering is already on the network. Cross-listing
 * a peer's events onto our calendar stays OFF until `crossListingEnabled` is set.
 */
export async function upsertPeer(
  input: { eventId: string; callerUserId: string; peerDid: string; label?: string | null; crossListingEnabled?: boolean },
  deps?: PublishDeps,
): Promise<{ peer: PeerRow; results: PublishResult[] }> {
  await requireSteward(input.eventId, input.callerUserId)
  const did = input.peerDid.trim()
  if (!DID_RE.test(did)) throw new PeerError('A peer must be a did:plc or did:web identifier', 400)
  const [event] = await sql<{ actor_did: string | null; gathering_uri: string | null }[]>`select actor_did, gathering_uri from events where id = ${input.eventId}`
  if (event?.actor_did === did) throw new PeerError('A gathering cannot peer with itself', 400)
  const [peer] = await sql<PeerRow[]>`
    insert into peers (event_id, peer_did, label, cross_listing_enabled, added_by)
    values (${input.eventId}, ${did}, ${input.label?.trim().slice(0, 120) || null}, ${input.crossListingEnabled ?? false}, ${input.callerUserId})
    on conflict (event_id, peer_did) do update set
      label = coalesce(excluded.label, peers.label),
      cross_listing_enabled = coalesce(${input.crossListingEnabled ?? null}::boolean, peers.cross_listing_enabled),
      updated_at = now()
    returning peer_did, label, cross_listing_enabled, created_at
  `
  let results: PublishResult[] = []
  if (event?.actor_did && event.gathering_uri) {
    results = (await publishGathering({ eventId: input.eventId, callerUserId: input.callerUserId }, deps)).results
  }
  return { peer: peer!, results }
}

export async function removePeer(input: { eventId: string; callerUserId: string; peerDid: string }, deps?: PublishDeps): Promise<PublishResult[]> {
  await requireSteward(input.eventId, input.callerUserId)
  await sql`delete from peers where event_id = ${input.eventId} and peer_did = ${input.peerDid}`
  const [event] = await sql<{ actor_did: string | null; gathering_uri: string | null }[]>`select actor_did, gathering_uri from events where id = ${input.eventId}`
  if (!event?.actor_did || !event.gathering_uri) return []
  return (await publishGathering({ eventId: input.eventId, callerUserId: input.callerUserId }, deps)).results
}

/**
 * Cross-list peers' events (sync job, system caller). Candidates are calendar events AUTHORED by
 * an enabled peer, found in the index with a config whose tags route on ours and whose
 * visibility is `listed` (or unset). Sticky removal applies exactly as for our own sessions.
 */
export async function routePeerListings(eventId: string, deps?: PublishDeps): Promise<PublishResult[]> {
  const [event] = await sql<{ actor_did: string | null; atproto_tags: string[] | null; status: string }[]>`
    select actor_did, atproto_tags, status from events where id = ${eventId}
  `
  if (!event?.actor_did || !event.atproto_tags?.length || event.status === 'draft') return []
  const candidates = await sql<{ event_uri: string; event_cid: string | null; tags: string[] | null; visibility: string | null }[]>`
    select ev.uri as event_uri, ev.cid as event_cid,
           array(select jsonb_array_elements_text(coalesce(cfg.record -> 'tags', '[]'::jsonb))) as tags,
           cfg.record ->> 'visibility' as visibility
    from peers p
    join at_records ev on ev.did = p.peer_did and ev.collection = ${NSID.event}
    join at_records cfg on cfg.did = p.peer_did and cfg.collection = ${NSID.eventConfig}
                        and cfg.record -> 'event' ->> 'uri' = ev.uri
    where p.event_id = ${eventId} and p.cross_listing_enabled
      and not exists (select 1 from at_repo_status rs where rs.did = p.peer_did and rs.hidden)
    order by ev.indexed_at desc
    limit 500
  `
  if (!candidates.length) return []
  const ctx = await loadPublishContext({ eventId, callerUserId: null }, deps)
  const results: PublishResult[] = []
  for (const c of candidates) {
    if (!c.event_cid) continue
    if (c.visibility && c.visibility !== 'listed') continue
    const tags = normalizeTags(c.tags)
    const prior = await listingFor(eventId, c.event_uri)
    const action = decideListingEdit({
      everListed: !!prior,
      isActivelyListed: prior?.status === 'listed',
      routesNow: routesOnTags(tags, event.atproto_tags),
      cidChanged: !!prior && prior.subject_cid !== c.event_cid,
    })
    if (action === 'none') continue
    await writeListing(ctx, results, {
      id: c.event_uri,
      subject: { uri: c.event_uri, cid: c.event_cid },
      status: action === 'remove' ? 'removed' : 'listed',
      tags,
      origin: 'peer',
      sessionId: null,
      action: 'publish-listing',
      reason: action === 'remove' ? 'peer event no longer routes; listing withdrawn (sticky)' : 'cross-list an enabled peer\'s event whose tags route on this gathering',
      prior,
    })
  }
  return results
}
