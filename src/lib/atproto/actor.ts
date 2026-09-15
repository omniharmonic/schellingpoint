/**
 * GatheringActorPort — the ONE chokepoint for every write made AS A GATHERING.
 *
 * Port of Free School's `packages/school-actor` (`port.ts` + `app-custody.ts`), with `school`
 * renamed `gathering` and roles read from `event_members`. The body of every write mirrors the
 * Arbiter proxy on purpose, so a later custody swap is a no-op at call sites. Invariants:
 *
 *   1. nothing else in the codebase touches a gathering's credential or session
 *   2. a written reason is mandatory on every call and lands in `at_audit.reason`
 *   3. the record is lexicon-validated, sidecar-checked (borrowed lexicons carry no extra
 *      field) and R9-checked (it names no DID but the gathering's own) BEFORE authorisation
 *   4. authorisation: the caller's appointed role in THIS gathering; destructive actions also
 *      need `destructiveActionStewards` distinct organiser approvals, each backed by a
 *      `freeschool.draft.approval` record in that organiser's own repo
 *   5. an audit row on EVERY call, allow or deny, carrying the approvals
 *   6. CAS: `swapRecord` is sent only when the caller passed one (`null` = must not exist)
 *   7. read-your-writes: a successful write is upserted into `at_records` before returning
 *
 * This module is dependency-injected and has no I/O of its own; `actors.ts` wires the
 * Postgres audit sink, role and policy sources and the credential-backed session, and owns the
 * per-gathering registry. Not `server-only` so failure-path tests can drive the adapter with
 * fakes; nothing here can reach a credential without `actors.ts`.
 */
import { assertNoForeignDid } from './records'
import { isBorrowedNsid } from './nsids'
import { assertNoUnknownFields, assertValidRecord } from './validate'

const NSID_MEMBERSHIP = 'coop.lexicon.membership'

export type GatheringAction =
  | 'publish-gathering'
  | 'write-policy'
  | 'set-peers'
  | 'publish-venue'
  | 'publish-track'
  | 'publish-slot-grid'
  | 'publish-event'
  | 'publish-slot'
  | 'publish-tally'
  | 'publish-listing'
  | 'publish-stub-proposal'
  | 'publish-series'
  | 'publish-occurrence'
  | 'publish-role-claim'
  | 'retract-role-claim'
  | 'cancel-slot'
  | 'move-slot'
  | 'remove-listing'
  | 'restore-listing'
  | 'delete-record'
  /** Legacy name kept for `tally.ts` (package C): same gate as `write-policy`. */
  | 'publish-policy'

/**
 * Re-publishing or removing something people already rely on. Each needs the policy's
 * `destructiveActionStewards` organiser approvals (default 2). `write-policy` is NOT here, for
 * Free School's reason: a gathering with one organiser must still be able to write its rules;
 * policy writes stay audited and the record is public.
 */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<GatheringAction> = new Set<GatheringAction>([
  'cancel-slot',
  'move-slot',
  'remove-listing',
  'delete-record',
])

export type MemberRole = 'owner' | 'admin' | 'moderator' | 'track_lead' | 'volunteer' | 'attendee'

/** The ladder role claims publish and the port compares against. */
export const LADDER = { visitor: 0, member: 10, host: 20, facilitator: 30, steward: 40 } as const

const STEWARD_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>(['owner', 'admin'])

