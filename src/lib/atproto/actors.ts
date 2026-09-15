import 'server-only'
/**
 * THE GATHERING ACTOR REGISTRY — one `GatheringActorPort` per gathering, and the one place a
 * gathering's credential is used in this process. Mirrors Free School
 * `apps/appview/src/lib/school-actors.ts` (multi-school design §5):
 *
 *   - credentials come from `at_credentials`: `app-password` for accounts we minted on our PDS
 *     (AES-256-GCM wrapped, custodied), `oauth` for an organiser's brought account (the stored
 *     OAuth session). Both are resolved by the shared W0 `agentForDid`.
 *   - ports are cached per gathering behind an LRU cap (64) and a TTL
 *     (`GATHERING_ACTOR_CACHE_TTL_MS`, default 30 min); a hit is touched so eviction is
 *     least-recently-used, not oldest-created
 *   - ISOLATION: the credential is resolved LAZILY inside the session. Building a port never
 *     touches the PDS, so a gathering whose credential is missing or revoked fails only its own
 *     writes, stamps `at_credentials.last_error*` and, after repeated authentication failures,
 *     `disabled_at` — which is what the organiser banner reads (`gatheringActorHealth`)
 *   - one re-login on `ExpiredToken` / 401; an authentication failure that survives the
 *     re-login evicts the port and the cached agent
 *
 * `configureGatheringActors()` is the test/script injection seam (fakes for the failure paths).
 */
import type { Agent } from '@atproto/api'
import { sql } from '@/lib/db'
import { mintGatheringIdentity } from '@/lib/events/identity'
import { readPolicyThresholds } from '@/lib/events/policy'
import { agentForDid, evictAgent, isAuthExpiredError, NoActorCredentialError } from './agent'
import {
  AppCustodyGatheringActor,
  GatheringNotLinkedError,
  LADDER,
  type AuditRow,
  type AuditSink,
  type DeleteAsGatheringInput,
  type GatheringActorPort,
  type GatheringSession,
  type MemberRole,
  type PolicySource,
  type PutAsGatheringInput,
  type ReadYourWrites,
  type RoleSource,
  type WriteAsGatheringResult,
} from './actor'
import { forgetOwnRepo } from './identity'
import { deleteIndexedRecord, upsertIndexedRecord } from './index-store'
import { isInvalidSwap } from './write'

export { GatheringNotLinkedError, GatheringActionDeniedError } from './actor'

/* ─────────────────────────────── errors ─────────────────────────────── */

/** The gathering's credential is missing, revoked or disabled. Organisers must relink. */
export class GatheringCredentialError extends Error {
  readonly status = 503
  readonly code = 'GatheringCredentialUnavailable'
  constructor(
    readonly eventId: string,
    detail: string,
  ) {
    super(`the gathering cannot write to its repo right now: ${detail}`)
    this.name = 'GatheringCredentialError'
  }
}

/** Authentication failures before a credential is disabled (transport failures never count). */
export const DISABLE_AFTER_AUTH_FAILURES = 3

/* ─────────────────────────────── Postgres deps ─────────────────────────────── */

export class PostgresAuditSink implements AuditSink {
  async write(row: AuditRow): Promise<string> {
    const [inserted] = await sql<{ id: string }[]>`
      insert into at_audit (event_id, actor_did, caller_user_id, action, collection, rkey, uri, decision, reason, approvals, policy_source)
      values (
        ${row.eventId}, ${row.actorDid}, ${row.callerUserId}, ${row.action}, ${row.collection}, ${row.rkey}, ${row.uri},
        ${row.decision}, ${row.reason}, ${sql.json(row.approvals as never)}, ${row.policySource}
      )
      returning id
    `
    return inserted!.id
  }

  async amend(auditId: string, suffix: string): Promise<void> {
    await sql`update at_audit set reason = left(reason || ' — ' || ${suffix}, 2000) where id = ${auditId}`
  }
}

