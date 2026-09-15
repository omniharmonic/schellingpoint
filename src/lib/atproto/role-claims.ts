import 'server-only'
/**
 * Publishing a member's DERIVED role as a public `coop.lexicon.membership` claim — the ONE place
 * a person's role in a gathering reaches the protocol (spec §4.1, §10; Free School
 * `apps/appview/src/lib/membership-claims.ts`).
 *
 * THREE independent gates, ALL required:
 *   (a) the gathering's policy has `publishRoles === true` — an organiser's choice, off by default
 *   (b) the subject opted in for THIS gathering (`event_members.public_role`, package G's column)
 *   (c) the subject's derived role is Host (20) or above
 *
 * When all three hold, the gathering writes `{subject, role, school, addedBy}` through its actor
 * port with the subject as the caller (they consent to naming their own already-qualifying role).
 * The rkey is deterministic — `base32(sha256(gatheringDid \0 subjectDid))[0..13]` — so every
 * re-derivation updates the one record and a retraction deletes exactly that slot. Retraction
 * happens when the subject opts out, the role drops below Host, or the policy turns roles off.
 */
import { sql } from '@/lib/db'
import { readPolicyThresholds } from '@/lib/events/policy'
import { LADDER } from './actor'
import { actorForEvent, deriveGatheringRole } from './actors'
import { NSID } from './nsids'
import { assertNoForeignDid, buildMembershipRecord, membershipClaimRkey } from './records'
import { getRecord, isInvalidSwap } from './write'

export type RoleClaimOutcome = 'published' | 'retracted' | 'policy-off' | 'not-opted-in' | 'role-too-low' | 'not-linked' | 'unchanged'

export interface RoleClaimResult {
  outcome: RoleClaimOutcome
  role: number
  uri?: string
}

export class RoleClaimError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RoleClaimError'
  }
}

interface GateRow {
  actor_did: string | null
  policy_thresholds: unknown
  public_role: boolean | null
  subject_did: string | null
  record_uri: string | null
  record_cid: string | null
  published_role: number | null
}

async function gates(eventId: string, accountId: string): Promise<GateRow | null> {
  const [row] = await sql<GateRow[]>`
    select e.actor_did, e.policy_thresholds, m.public_role, a.did as subject_did,
           rc.record_uri, rc.record_cid, rc.published_role
    from events e
    join accounts a on a.id = ${accountId}
    left join event_members m on m.event_id = e.id and m.user_id = ${accountId}
    left join role_claims rc on rc.event_id = e.id and rc.account_id = ${accountId}
    where e.id = ${eventId}
  `
  return row ?? null
}

async function retract(eventId: string, accountId: string, row: GateRow, why: string): Promise<boolean> {
  if (!row.actor_did || !row.subject_did) return false
  const rkey = membershipClaimRkey(row.actor_did, row.subject_did)
  const live = row.record_uri ? { cid: row.record_cid } : await getRecord(row.actor_did, NSID.membership, rkey).catch(() => null)
  if (!live) {
    await sql`delete from role_claims where event_id = ${eventId} and account_id = ${accountId}`
    return false
  }
  const port = await actorForEvent(eventId)
  try {
    await port.deleteRecordAsGathering({
      callerUserId: null,
      action: 'retract-role-claim',
      collection: NSID.membership,
      rkey,
      reason: `retract a role claim: ${why}`,
    })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
  }
  await sql`delete from role_claims where event_id = ${eventId} and account_id = ${accountId}`
  return true
}

/**
 * Re-evaluate the three gates for one member and publish, update or retract accordingly.
 * Idempotent; call it after the opt-in changes, after a role re-derivation (a session scheduled
 * or cancelled), or after the policy's `publishRoles` flips.
 */