/** What each action needs. `steward` = owner/admin of this gathering; `host` = derived role ≥ 20. */
const MIN_ROLE: Record<GatheringAction, 'steward' | 'host' | 'any'> = {
  'publish-gathering': 'steward',
  'write-policy': 'steward',
  'publish-policy': 'steward',
  'set-peers': 'steward',
  'publish-venue': 'steward',
  'publish-track': 'steward',
  'publish-slot-grid': 'steward',
  'publish-event': 'steward',
  'publish-slot': 'steward',
  'publish-tally': 'steward',
  'publish-listing': 'steward',
  'publish-stub-proposal': 'steward',
  'publish-series': 'steward',
  'publish-occurrence': 'steward',
  'restore-listing': 'steward',
  // The subject publishing their own already-qualifying role (Free School MIN_ROLE: Host).
  'publish-role-claim': 'host',
  // Retracting a naming one consented to can never need a higher bar than publishing it.
  'retract-role-claim': 'any',
  'cancel-slot': 'steward',
  'move-slot': 'steward',
  'remove-listing': 'steward',
  'delete-record': 'steward',
}

export class GatheringNotLinkedError extends Error {
  readonly status = 409
  constructor(readonly eventId: string) {
    super(`event ${eventId} has no gathering actor (events.actor_did is null)`)
    this.name = 'GatheringNotLinkedError'
  }
}

export type DenyCode = 'ErrPermissionDenied' | 'ErrThresholdNotMet'

export class GatheringActionDeniedError extends Error {
  readonly status = 403
  constructor(
    readonly action: GatheringAction,
    readonly reason: string,
    readonly auditId: string,
    readonly code: DenyCode = 'ErrPermissionDenied',
  ) {
    super(`${action} denied: ${reason}`)
    this.name = 'GatheringActionDeniedError'
  }
}

/** An organiser's approval of a destructive action, backed by a record in their own repo. */
export interface Approval {
  accountId: string
  recordUri: string
  recordCid: string
  at: string
}

export interface Audit {
  reason: string
  approvals?: Approval[]
}

export interface AuditRow {
  eventId: string
  actorDid: string
  callerUserId: string | null
  action: GatheringAction
  collection: string
  rkey: string
  uri: string
  decision: 'allow' | 'deny'
  reason: string
  approvals: Approval[]
  policySource: string
}

export interface AuditSink {
  write(row: AuditRow): Promise<string>
  amend(auditId: string, suffix: string): Promise<void>
}

export interface RoleSource {
  /** Appointed role in this gathering, or null for a non-member. */
  appointedRole(eventId: string, accountId: string): Promise<MemberRole | null>
  /** Derived ladder value (member 10, host 20, facilitator 30, steward 40). */
  derivedRole(eventId: string, accountId: string): Promise<number>
  /** The account's DID (role claims name exactly the caller). */
  accountDid(accountId: string): Promise<string | null>
  /** The subject's own opt-in to a public role claim in this gathering. */
  publicRoleOptIn(eventId: string, accountId: string): Promise<boolean>
}

export interface PolicySource {
  destructiveActionStewards(eventId: string): Promise<number>
  publishRoles(eventId: string): Promise<boolean>
}

export interface SessionPutInput {
  collection: string
  rkey: string
  record: Record<string, unknown>
  swapRecord?: string | null
}

export interface SessionDeleteInput {
  collection: string
  rkey: string
  swapRecord?: string
}

export interface SessionCreateInput {
  collection: string
  rkey: string
  record: Record<string, unknown>
}

/** Executes repo writes with the gathering's own credential. Never handed out. */
export interface GatheringSession {
  putRecord(input: SessionPutInput): Promise<{ uri: string; cid: string }>
  deleteRecord(input: SessionDeleteInput): Promise<void>
  /**
   * Optional: create several records in ONE commit (`com.atproto.repo.applyWrites`, creates only).
   * Each op asserts "must not exist yet" (a create of an existing key fails the whole batch).
   * At most `APPLY_WRITES_MAX_OPS` per call. Results are in input order.
   */
  applyCreates?(input: { creates: SessionCreateInput[] }): Promise<Array<{ uri: string; cid: string }>>
}

export interface ReadYourWrites {
  upsert(input: { uri: string; cid: string; record: Record<string, unknown>; source: string }): Promise<unknown>
  remove(uri: string): Promise<void>
}

export interface AuthorizeInput {
  callerUserId: string | null
  action: GatheringAction
  approvals?: Approval[]
}

