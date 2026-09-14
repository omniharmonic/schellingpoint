import 'server-only'
/**
 * GatheringActorPort — the ONE chokepoint for every write made AS THE GATHERING.
 *
 * Port of Free School's `packages/school-actor` (`port.ts` + `app-custody.ts`)
 * onto Supabase. Invariants:
 *   - the caller is authorised against `event_members` before anything else
 *   - destructive actions (`DESTRUCTIVE_ACTIONS`) need owner/admin
 *   - the record is lexicon-validated AND R9-checked before it leaves
 *   - an `at_audit` row is written on EVERY call, allow or deny
 *   - the gathering's agent is obtained here and nowhere else
 *
 * Nothing else in the codebase may write to a gathering's repo.
 */
import { createAdminClient } from '@/lib/supabase/server'
import { withAgentForDid } from './agent'
import { assertNoForeignDid } from './records'
import { assertValidRecord } from './validate'
import { deleteRecord, putRecord, uriFor } from './write'

export type GatheringAction =
  | 'publish-gathering'
  | 'publish-policy'
  | 'publish-venue'
  | 'publish-track'
  | 'publish-slot-grid'
  | 'publish-event'
  | 'publish-slot'
  | 'publish-tally'
  | 'publish-listing'
  | 'publish-stub-proposal'
  | 'publish-role-claim'
  | 'retract-role-claim'
  | 'cancel-slot'
  | 'move-slot'
  | 'remove-listing'
  | 'delete-record'

/** Owner/admin only; re-publishing or removing something people already rely on. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<GatheringAction> = new Set<GatheringAction>([
  'cancel-slot',
  'move-slot',
  'remove-listing',
  'delete-record',
])

export type MemberRole = 'owner' | 'admin' | 'moderator' | 'track_lead' | 'volunteer' | 'attendee'

export class GatheringNotLinkedError extends Error {
  constructor(readonly eventId: string) {
    super(`event ${eventId} has no gathering actor (events.actor_did is null)`)
    this.name = 'GatheringNotLinkedError'
  }
}

export class GatheringActionDeniedError extends Error {
  readonly status = 403
  constructor(
    readonly action: GatheringAction,
    readonly reason: string,
    readonly auditId: string,
  ) {
    super(`${action} denied: ${reason}`)
    this.name = 'GatheringActionDeniedError'
  }
}

export interface AuthorizeInput {
  eventId: string
  /** Supabase user id. `null` marks a trusted server-side job (migration, cron) — never a request. */
  callerUserId: string | null
  action: GatheringAction
}

export interface AuthorizeResult {
  allowed: boolean
  role: MemberRole | 'system' | null
  reason: string
  actorDid: string
}

interface CommonInput {
  eventId: string
  callerUserId: string | null
  action: GatheringAction
  collection: string
  rkey: string
  /** Mandatory written reason; lands in `at_audit.reason`. */
  reason: string
}

export interface PutAsGatheringInput extends CommonInput {
  record: Record<string, unknown>
  swapRecord?: string | null
}

export interface DeleteAsGatheringInput extends CommonInput {
  swapRecord?: string
}

async function actorDidFor(eventId: string): Promise<string> {
  const db = await createAdminClient()
  const { data, error } = await db.from('events').select('actor_did').eq('id', eventId).maybeSingle()
  if (error) throw new Error(`events get: ${error.message}`)
  const did = (data?.actor_did as string | null) ?? null
  if (!did) throw new GatheringNotLinkedError(eventId)
  return did
}

async function roleOf(eventId: string, userId: string): Promise<MemberRole | null> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('event_members')
    .select('role')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`event_members get: ${error.message}`)
  return (data?.role as MemberRole | null) ?? null
}

function decide(role: MemberRole | 'system' | null, action: GatheringAction): { allowed: boolean; reason: string } {
  if (role === 'system') return { allowed: true, reason: 'ok (system job)' }
  if (!role) return { allowed: false, reason: 'caller is not a member of this event' }
  if (role === 'owner' || role === 'admin') return { allowed: true, reason: 'ok' }
  if (DESTRUCTIVE_ACTIONS.has(action)) {
    return { allowed: false, reason: `${action} is destructive and requires owner or admin; caller is ${role}` }
  }
  if (role === 'moderator' && action.startsWith('publish-')) return { allowed: true, reason: 'ok' }
  return { allowed: false, reason: `${action} requires owner, admin or moderator; caller is ${role}` }
}

