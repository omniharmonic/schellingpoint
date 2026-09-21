import 'server-only'
import { isLatLng, parseLatLng, roundCoarse } from '@/lib/geo/coarse'
/**
 * The two conflicts the record model makes possible (spec §6 "Conflicts"):
 *
 *   cid drift    the proposer rewrote their proposal after a published slot pinned it. The slot's
 *                strongRef still names the accepted version; the organisers see "the proposer
 *                edited this session; review and re-publish". Re-publishing the schedule re-pins
 *                the slot and clears the flag.
 *   withdrawal   the proposer deleted their record. The slot is orphaned; the organisers must
 *                cancel or re-fill it. We never resurrect someone else's record and never change
 *                the schedule automatically.
 *
 * Both set a flag on `sessions` (surfaced on the admin ATProto page) and notify the gathering's
 * owners/admins ONCE per new cid / per withdrawal (`proposal_changed`).
 */
import { sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { NSID } from './nsids'

interface DriftRow {
  id: string
  event_id: string
  title: string
  slug: string
  slot_uri: string | null
  proposal_drift_cid: string | null
  proposal_withdrawn_at: string | null
  status: string | null
}

async function organizers(eventId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select user_id from event_members where event_id = ${eventId} and role in ('owner', 'admin')
  `
  return rows.map((r) => r.user_id)
}

/** The proposal cid a published slot pins, from the index (read-your-writes) or null. */
async function pinnedCid(slotUri: string): Promise<string | null> {
  const [row] = await sql<{ cid: string | null }[]>`
    select record -> 'proposal' ->> 'cid' as cid from at_records where uri = ${slotUri} and collection = ${NSID.slot}
  `
  return row?.cid ?? null
}

export type DriftOutcome = 'not-published' | 'in-sync' | 'flagged' | 'already-flagged' | 'cleared'

/**
 * Compare the proposer's current cid with the one the session's published slot pins, and flag
 * (or clear) the drift. Idempotent: the notification fires only when the drifted cid is new.
 */
export async function checkProposalDrift(input: { sessionId: string; currentCid: string }): Promise<DriftOutcome> {
  const [s] = await sql<DriftRow[]>`
    select s.id, s.event_id, s.title, e.slug, s.slot_uri, s.proposal_drift_cid, s.proposal_withdrawn_at, s.status
    from sessions s join events e on e.id = s.event_id where s.id = ${input.sessionId}
  `
  if (!s?.slot_uri) return 'not-published'
  const pinned = await pinnedCid(s.slot_uri)
  if (!pinned) return 'not-published'
  if (pinned === input.currentCid) {
    if (!s.proposal_drift_cid) return 'in-sync'
    await sql`update sessions set proposal_drift_cid = null, proposal_drift_at = null where id = ${s.id}`
    return 'cleared'
  }
  if (s.proposal_drift_cid === input.currentCid) return 'already-flagged'
  await sql.begin(async (t) => {
    await t`update sessions set proposal_drift_cid = ${input.currentCid}, proposal_drift_at = now() where id = ${s.id}`
    const recipients = await organizers(s.event_id)
    try {
      await t.savepoint((sp) =>
        notify(sp, {
          eventId: s.event_id,
          userIds: recipients,
          type: 'proposal_changed',
          title: `The proposer edited “${s.title}”`,
          body: 'This session is on the published schedule, which still shows the version you accepted. Review the change and re-publish the schedule to adopt it.',
          actionUrl: `/e/${s.slug}/admin/atproto#drift`,
          data: { sessionId: s.id, kind: 'cid-drift' },
        }),
      )
    } catch (e) {
      console.warn('[atproto:drift] notification not written:', e instanceof Error ? e.name : 'error')
    }
  })
  return 'flagged'
}

/**
 * The proposer deleted their record. Flag once; notify the organisers when the session is
 * scheduled or on the published schedule. Never deletes or changes the schedule.
 */
export async function flagProposalWithdrawn(input: { sessionId: string }): Promise<'flagged' | 'already-flagged'> {
  const [s] = await sql<DriftRow[]>`
    select s.id, s.event_id, s.title, e.slug, s.slot_uri, s.proposal_drift_cid, s.proposal_withdrawn_at, s.status
    from sessions s join events e on e.id = s.event_id where s.id = ${input.sessionId}
  `
  if (!s) return 'already-flagged'
  if (s.proposal_withdrawn_at) return 'already-flagged'
  await sql.begin(async (t) => {
    await t`update sessions set proposal_withdrawn_at = now(), proposal_drift_cid = null, proposal_drift_at = null where id = ${s.id}`
    if (s.slot_uri || s.status === 'scheduled') {
      const recipients = await organizers(s.event_id)
      try {
        await t.savepoint((sp) =>
          notify(sp, {
            eventId: s.event_id,
            userIds: recipients,
            type: 'proposal_changed',
            title: `The proposer withdrew “${s.title}”`,
            body: 'Their proposal record is gone. The schedule was not changed: cancel the session or give its slot to another proposal.',
            actionUrl: `/e/${s.slug}/admin/atproto#drift`,
            data: { sessionId: s.id, kind: 'withdrawn' },
          }),
        )
      } catch (e) {
        console.warn('[atproto:drift] notification not written:', e instanceof Error ? e.name : 'error')
      }
    }
  })
  return 'flagged'
}