export interface AuthorizeResult {
  allowed: boolean
  role: MemberRole | 'system' | null
  reason: string
  code?: DenyCode
  requiresApprovals?: number
}

export interface PutAsGatheringInput {
  eventId: string
  /** `accounts.id`. `null` marks a trusted server-side job (sync, close-rounds) — never a request. */
  callerUserId: string | null
  action: GatheringAction
  collection: string
  rkey: string
  record: Record<string, unknown>
  swapRecord?: string | null
  /** Mandatory written reason. */
  reason: string
  approvals?: Approval[]
}

export interface DeleteAsGatheringInput {
  eventId: string
  callerUserId: string | null
  action: GatheringAction
  collection: string
  rkey: string
  swapRecord?: string
  reason: string
  approvals?: Approval[]
}

/** One create in an `applyCreatesAsGathering` batch (same gate as `putRecordAsGathering`, `swapRecord: null`). */
export type CreateAsGatheringInput = Omit<PutAsGatheringInput, 'eventId' | 'swapRecord'>

/** Ops per `applyWrites` call we send (the reference PDS refuses more than 200). */
export const APPLY_WRITES_MAX_OPS = 100

export interface WriteAsGatheringResult {
  uri: string
  cid: string
  auditId: string
}

export interface GatheringActorPort {
  readonly eventId: string
  readonly actorDid: string
  describeActor(): { eventId: string; actorDid: string; custody: 'app-owned' }
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>
  putRecordAsGathering(input: Omit<PutAsGatheringInput, 'eventId'>): Promise<WriteAsGatheringResult>
  deleteRecordAsGathering(input: Omit<DeleteAsGatheringInput, 'eventId'>): Promise<{ auditId: string }>
  /**
   * Create independent records in as few commits as possible. Every op is validated, R9-checked,
   * authorised and audited exactly like `putRecordAsGathering`; each asserts the record does not
   * exist yet. Chunked at `maxOps` (≤ `APPLY_WRITES_MAX_OPS`). A failed chunk throws (audit rows
   * amended); earlier chunks stay written. Results are in input order.
   */
  applyCreatesAsGathering(inputs: CreateAsGatheringInput[], opts?: { maxOps?: number }): Promise<WriteAsGatheringResult[]>
}

export interface GatheringActorDeps {
  roles: RoleSource
  policy: PolicySource
  audit: AuditSink
  session: GatheringSession
  index?: ReadYourWrites
  policySource?: string
}

function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

/** v1 adapter: the app holds the gathering's credential (custodial app password or OAuth session). */
export class AppCustodyGatheringActor implements GatheringActorPort {
  constructor(
    readonly eventId: string,
    readonly actorDid: string,
    private readonly deps: GatheringActorDeps,
  ) {}