/** Appointed role from `event_members`; derived ladder adds hosting evidence. */
export const postgresRoles: RoleSource = {
  async appointedRole(eventId, accountId) {
    const rows = await sql<{ role: MemberRole }[]>`
      select role from event_members where event_id = ${eventId} and user_id = ${accountId}
    `
    return rows[0]?.role ?? null
  },
  async derivedRole(eventId, accountId) {
    return deriveGatheringRole(eventId, accountId)
  },
  async accountDid(accountId) {
    const rows = await sql<{ did: string }[]>`select did from accounts where id = ${accountId}`
    return rows[0]?.did ?? null
  },
  async publicRoleOptIn(eventId, accountId) {
    const rows = await sql<{ public_role: boolean }[]>`
      select public_role from event_members where event_id = ${eventId} and user_id = ${accountId}
    `
    return rows[0]?.public_role === true
  },
}

/**
 * `deriveRole()` over this gathering's evidence (spec §3 "derived reputation"): appointed
 * owner/admin → steward 40; moderator / track lead → facilitator 30; hosted or co-hosted a
 * session that is on the schedule → host 20; any membership → member 10; otherwise 0.
 */
export async function deriveGatheringRole(eventId: string, accountId: string): Promise<number> {
  const [row] = await sql<{ role: MemberRole | null; hosted: boolean }[]>`
    select
      (select role from event_members where event_id = ${eventId} and user_id = ${accountId}) as role,
      exists (
        select 1 from sessions s
        where s.event_id = ${eventId} and s.status = 'scheduled' and s.cancelled_at is null
          and (s.host_id = ${accountId}
               or exists (select 1 from session_cohosts c where c.session_id = s.id and c.user_id = ${accountId}))
      ) as hosted
  `
  const role = row?.role ?? null
  if (role === 'owner' || role === 'admin') return LADDER.steward
  if (role === 'moderator' || role === 'track_lead') return LADDER.facilitator
  if (row?.hosted) return LADDER.host
  return role ? LADDER.member : LADDER.visitor
}

async function thresholdsOf(eventId: string) {
  const [row] = await sql<{ policy_thresholds: unknown }[]>`select policy_thresholds from events where id = ${eventId}`
  return readPolicyThresholds(row?.policy_thresholds)
}

export const postgresPolicy: PolicySource = {
  async destructiveActionStewards(eventId) {
    return (await thresholdsOf(eventId)).destructiveActionStewards
  },
  async publishRoles(eventId) {
    return (await thresholdsOf(eventId)).publishRoles
  },
}

const postgresIndex: ReadYourWrites = {
  upsert: (input) => upsertIndexedRecord(input),
  remove: (uri) => deleteIndexedRecord(uri),
}

/* ─────────────────────────────── credential health ─────────────────────────────── */

async function recordSuccess(did: string): Promise<void> {
  await sql`
    update at_credentials set last_ok_at = now(), last_error = null, consecutive_failures = 0 where did = ${did}
  `.catch(() => undefined)
}

async function recordFailure(did: string, detail: string, auth: boolean): Promise<void> {
  await sql`
    update at_credentials set
      last_error_at = now(),
      last_error = ${detail.slice(0, 500)},
      consecutive_failures = case when ${auth} then consecutive_failures + 1 else consecutive_failures end,
      disabled_at = case
        when ${auth} and consecutive_failures + 1 >= ${DISABLE_AFTER_AUTH_FAILURES} then coalesce(disabled_at, now())
        else disabled_at
      end
    where did = ${did}
  `.catch(() => undefined)
}

function isAuthFailure(e: unknown): boolean {
  if (e instanceof NoActorCredentialError) return true
  if (isAuthExpiredError(e)) return true
  const err = e as { status?: number; error?: string; message?: string } | undefined
  return (
    err?.error === 'AuthenticationRequired' ||
    err?.error === 'AccountTakedown' ||
    err?.error === 'AccountDeactivated' ||
    /invalid identifier or password/i.test(err?.message ?? '')
  )
}

/* ─────────────────────────────── the session ─────────────────────────────── */

/**
 * Repo writes with ONE gathering's credential. Lazily logs in, retries once with a fresh login
 * on an expired/invalid token, and never hands its agent out.
 */
export class CredentialGatheringSession implements GatheringSession {
  private agent: Agent | undefined

  constructor(
    private readonly eventId: string,
    private readonly did: string,
  ) {}

  private async get(fresh = false): Promise<Agent> {
    if (this.agent && !fresh) return this.agent
    const [cred] = await sql<{ disabled_at: string | null }[]>`select disabled_at from at_credentials where did = ${this.did}`
    if (cred?.disabled_at) {
      throw new GatheringCredentialError(this.eventId, 'the credential was disabled after repeated authentication failures; an organiser must reconnect it')
    }
    this.agent = await agentForDid(this.did, { fresh })
    return this.agent
  }