export interface FlaggedSession {
  id: string
  title: string
  kind: 'cid-drift' | 'withdrawn' | 'author-inactive' | 'location-changed'
  since: string
  proposalUri: string | null
}

interface LocationRow {
  id: string
  title: string
  updated_at: string
  is_self_hosted: boolean | null
  public_geo: { lat: number; lng: number } | null
  venue_latitude: number | null
  venue_longitude: number | null
  venue_private: boolean | null
  venue_geocoded_at: string | null
  record: Record<string, unknown> | null
}

/** The geo a published calendar event carries, as "lat,lng" strings (there is at most one). */
function recordGeo(record: Record<string, unknown> | null): string | null {
  const locations = Array.isArray(record?.locations) ? (record!.locations as Array<Record<string, unknown>>) : []
  const geo = locations.find((l) => l.$type === NSID.locationGeo)
  if (!geo) return null
  const lat = Number(geo.latitude)
  const lng = Number(geo.longitude)
  return Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : null
}

/** The geo the event SHOULD carry now (spec §8.1), same rules as `publish.ts`. */
function expectedGeo(row: LocationRow): string | null {
  if (row.is_self_hosted) {
    const c = parseLatLng(row.public_geo)
    if (!c) return null
    const r = roundCoarse(c.lat, c.lng)
    return `${r.lat},${r.lng}`
  }
  if (row.venue_private || !isLatLng(row.venue_latitude, row.venue_longitude)) return null
  return `${row.venue_latitude},${row.venue_longitude}`
}

/**
 * Published sessions whose indexed calendar event carries a different location than the app
 * would publish now (a self-hosted pin corrected, a room's point moved, a private-residence flag
 * flipped): the post-commit refresh failed or was never run. Organisers re-publish from the
 * Network page.
 */
export async function locationChangedSessions(eventId: string): Promise<FlaggedSession[]> {
  const rows = await sql<LocationRow[]>`
    select s.id, s.title, s.updated_at, s.is_self_hosted, s.public_geo,
           v.latitude::float8 as venue_latitude, v.longitude::float8 as venue_longitude,
           v.is_private_residence as venue_private, v.geocoded_at as venue_geocoded_at,
           r.record
    from sessions s
    left join time_slots t on t.id = s.time_slot_id and t.event_id = s.event_id
    left join venues v on v.id = coalesce(s.venue_id, t.venue_id) and v.event_id = s.event_id
    left join at_records r on r.uri = s.calendar_event_uri
    where s.event_id = ${eventId} and s.calendar_event_uri is not null and s.cancelled_at is null and s.status = 'scheduled'
  `
  const out: FlaggedSession[] = []
  for (const row of rows) {
    if (!row.record) continue // not indexed yet: nothing to compare against
    if (recordGeo(row.record) === expectedGeo(row)) continue
    const since = row.venue_geocoded_at && row.venue_geocoded_at > row.updated_at ? row.venue_geocoded_at : row.updated_at
    out.push({ id: row.id, title: row.title, kind: 'location-changed', since, proposalUri: null })
  }
  return out
}

/** For the admin ATProto page: sessions needing an organiser's review. */
export async function flaggedSessions(eventId: string): Promise<FlaggedSession[]> {
  const rows = await sql<{ id: string; title: string; drift_at: string | null; withdrawn_at: string | null; inactive_at: string | null; proposal_uri: string | null }[]>`
    select id, title, proposal_drift_at as drift_at, proposal_withdrawn_at as withdrawn_at, author_inactive_at as inactive_at, proposal_uri
    from sessions
    where event_id = ${eventId}
      and (proposal_drift_cid is not null or proposal_withdrawn_at is not null
           -- an inactive author matters to organisers once the session is accepted
           or (author_inactive_at is not null and (status in ('approved', 'scheduled') or slot_uri is not null)))
    order by coalesce(proposal_withdrawn_at, author_inactive_at, proposal_drift_at) desc
  `
  const flagged: FlaggedSession[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.withdrawn_at ? 'withdrawn' : r.inactive_at ? 'author-inactive' : 'cid-drift',
    since: (r.withdrawn_at ?? r.inactive_at ?? r.drift_at)!,
    proposalUri: r.proposal_uri,
  }))
  const seen = new Set(flagged.map((f) => f.id))
  for (const f of await locationChangedSessions(eventId)) if (!seen.has(f.id)) flagged.push(f)
  return flagged
}