  describeActor() {
    return { eventId: this.eventId, actorDid: this.actorDid, custody: 'app-owned' as const }
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const needed = MIN_ROLE[input.action]
    const destructive = DESTRUCTIVE_ACTIONS.has(input.action)

    if (input.callerUserId === null) {
      // A trusted job never performs a destructive action on its own authority.
      if (destructive) return { allowed: false, role: 'system', reason: `${input.action} is destructive and cannot run as a system job`, code: 'ErrPermissionDenied' }
      return { allowed: true, role: 'system', reason: 'ok (system job)' }
    }

    const role = await this.deps.roles.appointedRole(this.eventId, input.callerUserId)
    if (needed === 'steward' && !(role && STEWARD_ROLES.has(role))) {
      return { allowed: false, role, reason: `${input.action} requires an owner or admin of this gathering; caller is ${role ?? 'not a member'}`, code: 'ErrPermissionDenied' }
    }
    if (needed === 'host') {
      const ladder = await this.deps.roles.derivedRole(this.eventId, input.callerUserId)
      if (ladder < LADDER.host) {
        return { allowed: false, role, reason: `${input.action} requires role >= host (${LADDER.host}); caller has ${ladder}`, code: 'ErrPermissionDenied' }
      }
    }
    if (!destructive) return { allowed: true, role, reason: 'ok' }

    const requiresApprovals = await this.deps.policy.destructiveActionStewards(this.eventId)
    const approvers = new Set((input.approvals ?? []).map((a) => a.accountId))
    for (const approver of approvers) {
      const approverRole = await this.deps.roles.appointedRole(this.eventId, approver)
      if (!approverRole || !STEWARD_ROLES.has(approverRole)) {
        return { allowed: false, role, reason: 'an approver is not an owner or admin of this gathering', code: 'ErrPermissionDenied', requiresApprovals }
      }
    }
    // The acting organiser counts only when they themselves approved (their record is the evidence).
    if (approvers.size < requiresApprovals) {
      return {
        allowed: false,
        role,
        reason: `destructive action needs ${requiresApprovals} organiser approvals, have ${approvers.size}`,
        code: 'ErrThresholdNotMet',
        requiresApprovals,
      }
    }
    return { allowed: true, role, reason: 'ok', requiresApprovals }
  }

  private async gate(
    input: { callerUserId: string | null; action: GatheringAction; collection: string; rkey: string; reason: string; approvals?: Approval[] },
    uri: string,
  ): Promise<string> {
    if (!input.reason?.trim()) throw new Error('a written reason is mandatory for every gathering-actor call')
    const authz = await this.authorize(input)
    const row: AuditRow = {
      eventId: this.eventId,
      actorDid: this.actorDid,
      callerUserId: input.callerUserId,
      action: input.action,
      collection: input.collection,
      rkey: input.rkey,
      uri,
      decision: authz.allowed ? 'allow' : 'deny',
      reason: authz.allowed ? input.reason.trim().slice(0, 2000) : authz.reason,
      approvals: input.approvals ?? [],
      policySource: this.deps.policySource ?? 'app:v1',
    }
    const auditId = await this.deps.audit.write(row)
    if (!authz.allowed) throw new GatheringActionDeniedError(input.action, authz.reason, auditId, authz.code)
    return auditId
  }

  /**
   * The single R9 exemption (interop audit gap 11): a `coop.lexicon.membership` claim may name
   * its subject when the subject IS the caller, opted in, the policy publishes roles, and the
   * derived role is ≥ Host (checked in `authorize`). Anything else naming a person is refused.
   */
  private async consentedSubject(input: Omit<PutAsGatheringInput, 'eventId'>, record: Record<string, unknown>): Promise<string | undefined> {
    if (input.action !== 'publish-role-claim') return undefined
    if (input.collection !== NSID_MEMBERSHIP || !input.callerUserId) {
      throw new Error('publish-role-claim writes only coop.lexicon.membership, and only for a signed-in subject')
    }
    const did = await this.deps.roles.accountDid(input.callerUserId)
    if (!did || record.subject !== did) throw new Error('a role claim may only name the member who asked for it')
    if (!(await this.deps.policy.publishRoles(this.eventId))) throw new Error('this gathering does not publish role claims')
    if (!(await this.deps.roles.publicRoleOptIn(this.eventId, input.callerUserId))) throw new Error('the member has not opted in to a public role claim')
    return did
  }