  private async run<T>(fn: (agent: Agent) => Promise<T>): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        const out = await fn(await this.get(attempt > 0))
        if (attempt > 0) await recordSuccess(this.did)
        return out
      } catch (e) {
        if (e instanceof GatheringCredentialError) throw e
        if (isInvalidSwap(e)) throw e // a CAS answer, not a credential problem
        const auth = isAuthFailure(e)
        if (auth && attempt === 0) {
          attempt++
          this.agent = undefined
          evictAgent(this.did)
          continue
        }
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        await recordFailure(this.did, detail, auth)
        if (auth) {
          // Persistent authentication failure: forget everything cached for this gathering.
          this.agent = undefined
          evictAgent(this.did)
          evictGatheringActor(this.eventId)
          throw new GatheringCredentialError(this.eventId, 'authentication with the PDS failed')
        }
        throw e
      }
    }
  }

  async putRecord(input: { collection: string; rkey: string; record: Record<string, unknown>; swapRecord?: string | null }) {
    return this.run(async (agent) => {
      const res = await agent.com.atproto.repo.putRecord({
        repo: this.did,
        collection: input.collection,
        rkey: input.rkey,
        record: input.record,
        // Our lexicons are unpublished; `actor.ts` validated locally before we got here.
        validate: false,
        ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
      })
      return { uri: res.data.uri, cid: res.data.cid }
    })
  }

  async deleteRecord(input: { collection: string; rkey: string; swapRecord?: string }) {
    await this.run(async (agent) => {
      await agent.com.atproto.repo.deleteRecord({
        repo: this.did,
        collection: input.collection,
        rkey: input.rkey,
        ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
      })
    })
  }
}

/* ─────────────────────────────── the registry ─────────────────────────────── */

export interface GatheringActorOverrides {
  sessionFor?: (eventId: string, did: string) => GatheringSession
  audit?: AuditSink
  roles?: RoleSource
  policy?: PolicySource
  index?: ReadYourWrites | null
  actorDidFor?: (eventId: string) => Promise<string>
}

let overrides: GatheringActorOverrides = {}

const ports = new Map<string, { port: GatheringActorPort; at: number }>()
export const GATHERING_ACTOR_CACHE_CAP = 64

function ttlMs(): number {
  const v = Number(process.env.GATHERING_ACTOR_CACHE_TTL_MS)
  return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000
}

/** `events.actor_did` or `GatheringNotLinkedError`. */
export async function actorDidForEvent(eventId: string): Promise<string> {
  if (overrides.actorDidFor) return overrides.actorDidFor(eventId)
  const [row] = await sql<{ actor_did: string | null }[]>`select actor_did from events where id = ${eventId}`
  if (!row?.actor_did) throw new GatheringNotLinkedError(eventId)
  return row.actor_did
}

function buildPort(eventId: string, did: string): GatheringActorPort {
  return new AppCustodyGatheringActor(eventId, did, {
    roles: overrides.roles ?? postgresRoles,
    policy: overrides.policy ?? postgresPolicy,
    audit: overrides.audit ?? new PostgresAuditSink(),
    session: overrides.sessionFor ? overrides.sessionFor(eventId, did) : new CredentialGatheringSession(eventId, did),
    index: overrides.index === null ? undefined : (overrides.index ?? postgresIndex),
  })
}

/**
 * The port this gathering writes through. The actor DID is re-read on a cache miss, and a
 * cached port whose DID no longer matches the event (relinked account) is rebuilt.
 */
export async function actorForEvent(eventId: string): Promise<GatheringActorPort> {
  const did = await actorDidForEvent(eventId)
  const hit = ports.get(eventId)
  if (hit && hit.port.actorDid === did && Date.now() - hit.at < ttlMs()) {
    ports.delete(eventId)
    ports.set(eventId, hit)
    return hit.port
  }
  const port = buildPort(eventId, did)
  ports.delete(eventId)
  if (ports.size >= GATHERING_ACTOR_CACHE_CAP) {
    const lru = ports.keys().next().value
    if (lru !== undefined) ports.delete(lru)
  }
  ports.set(eventId, { port, at: Date.now() })
  return port
}