export async function syncRoleClaim(eventId: string, accountId: string): Promise<RoleClaimResult> {
  const row = await gates(eventId, accountId)
  if (!row) throw new RoleClaimError('Event or account not found', 404)
  const role = await deriveGatheringRole(eventId, accountId)
  if (!row.actor_did || !row.subject_did) return { outcome: 'not-linked', role }

  const thresholds = readPolicyThresholds(row.policy_thresholds)
  const blocked: RoleClaimOutcome | null = !thresholds.publishRoles
    ? 'policy-off'
    : !row.public_role
      ? 'not-opted-in'
      : role < LADDER.host
        ? 'role-too-low'
        : null
  if (blocked) {
    const retracted = await retract(eventId, accountId, row, blocked)
    return { outcome: retracted ? 'retracted' : blocked, role }
  }

  // Publishing a role claim at the ladder value: host 20 / facilitator 30 / steward 40.
  const ladder = role >= LADDER.steward ? LADDER.steward : role >= LADDER.facilitator ? LADDER.facilitator : LADDER.host
  if (row.record_uri && row.published_role === ladder) return { outcome: 'unchanged', role, uri: row.record_uri }

  const rkey = membershipClaimRkey(row.actor_did, row.subject_did)
  const record = buildMembershipRecord({ subjectDid: row.subject_did, role: ladder, gatheringDid: row.actor_did, createdAt: new Date() })
  // The single R9 exemption, asserted explicitly after all three gates held.
  assertNoForeignDid(record, row.actor_did, { gatheringDid: row.actor_did, consentedSubjectDid: row.subject_did })

  const port = await actorForEvent(eventId)
  const put = (swapRecord: string | null) =>
    port.putRecordAsGathering({
      callerUserId: accountId,
      action: 'publish-role-claim',
      collection: NSID.membership,
      rkey,
      record: record as unknown as Record<string, unknown>,
      swapRecord,
      reason: 'member opted in to publishing an already-qualifying role claim',
    })
  let res
  try {
    res = await put(row.record_cid ?? null)
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    const live = await getRecord(row.actor_did, NSID.membership, rkey)
    res = await put(live?.cid ?? null)
  }
  await sql`
    insert into role_claims (event_id, account_id, published_role, record_uri, record_cid)
    values (${eventId}, ${accountId}, ${ladder}, ${res.uri}, ${res.cid})
    on conflict (event_id, account_id) do update set
      published_role = excluded.published_role, record_uri = excluded.record_uri, record_cid = excluded.record_cid, updated_at = now()
  `
  return { outcome: 'published', role, uri: res.uri }
}

/**
 * The subject's own switch (package G calls this from the member settings API). Turning it OFF
 * retracts any published claim immediately — a claim that outlives its consent is exactly what
 * R9 forbids. Turning it ON publishes only when the other two gates already hold.
 */
export async function setRoleClaimOptIn(accountId: string, eventId: string, on: boolean): Promise<RoleClaimResult> {
  const updated = await sql`
    update event_members set public_role = ${on} where event_id = ${eventId} and user_id = ${accountId} returning id
  `
  if (updated.length === 0) throw new RoleClaimError('You are not a member of this gathering', 404)
  return syncRoleClaim(eventId, accountId)
}

/** After `publishRoles` flips or the schedule changes: re-evaluate every member who opted in or holds a claim. */
export async function syncRoleClaimsForEvent(eventId: string): Promise<Record<RoleClaimOutcome, number>> {
  const members = await sql<{ account_id: string }[]>`
    select user_id as account_id from event_members where event_id = ${eventId} and public_role
    union
    select account_id from role_claims where event_id = ${eventId}
  `
  const counts: Record<RoleClaimOutcome, number> = { published: 0, retracted: 0, 'policy-off': 0, 'not-opted-in': 0, 'role-too-low': 0, 'not-linked': 0, unchanged: 0 }
  for (const m of members) {
    try {
      counts[(await syncRoleClaim(eventId, m.account_id)).outcome]++
    } catch (e) {
      console.warn('[atproto:role-claims] sync failed for one member:', e instanceof Error ? e.name : 'error')
    }
  }
  return counts
}