  async putRecordAsGathering(input: Omit<PutAsGatheringInput, 'eventId'>): Promise<WriteAsGatheringResult> {
    const record: Record<string, unknown> = { ...input.record, $type: input.collection }
    assertValidRecord(input.collection, record)
    if (isBorrowedNsid(input.collection)) assertNoUnknownFields(input.collection, record)
    const consentedSubjectDid = await this.consentedSubject(input, record)
    assertNoForeignDid(record, this.actorDid, { gatheringDid: this.actorDid, consentedSubjectDid })

    const uri = `at://${this.actorDid}/${input.collection}/${input.rkey}`
    const auditId = await this.gate(input, uri)
    let res: { uri: string; cid: string }
    try {
      res = await this.deps.session.putRecord({
        collection: input.collection,
        rkey: input.rkey,
        record,
        ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
      })
    } catch (e) {
      await this.deps.audit.amend(auditId, `write failed: ${describeError(e)}`).catch(() => undefined)
      throw e
    }
    if (this.deps.index) {
      await this.deps.index.upsert({ uri: res.uri, cid: res.cid, record, source: 'local-write' }).catch(async (e) => {
        await this.deps.audit.amend(auditId, `written; index upsert failed (reconcile will repair): ${describeError(e)}`).catch(() => undefined)
      })
    }
    return { uri: res.uri, cid: res.cid, auditId }
  }

  async applyCreatesAsGathering(inputs: CreateAsGatheringInput[], opts: { maxOps?: number } = {}): Promise<WriteAsGatheringResult[]> {
    const maxOps = Math.max(1, Math.min(opts.maxOps ?? APPLY_WRITES_MAX_OPS, APPLY_WRITES_MAX_OPS))
    const out: WriteAsGatheringResult[] = []
    for (let i = 0; i < inputs.length; i += maxOps) {
      const slice = inputs.slice(i, i + maxOps)
      const prepared: Array<{ input: CreateAsGatheringInput; record: Record<string, unknown>; auditId: string }> = []
      for (const input of slice) {
        if (input.action === 'publish-role-claim') throw new Error('role claims are written one at a time (subject consent is checked per record)')
        const record: Record<string, unknown> = { ...input.record, $type: input.collection }
        assertValidRecord(input.collection, record)
        if (isBorrowedNsid(input.collection)) assertNoUnknownFields(input.collection, record)
        assertNoForeignDid(record, this.actorDid, { gatheringDid: this.actorDid })
        const auditId = await this.gate(input, `at://${this.actorDid}/${input.collection}/${input.rkey}`)
        prepared.push({ input, record, auditId })
      }
      let written: Array<{ uri: string; cid: string }>
      try {
        if (this.deps.session.applyCreates && prepared.length > 1) {
          written = await this.deps.session.applyCreates({
            creates: prepared.map((p) => ({ collection: p.input.collection, rkey: p.input.rkey, record: p.record })),
          })
        } else {
          written = []
          for (const p of prepared) {
            written.push(await this.deps.session.putRecord({ collection: p.input.collection, rkey: p.input.rkey, record: p.record, swapRecord: null }))
          }
        }
      } catch (e) {
        for (const p of prepared) await this.deps.audit.amend(p.auditId, `batch create failed: ${describeError(e)}`).catch(() => undefined)
        throw e
      }
      for (const [j, p] of prepared.entries()) {
        const res = written[j]!
        if (this.deps.index) {
          await this.deps.index.upsert({ uri: res.uri, cid: res.cid, record: p.record, source: 'local-write' }).catch(async (e) => {
            await this.deps.audit.amend(p.auditId, `written; index upsert failed (reconcile will repair): ${describeError(e)}`).catch(() => undefined)
          })
        }
        out.push({ uri: res.uri, cid: res.cid, auditId: p.auditId })
      }
    }
    return out
  }

  async deleteRecordAsGathering(input: Omit<DeleteAsGatheringInput, 'eventId'>): Promise<{ auditId: string }> {
    const uri = `at://${this.actorDid}/${input.collection}/${input.rkey}`
    const auditId = await this.gate(input, uri)
    try {
      await this.deps.session.deleteRecord({
        collection: input.collection,
        rkey: input.rkey,
        ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
      })
    } catch (e) {
      await this.deps.audit.amend(auditId, `delete failed: ${describeError(e)}`).catch(() => undefined)
      throw e
    }
    if (this.deps.index) await this.deps.index.remove(uri).catch(() => undefined)
    return { auditId }
  }
}