/** Pure authorisation, no side effects. Throws `GatheringNotLinkedError`. */
export async function authorizeGatheringAction(input: AuthorizeInput): Promise<AuthorizeResult> {
  const actorDid = await actorDidFor(input.eventId)
  const role: MemberRole | 'system' | null =
    input.callerUserId === null ? 'system' : await roleOf(input.eventId, input.callerUserId)
  const { allowed, reason } = decide(role, input.action)
  return { allowed, role, reason, actorDid }
}

async function writeAudit(row: {
  eventId: string
  actorDid: string
  callerUserId: string | null
  action: GatheringAction
  collection: string
  rkey: string
  uri: string | null
  decision: 'allow' | 'deny'
  reason: string
}): Promise<string> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('at_audit')
    .insert({
      event_id: row.eventId,
      actor_did: row.actorDid,
      caller_user_id: row.callerUserId,
      action: row.action,
      collection: row.collection,
      rkey: row.rkey,
      uri: row.uri,
      decision: row.decision,
      reason: row.reason,
    })
    .select('id')
    .single()
  if (error) throw new Error(`at_audit insert: ${error.message}`)
  return data.id as string
}

async function amendAudit(auditId: string, suffix: string): Promise<void> {
  const db = await createAdminClient()
  const { data } = await db.from('at_audit').select('reason').eq('id', auditId).maybeSingle()
  await db
    .from('at_audit')
    .update({ reason: `${(data?.reason as string | undefined) ?? ''} — ${suffix}`.slice(0, 2000) })
    .eq('id', auditId)
}

async function gate(input: CommonInput, uri: string): Promise<{ actorDid: string; auditId: string }> {
  if (!input.reason?.trim()) throw new Error('a written reason is mandatory for every gathering-actor call')
  const authz = await authorizeGatheringAction(input)
  const base = {
    eventId: input.eventId,
    actorDid: authz.actorDid,
    callerUserId: input.callerUserId,
    action: input.action,
    collection: input.collection,
    rkey: input.rkey,
    uri,
  }
  if (!authz.allowed) {
    const auditId = await writeAudit({ ...base, decision: 'deny', reason: authz.reason })
    throw new GatheringActionDeniedError(input.action, authz.reason, auditId)
  }
  const auditId = await writeAudit({ ...base, decision: 'allow', reason: input.reason.trim() })
  return { actorDid: authz.actorDid, auditId }
}

/**
 * Write a record into the gathering's repo. Validates against the lexicon and
 * the R9 invariant (the record may name the gathering's own DID and at-uri
 * references, nothing else) before authorising and writing.
 */
export async function putRecordAsGathering(
  input: PutAsGatheringInput,
): Promise<{ uri: string; cid: string; auditId: string }> {
  const actorDid = await actorDidFor(input.eventId)
  const record = { ...input.record, $type: input.collection }
  assertValidRecord(input.collection, record)
  assertNoForeignDid(record, actorDid, { gatheringDid: actorDid })

  const uri = uriFor({ repo: actorDid, collection: input.collection, rkey: input.rkey })
  const { auditId } = await gate(input, uri)
  try {
    const res = await withAgentForDid(actorDid, (agent) =>
      putRecord(agent, {
        repo: actorDid,
        collection: input.collection,
        rkey: input.rkey,
        record,
        ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
      }),
    )
    return { ...res, auditId }
  } catch (e) {
    await amendAudit(auditId, `write failed: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
}

export async function deleteRecordAsGathering(input: DeleteAsGatheringInput): Promise<{ auditId: string }> {
  const actorDid = await actorDidFor(input.eventId)
  const uri = uriFor({ repo: actorDid, collection: input.collection, rkey: input.rkey })
  const { auditId } = await gate(input, uri)
  try {
    await withAgentForDid(actorDid, (agent) =>
      deleteRecord(agent, {
        repo: actorDid,
        collection: input.collection,
        rkey: input.rkey,
        ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
      }),
    )
    return { auditId }
  } catch (e) {
    await amendAudit(auditId, `delete failed: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
}

/** The port as an object, for call sites that want to inject it. */
export const gatheringActorPort = {
  authorize: authorizeGatheringAction,
  putRecordAsGathering,
  deleteRecordAsGathering,
} as const

export type GatheringActorPort = typeof gatheringActorPort