/** Drop one gathering's cached port — rotation, relink, archival, persistent auth failure. */
export function evictGatheringActor(eventId: string): void {
  ports.delete(eventId)
}

export function evictAllGatheringActors(): void {
  ports.clear()
}

/** Number of cached ports (tests assert the LRU cap). */
export function cachedGatheringActorCount(): number {
  return ports.size
}

/** Test and script injection seam. Clears the cache so the next lookup uses the new wiring. */
export function configureGatheringActors(next: GatheringActorOverrides = {}): void {
  overrides = next
  ports.clear()
}

/* ─────────────────────────────── convenience writers ─────────────────────────────── */

/** Write as the gathering of `input.eventId`. */
export async function putRecordAsGathering(input: PutAsGatheringInput): Promise<WriteAsGatheringResult> {
  const { eventId, ...rest } = input
  return (await actorForEvent(eventId)).putRecordAsGathering(rest)
}

export async function deleteRecordAsGathering(input: DeleteAsGatheringInput): Promise<{ auditId: string }> {
  const { eventId, ...rest } = input
  return (await actorForEvent(eventId)).deleteRecordAsGathering(rest)
}

/* ─────────────────────────────── mint and health ─────────────────────────────── */

/**
 * Mint the gathering's DID on our PDS (idempotent) and store `events.actor_did/actor_handle`
 * plus an `at_audit` row. Delegates to package A's `mintGatheringIdentity`, which serialises
 * per event and wraps the shared W0 `mintGatheringAccount`; this wrapper keeps the registry
 * consistent (a relinked DID must not be served from a stale port).
 */
export async function mintGatheringActor(eventId: string, callerUserId: string): Promise<{ did: string; handle: string; minted: boolean }> {
  const out = await mintGatheringIdentity(eventId, callerUserId)
  evictGatheringActor(eventId)
  forgetOwnRepo(out.did)
  return out
}

export type GatheringActorHealthState = 'unlinked' | 'ok' | 'failing' | 'disabled'

export interface GatheringActorHealth {
  state: GatheringActorHealthState
  actorDid: string | null
  actorHandle: string | null
  credentialKind: 'app-password' | 'oauth' | null
  lastOkAt: string | null
  lastErrorAt: string | null
  /** Organiser-facing; never contains the credential. */
  banner: string | null
}

/** What the organiser banner shows. `failing` = the latest attempt failed; `disabled` = writes stopped. */
export async function gatheringActorHealth(eventId: string): Promise<GatheringActorHealth> {
  const [row] = await sql<{
    actor_did: string | null
    actor_handle: string | null
    kind: 'app-password' | 'oauth' | null
    last_ok_at: string | null
    last_error_at: string | null
    disabled_at: string | null
    consecutive_failures: number | null
  }[]>`
    select e.actor_did, e.actor_handle, c.kind, c.last_ok_at, c.last_error_at, c.disabled_at, c.consecutive_failures
    from events e left join at_credentials c on c.did = e.actor_did
    where e.id = ${eventId}
  `
  if (!row?.actor_did) {
    return { state: 'unlinked', actorDid: null, actorHandle: null, credentialKind: null, lastOkAt: null, lastErrorAt: null, banner: null }
  }
  const failing = !!row.last_error_at && (!row.last_ok_at || row.last_error_at > row.last_ok_at)
  const state: GatheringActorHealthState = row.disabled_at ? 'disabled' : failing ? 'failing' : 'ok'
  const banner =
    state === 'disabled'
      ? 'This gathering can no longer publish to the network: its account credential was rejected repeatedly. Reconnect the gathering account to resume publishing.'
      : state === 'failing'
        ? 'The last attempt to publish as this gathering failed. Publishing will retry; if it keeps failing, reconnect the gathering account.'
        : null
  return {
    state,
    actorDid: row.actor_did,
    actorHandle: row.actor_handle,
    credentialKind: row.kind ?? (row.actor_did ? 'oauth' : null),
    lastOkAt: row.last_ok_at,
    lastErrorAt: row.last_error_at,
    banner,
  }
}

/** An organiser reconnected or rotated the credential: clear the disable flag and caches. */
export async function resetGatheringCredential(eventId: string): Promise<void> {
  const did = await actorDidForEvent(eventId)
  await sql`update at_credentials set disabled_at = null, consecutive_failures = 0 where did = ${did}`
  evictAgent(did)
  evictGatheringActor(eventId)
}
