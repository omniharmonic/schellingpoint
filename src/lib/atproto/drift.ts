import 'server-only'
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
  kind: 'cid-drift' | 'withdrawn' | 'author-inactive'
  since: string
  proposalUri: string | null
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
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.withdrawn_at ? 'withdrawn' : r.inactive_at ? 'author-inactive' : 'cid-drift',
    since: (r.withdrawn_at ?? r.inactive_at ?? r.drift_at)!,
    proposalUri: r.proposal_uri,
  }))
}
