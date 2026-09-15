/**
 * Participant-side writes: the records that live in a PERSON's own repo (spec §4.2, R9).
 *
 *   schellingpoint.draft.proposal        the author's offer              sessions.proposal_uri/cid
 *   schellingpoint.draft.cohost          a co-host's own acceptance       session_cohosts.cohost_uri
 *   schellingpoint.draft.endorsement     a participant's public "yes"     at_records only
 *   schellingpoint.draft.timePreference  opt-in availability              time_preferences.record_uri
 *   community.lexicon.calendar.rsvp      an attendee's opt-in RSVP        session_rsvps.rsvp_uri
 *
 * Every function takes app-side ids plus the acting account, writes into THAT account's repo
 * only, and persists the AT-URI on the app row. Nobody can call these for someone else.
 *
 * Who may publish (the two doors, spec §7):
 *   custodial accounts    always (the account was minted for exactly this)
 *   OAuth-door accounts   only after confirming the permanent public linkage
 *                         (`profiles.publish_proposals`, or `confirmPublicLinkage` on the call)
 *   owned accounts        custody ended; `agentForAccount` refuses → `relink_atproto`
 *
 * CAS: an update sends the cid we hold as `swapRecord`; a first write sends `null` (must not
 * exist). On `InvalidSwap` the live record is re-read and the write retried once.
 * Read-your-writes: every write is upserted into `at_records` before returning.
 *
 * Network I/O is injectable (`ParticipantDeps`) so failure paths are testable without a PDS.
 */
import 'server-only'
import type { Agent } from '@atproto/api'
import { sql } from '@/lib/db'
import { agentForAccount } from './agent'
import { checkProposalDrift, flagProposalWithdrawn } from './drift'
import { deleteIndexedRecord, upsertIndexedRecord } from './index-store'
import { NSID } from './nsids'
import { deleteRecord, getRecord, putRecord } from './write'
import {
  assertNoForeignDid,
  buildCohostRecord,
  buildEndorsementRecord,
  buildProposalRecord,
  buildRsvpRecord,
  buildTimePreferenceRecord,
  type ProposalSessionInput,
} from './records'
import { tid } from './rkey'
import type { StrongRef, TimeWindow } from './types'
import type { DeleteRecordInput, FetchedRecord, PutRecordInput, WriteResult } from './write'
import type { UpsertIndexedRecordInput } from './index-store'

/* ─────────────────────────────── errors ─────────────────────────────── */

export type ParticipantErrorCode =
  | 'link_atproto_first'
  | 'confirm_public_linkage'
  | 'not_found'
  | 'forbidden'
  | 'gathering_not_published'
  | 'proposal_not_published'
  | 'calendar_event_not_published'
  | 'not_cohost'
  | 'no_rsvp'
  | 'nothing_to_withdraw'
  | 'invalid_note'
  | 'invalid_skills'
  | 'invalid_windows'

const STATUS_FOR: Record<ParticipantErrorCode, number> = {
  link_atproto_first: 409,
  confirm_public_linkage: 409,
  not_found: 404,
  forbidden: 403,
  gathering_not_published: 409,
  proposal_not_published: 409,
  calendar_event_not_published: 409,
  not_cohost: 403,
  no_rsvp: 409,
  nothing_to_withdraw: 409,
  invalid_note: 400,
  invalid_skills: 400,
  invalid_windows: 400,
}

export class ParticipantError extends Error {
  readonly status: number
  constructor(
    readonly code: ParticipantErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ParticipantError'
    this.status = STATUS_FOR[code]
  }
}

/* ──────────────────────────────── deps ──────────────────────────────── */

export interface ParticipantIndex {
  upsert: (input: UpsertIndexedRecordInput) => Promise<unknown>
  remove: (uri: string) => Promise<void>
}

export interface ParticipantDeps {
  /** `agentForAccount` — throws `NoActorCredentialError` / `ProfileNotLinkedError`. */
  agentFor: (accountId: string) => Promise<Agent>
  put: (agent: Agent, input: PutRecordInput) => Promise<WriteResult>
  del: (agent: Agent, input: DeleteRecordInput) => Promise<void>
  getRecord: <T = Record<string, unknown>>(repo: string, collection: string, rkey: string) => Promise<FetchedRecord<T> | null>
  index?: ParticipantIndex
}

const DEFAULT_DEPS: ParticipantDeps = {
  agentFor: (id) => agentForAccount(id),
  put: putRecord,
  del: deleteRecord,
  getRecord,
  index: { upsert: (i) => upsertIndexedRecord(i), remove: (u) => deleteIndexedRecord(u) },
}

async function resolveDeps(deps?: Partial<ParticipantDeps>): Promise<ParticipantDeps> {
  return { ...DEFAULT_DEPS, ...deps }
}

/** Sentinel for callers that want no index side effects (tests). */
export const NO_INDEX: ParticipantIndex = { upsert: async () => undefined, remove: async () => undefined }

/* ─────────────────────────────── helpers ─────────────────────────────── */

const AT_URI_RE = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/

/** Parse `at://did/collection/rkey`; `null` for anything else. Dependency-free. */
export function splitAtUri(uri: string | null | undefined): { did: string; collection: string; rkey: string } | null {
  if (!uri) return null
  const m = AT_URI_RE.exec(uri)
  return m ? { did: m[1]!, collection: m[2]!, rkey: m[3]! } : null
}

function isInvalidSwap(e: unknown): boolean {
  const err = e as { error?: string; message?: string } | undefined
  return err?.error === 'InvalidSwap' || /InvalidSwap/.test(err?.message ?? '')
}

export interface PublishingIdentity {
  accountId: string
  did: string
  handle: string | null
  kind: 'custodial' | 'oauth'
}

/**
 * The account's DID, if it may publish records about itself right now. `requireLinkage: false`
 * skips the OAuth confirmation gate (used when deleting one's own record, which never needs it).
 */
export async function publishingIdentity(
  accountId: string,
  opts: { confirmPublicLinkage?: boolean; requireLinkage?: boolean; forApproval?: boolean } = {},
): Promise<PublishingIdentity> {
  const [row] = await sql<{ id: string; did: string; handle: string | null; kind: 'custodial' | 'oauth'; publish_proposals: boolean | null }[]>`
    select a.id, a.did, a.handle, a.kind, p.publish_proposals
    from accounts a left join profiles p on p.id = a.id
    where a.id = ${accountId}
  `
  if (!row) throw new ParticipantError('link_atproto_first', 'No ATProto identity for this account')
  if (opts.requireLinkage !== false && row.kind === 'oauth' && !row.publish_proposals && !opts.confirmPublicLinkage) {
    throw new ParticipantError(
      'confirm_public_linkage',
      opts.forApproval
        ? 'Approving writes a public record in your own ATProto repo that permanently links your account to organising this gathering. Confirm to continue.'
        : 'Publishing writes a public record in your own ATProto repo that permanently links your account to this gathering. Confirm to continue.',
    )
  }
  return { accountId: row.id, did: row.did, handle: row.handle, kind: row.kind }
}

interface SessionRow {
  id: string
  event_id: string
  host_id: string | null
  title: string
  description: string | null
  format: string | null
  duration: number | null
  topic_tags: string[] | null
  skill_uris: string[] | null
  expected_attendance: number | null
  required_features: string[] | null
  is_self_hosted: boolean | null
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  public_place: string | null
  created_at: string
  track_id: string | null
  status: string | null
  proposal_uri: string | null
  proposal_cid: string | null
  proposal_withdrawn_at: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
  slot_uri: string | null
}

async function loadSession(sessionId: string): Promise<SessionRow> {
  const [s] = await sql<SessionRow[]>`
    select id, event_id, host_id, title, description, format, duration, topic_tags, skill_uris, expected_attendance,
           required_features, is_self_hosted, self_hosted_start_time, self_hosted_end_time, public_place, created_at,
           track_id, status, proposal_uri, proposal_cid, proposal_withdrawn_at, calendar_event_uri, calendar_event_cid, slot_uri
    from sessions where id = ${sessionId}
  `
  if (!s) throw new ParticipantError('not_found', 'Session not found')
  return s
}

function proposalRef(session: SessionRow): StrongRef {
  if (!session.proposal_uri || !session.proposal_cid || session.proposal_withdrawn_at) {
    throw new ParticipantError('proposal_not_published', 'The author has not published this proposal to the network')
  }
  return { uri: session.proposal_uri, cid: session.proposal_cid }
}

function calendarEventRef(session: SessionRow): StrongRef {
  if (!session.calendar_event_uri || !session.calendar_event_cid) {
    throw new ParticipantError('calendar_event_not_published', 'The gathering has not published this session to the network yet')
  }
  return { uri: session.calendar_event_uri, cid: session.calendar_event_cid }
}

/** Existing rkey when `uri` names a record of `collection` in `did`'s repo; else a fresh TID. */
function rkeyFor(uri: string | null | undefined, did: string, collection: string): { rkey: string; existing: boolean } {
  const parsed = splitAtUri(uri)
  if (parsed && parsed.did === did && parsed.collection === collection) return { rkey: parsed.rkey, existing: true }
  return { rkey: tid(), existing: false }
}

/** CAS put with one re-read retry. */
async function casPut(
  d: ParticipantDeps,
  agent: Agent,
  input: { repo: string; collection: string; rkey: string; record: Record<string, unknown>; expectedCid: string | null },
): Promise<WriteResult> {
  const base = { repo: input.repo, collection: input.collection, rkey: input.rkey, record: input.record }
  try {
    return await d.put(agent, { ...base, swapRecord: input.expectedCid })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    const live = await d.getRecord(input.repo, input.collection, input.rkey)
    return d.put(agent, { ...base, swapRecord: live?.cid ?? null })
  }
}

async function indexSelf(d: ParticipantDeps, result: WriteResult, record: object): Promise<void> {
  if (!d.index) return
  try {
    await d.index.upsert({ uri: result.uri, cid: result.cid, record: record as Record<string, unknown>, source: 'local-write' })
  } catch (e) {
    console.warn('[atproto:participant] index upsert failed (reconcile repairs it):', e instanceof Error ? e.name : 'error')
  }
}

async function unindex(d: ParticipantDeps, uri: string): Promise<void> {
  await d.index?.remove(uri).catch(() => undefined)
}

/* ───────────────────────────── proposal ───────────────────────────── */

export interface SessionUserInput {
  sessionId: string
  userId: string
  confirmPublicLinkage?: boolean
}

const SKILL_URI_RE = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/freeschool\.draft\.skill\/[A-Za-z0-9._:~-]{1,512}$/

/**
 * Publish (or re-publish) the session as a `schellingpoint.draft.proposal` in the AUTHOR's repo.
 * A second call rewrites the same rkey CAS'd on the stored cid. When the session is already on
 * the published schedule, a changed cid is flagged for the organisers (cid drift).
 */
export async function publishProposal(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  const d = await resolveDeps(deps)
  const session = await loadSession(input.sessionId)
  if (session.host_id !== input.userId) throw new ParticipantError('forbidden', 'Only the proposal author can publish it')
  const identity = await publishingIdentity(input.userId, { confirmPublicLinkage: input.confirmPublicLinkage })

  const [event] = await sql<{ gathering_uri: string | null; actor_did: string | null }[]>`
    select gathering_uri, actor_did from events where id = ${session.event_id}
  `
  if (!event?.actor_did) throw new ParticipantError('gathering_not_published', 'This gathering has no network identity yet')
  // A URI, not a strongRef: the gathering record is edited and a proposal must not be orphaned by it.
  const gatheringUri = event.gathering_uri ?? `at://${event.actor_did}/${NSID.gathering}/self`

  const skills = session.skill_uris ?? []
  if (skills.length > 5 || skills.some((s) => !SKILL_URI_RE.test(s))) {
    throw new ParticipantError('invalid_skills', 'A proposal carries at most five skills from the shared taxonomy')
  }
  let trackUri: string | null = null
  if (session.track_id) {
    const [track] = await sql<{ at_uri: string | null }[]>`select at_uri from tracks where id = ${session.track_id}`
    trackUri = track?.at_uri ?? null
  }

  // A human's publish is never an import stub: `imported`/`importedFrom` stay absent.
  const sessionInput: ProposalSessionInput = {
    title: session.title,
    description: session.description,
    format: session.format || 'talk',
    duration: session.duration ?? 30,
    topic_tags: session.topic_tags,
    expected_attendance: session.expected_attendance,
    required_features: session.required_features,
    is_self_hosted: session.is_self_hosted,
    self_hosted_start_time: session.self_hosted_start_time,
    self_hosted_end_time: session.self_hosted_end_time,
    // The exact address (`custom_location`) is attendee-only; only the author's public label is published.
    public_place: session.public_place,
    created_at: session.created_at,
    imported_from: null,
  }
  const record = buildProposalRecord({ session: sessionInput, gatheringUri, trackUri, skills })
  assertNoForeignDid(record, identity.did, { gatheringDid: event.actor_did })

  const agent = await d.agentFor(input.userId)
  const { rkey, existing } = rkeyFor(session.proposal_uri, identity.did, NSID.proposal)
  const result = await casPut(d, agent, {
    repo: identity.did,
    collection: NSID.proposal,
    rkey,
    record: record as unknown as Record<string, unknown>,
    expectedCid: existing && !session.proposal_withdrawn_at ? session.proposal_cid : null,
  })

  await sql`
    update sessions set
      proposal_uri = ${result.uri}, proposal_cid = ${result.cid}, host_did = ${identity.did},
      proposal_withdrawn_at = null, atproto_published_at = now()
    where id = ${session.id}
  `
  await indexSelf(d, result, record)
  await checkProposalDrift({ sessionId: session.id, currentCid: result.cid }).catch(() => undefined)
  await publishAcceptedCohosts(session.id, d).catch(() => undefined)
  return result
}

/**
 * Delete the author's proposal record. The session row, its status and the published schedule
 * are untouched: the organisers are flagged and decide (spec §6). The author may publish again.
 */
export async function withdrawProposal(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  const session = await loadSession(input.sessionId)
  if (session.host_id !== input.userId) throw new ParticipantError('forbidden', 'Only the proposal author can withdraw it')
  const identity = await publishingIdentity(input.userId, { requireLinkage: false })
  const parsed = splitAtUri(session.proposal_uri)
  if (!parsed || parsed.did !== identity.did || parsed.collection !== NSID.proposal || session.proposal_withdrawn_at) {
    throw new ParticipantError('nothing_to_withdraw', 'No proposal record of yours to withdraw')
  }
  const agent = await d.agentFor(input.userId)
  try {
    await d.del(agent, { repo: identity.did, collection: NSID.proposal, rkey: parsed.rkey, ...(session.proposal_cid ? { swapRecord: session.proposal_cid } : {}) })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    await d.del(agent, { repo: identity.did, collection: NSID.proposal, rkey: parsed.rkey })
  }
  await unindex(d, session.proposal_uri!)
  await flagProposalWithdrawn({ sessionId: session.id })
  return { uri: session.proposal_uri! }
}

/* ────────────────────────────── cohost ────────────────────────────── */

interface CohostRow {
  id: string
  user_id: string
  display_order: number | null
  added_at: string | null
  cohost_uri: string | null
}

async function loadCohostRow(sessionId: string, userId: string): Promise<CohostRow> {
  const [row] = await sql<CohostRow[]>`
    select id, user_id, display_order, added_at, cohost_uri from session_cohosts where session_id = ${sessionId} and user_id = ${userId}
  `
  if (!row) throw new ParticipantError('not_cohost', 'You are not a co-host of this session')
  return row
}

/**
 * Write the co-host's own `schellingpoint.draft.cohost`, strongRef'ing the published proposal —
 * the second half of the double opt-in (B calls this when the invite is accepted).
 */
export async function publishCohost(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  const d = await resolveDeps(deps)
  const session = await loadSession(input.sessionId)
  const proposal = proposalRef(session)
  const row = await loadCohostRow(input.sessionId, input.userId)
  const identity = await publishingIdentity(input.userId, { confirmPublicLinkage: input.confirmPublicLinkage })
  const record = buildCohostRecord({ proposal, role: 'cohost', displayOrder: row.display_order, createdAt: row.added_at ?? new Date() })
  assertNoForeignDid(record, identity.did)

  const agent = await d.agentFor(input.userId)
  const { rkey, existing } = rkeyFor(row.cohost_uri, identity.did, NSID.cohost)
  const current = existing && row.cohost_uri ? await d.getRecord(identity.did, NSID.cohost, rkey) : null
  const result = await casPut(d, agent, {
    repo: identity.did,
    collection: NSID.cohost,
    rkey,
    record: record as unknown as Record<string, unknown>,
    expectedCid: current?.cid ?? null,
  })
  await sql`update session_cohosts set cohost_uri = ${result.uri} where id = ${row.id}`
  await indexSelf(d, result, record)
  return result
}

/** On a proposal's first publish: write the cohost records of custodial co-hosts who already accepted. */
async function publishAcceptedCohosts(sessionId: string, d: ParticipantDeps): Promise<void> {
  const rows = await sql<{ user_id: string }[]>`
    select c.user_id from session_cohosts c join accounts a on a.id = c.user_id
    where c.session_id = ${sessionId} and c.cohost_uri is null and a.kind = 'custodial' and a.owned_at is null
  `
  for (const r of rows) await publishCohost({ sessionId, userId: r.user_id }, d).catch(() => undefined)
}

/** The co-host withdraws: deletes their own record. An organiser cannot un-cohost anyone. */
export async function withdrawCohost(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  await loadSession(input.sessionId)
  const row = await loadCohostRow(input.sessionId, input.userId)
  const identity = await publishingIdentity(input.userId, { requireLinkage: false })
  const parsed = splitAtUri(row.cohost_uri)
  if (!parsed || parsed.did !== identity.did || parsed.collection !== NSID.cohost) {
    throw new ParticipantError('nothing_to_withdraw', 'No co-host record of yours to withdraw')
  }
  await d.del(await d.agentFor(input.userId), { repo: identity.did, collection: NSID.cohost, rkey: parsed.rkey })
  await sql`update session_cohosts set cohost_uri = null where id = ${row.id}`
  await unindex(d, row.cohost_uri!)
  return { uri: row.cohost_uri! }
}

/* ──────────────────────────── endorsement ──────────────────────────── */

export const ENDORSEMENT_NOTE_MAX_GRAPHEMES = 150

/** The endorser's existing endorsement of this proposal, from the index. */
export async function findEndorsement(did: string, proposalUri: string): Promise<{ uri: string; cid: string | null; record: Record<string, unknown> } | null> {
  const [row] = await sql<{ uri: string; cid: string | null; record: Record<string, unknown> }[]>`
    select uri, cid, record from at_records
    where collection = ${NSID.endorsement} and did = ${did} and record -> 'proposal' ->> 'uri' = ${proposalUri}
    order by indexed_at desc limit 1
  `
  return row ?? null
}

export async function countEndorsements(proposalUri: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(distinct did)::int as n from at_records r
    where collection = ${NSID.endorsement} and record -> 'proposal' ->> 'uri' = ${proposalUri}
      -- an endorsement from a taken-down / deactivated / deleted repo does not count
      and not exists (select 1 from at_repo_status rs where rs.did = r.did and rs.hidden)
  `
  return row?.n ?? 0
}

export interface EndorseInput extends SessionUserInput {
  note?: string | null
}

/**
 * `schellingpoint.draft.endorsement` in the participant's repo: a public signal to other humans,
 * never a vote and never counted into a tally. A person has at most one per proposal.
 */
export async function endorse(input: EndorseInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  const d = await resolveDeps(deps)
  const session = await loadSession(input.sessionId)
  if (session.host_id === input.userId) throw new ParticipantError('forbidden', 'You cannot endorse your own proposal')
  const proposal = proposalRef(session)
  const note = input.note?.trim() || null
  if (note && [...note].length > ENDORSEMENT_NOTE_MAX_GRAPHEMES) {
    throw new ParticipantError('invalid_note', `Note must be ${ENDORSEMENT_NOTE_MAX_GRAPHEMES} characters or fewer`)
  }
  const identity = await publishingIdentity(input.userId, { confirmPublicLinkage: input.confirmPublicLinkage })
  const existing = await findEndorsement(identity.did, proposal.uri)
  const record = buildEndorsementRecord({ proposal, note, createdAt: (existing?.record.createdAt as string | undefined) ?? new Date() })
  assertNoForeignDid(record, identity.did)
  const { rkey, existing: known } = rkeyFor(existing?.uri, identity.did, NSID.endorsement)
  const result = await casPut(d, await d.agentFor(input.userId), {
    repo: identity.did,
    collection: NSID.endorsement,
    rkey,
    record: record as unknown as Record<string, unknown>,
    expectedCid: known ? (existing?.cid ?? null) : null,
  })
  await indexSelf(d, result, record)
  return result
}

export async function unendorse(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  const session = await loadSession(input.sessionId)
  if (!session.proposal_uri) throw new ParticipantError('nothing_to_withdraw', 'No endorsement of yours to remove')
  const identity = await publishingIdentity(input.userId, { requireLinkage: false })
  const existing = await findEndorsement(identity.did, session.proposal_uri)
  const parsed = splitAtUri(existing?.uri)
  if (!existing || !parsed || parsed.did !== identity.did) throw new ParticipantError('nothing_to_withdraw', 'No endorsement of yours to remove')
  await d.del(await d.agentFor(input.userId), { repo: identity.did, collection: NSID.endorsement, rkey: parsed.rkey })
  await unindex(d, existing.uri)
  return { uri: existing.uri }
}

/* ─────────────────────────────── rsvp ─────────────────────────────── */

export type PublicRsvpStatus = 'going' | 'interested' | 'notgoing'
export const PUBLIC_RSVP_STATUSES: readonly PublicRsvpStatus[] = ['going', 'interested', 'notgoing']

/** The permanence sentence shown before an opt-in public RSVP (spec §4.1). */
export const PUBLIC_RSVP_PERMANENCE =
  'A public RSVP is a record in your own repo that anyone on the network can read and copy. You can delete it later, but copies others made may remain.'

export interface PublicRsvpInput extends SessionUserInput {
  status: PublicRsvpStatus
}

/**
 * Opt-in: mirror the attendee's app-side RSVP as a public `community.lexicon.calendar.rsvp` in
 * their own repo, subject = the session's published calendar event.
 */
export async function publicRsvp(input: PublicRsvpInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  if (!PUBLIC_RSVP_STATUSES.includes(input.status)) throw new ParticipantError('invalid_note', 'Invalid RSVP status')
  const d = await resolveDeps(deps)
  const session = await loadSession(input.sessionId)
  const subject = calendarEventRef(session)
  const [row] = await sql<{ id: string; rsvp_uri: string | null }[]>`
    select id, rsvp_uri from session_rsvps where session_id = ${input.sessionId} and user_id = ${input.userId} and status <> 'cancelled'
  `
  if (!row) throw new ParticipantError('no_rsvp', 'RSVP to the session first, then share it publicly')
  const identity = await publishingIdentity(input.userId, { confirmPublicLinkage: input.confirmPublicLinkage })
  const record = buildRsvpRecord({ subject, status: input.status })
  assertNoForeignDid(record, identity.did)
  const { rkey, existing } = rkeyFor(row.rsvp_uri, identity.did, NSID.rsvp)
  const current = existing ? await d.getRecord(identity.did, NSID.rsvp, rkey) : null
  const result = await casPut(d, await d.agentFor(input.userId), {
    repo: identity.did,
    collection: NSID.rsvp,
    rkey,
    record: record as unknown as Record<string, unknown>,
    expectedCid: current?.cid ?? null,
  })
  await sql`update session_rsvps set rsvp_uri = ${result.uri} where id = ${row.id}`
  await indexSelf(d, result, record)
  return result
}

export async function retractPublicRsvp(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  const [row] = await sql<{ id: string; rsvp_uri: string | null }[]>`
    select id, rsvp_uri from session_rsvps where session_id = ${input.sessionId} and user_id = ${input.userId}
  `
  if (!row) throw new ParticipantError('no_rsvp', 'You have no RSVP for this session')
  const identity = await publishingIdentity(input.userId, { requireLinkage: false })
  const parsed = splitAtUri(row.rsvp_uri)
  if (!parsed || parsed.did !== identity.did || parsed.collection !== NSID.rsvp) {
    throw new ParticipantError('nothing_to_withdraw', 'No public RSVP of yours to retract')
  }
  await d.del(await d.agentFor(input.userId), { repo: identity.did, collection: NSID.rsvp, rkey: parsed.rkey })
  await sql`update session_rsvps set rsvp_uri = null where id = ${row.id}`
  await unindex(d, row.rsvp_uri!)
  return { uri: row.rsvp_uri! }
}

/* ─────────────────────────── time preferences ─────────────────────────── */

export interface TimePreferenceInput extends SessionUserInput {
  windows: TimeWindow[]
  blackouts?: TimeWindow[]
  /** Opt-in: also publish `schellingpoint.draft.timePreference` in the proposer's repo. Default false. */
  publish?: boolean
}

export interface TimePreferenceResult {
  windows: TimeWindow[]
  blackouts: TimeWindow[]
  publish: boolean
  record: { uri: string; cid: string } | null
}

/** Real instants, start < end, preference 1..3, at most 40 of each, sorted. */
export function normalizeWindows(windows: unknown, label: string): TimeWindow[] {
  if (windows === undefined || windows === null) return []
  if (!Array.isArray(windows) || windows.length > 40) throw new ParticipantError('invalid_windows', `${label}: at most 40 windows`)
  const out: TimeWindow[] = []
  for (const w of windows) {
    const o = w as Record<string, unknown>
    const s = typeof o?.startsAt === 'string' ? new Date(o.startsAt) : null
    const e = typeof o?.endsAt === 'string' ? new Date(o.endsAt) : null
    if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s >= e) {
      throw new ParticipantError('invalid_windows', `${label}: every window needs startsAt before endsAt (ISO 8601 instants)`)
    }
    const pref = o.preference
    if (pref !== undefined && pref !== null && ![1, 2, 3].includes(pref as number)) {
      throw new ParticipantError('invalid_windows', `${label}: preference is 1 (prefer), 2 (acceptable) or 3 (last resort)`)
    }
    out.push({ startsAt: s.toISOString(), endsAt: e.toISOString(), ...(pref ? { preference: pref as 1 | 2 | 3 } : {}) })
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
}

/**
 * Store the proposer's availability app-side (always) and, only when they opt in, publish it
 * as a record strongRef'ing their proposal. Turning `publish` off deletes the record. The
 * scheduler reads the app-side row either way.
 */
export async function publishTimePreference(input: TimePreferenceInput, deps?: Partial<ParticipantDeps>): Promise<TimePreferenceResult> {
  const session = await loadSession(input.sessionId)
  if (session.host_id !== input.userId) throw new ParticipantError('forbidden', 'Only the proposal author sets its time preferences')
  const windows = normalizeWindows(input.windows, 'windows')
  const blackouts = normalizeWindows(input.blackouts, 'blackouts')
  const publish = input.publish === true

  const [prior] = await sql<{ record_uri: string | null; record_cid: string | null }[]>`
    select record_uri, record_cid from time_preferences where session_id = ${session.id} and account_id = ${input.userId}
  `
  await sql`
    insert into time_preferences (event_id, session_id, account_id, windows, blackouts, publish)
    values (${session.event_id}, ${session.id}, ${input.userId}, ${sql.json(windows as never)}, ${sql.json(blackouts as never)}, ${publish})
    on conflict (session_id, account_id) do update set
      windows = excluded.windows, blackouts = excluded.blackouts, publish = excluded.publish, updated_at = now()
  `

  if (!publish) {
    if (prior?.record_uri) {
      const d = await resolveDeps(deps)
      const identity = await publishingIdentity(input.userId, { requireLinkage: false })
      const parsed = splitAtUri(prior.record_uri)
      if (parsed && parsed.did === identity.did) {
        await d.del(await d.agentFor(input.userId), { repo: identity.did, collection: NSID.timePreference, rkey: parsed.rkey })
        await unindex(d, prior.record_uri)
      }
      await sql`update time_preferences set record_uri = null, record_cid = null where session_id = ${session.id} and account_id = ${input.userId}`
    }
    return { windows, blackouts, publish, record: null }
  }

  const d = await resolveDeps(deps)
  const proposal = proposalRef(session)
  const identity = await publishingIdentity(input.userId, { confirmPublicLinkage: input.confirmPublicLinkage })
  const record = buildTimePreferenceRecord({ proposal, windows, blackouts, createdAt: new Date() })
  assertNoForeignDid(record, identity.did)
  const { rkey, existing } = rkeyFor(prior?.record_uri, identity.did, NSID.timePreference)
  const result = await casPut(d, await d.agentFor(input.userId), {
    repo: identity.did,
    collection: NSID.timePreference,
    rkey,
    record: record as unknown as Record<string, unknown>,
    expectedCid: existing ? (prior?.record_cid ?? null) : null,
  })
  await sql`update time_preferences set record_uri = ${result.uri}, record_cid = ${result.cid} where session_id = ${session.id} and account_id = ${input.userId}`
  await indexSelf(d, result, record)
  return { windows, blackouts, publish, record: { uri: result.uri, cid: result.cid } }
}

/** What the scheduler reads: app-side windows for every proposal in a gathering. */
export async function timePreferencesForEvent(eventId: string): Promise<Map<string, { windows: TimeWindow[]; blackouts: TimeWindow[] }>> {
  const rows = await sql<{ session_id: string; windows: TimeWindow[]; blackouts: TimeWindow[] }[]>`
    select session_id, windows, blackouts from time_preferences where event_id = ${eventId}
  `
  return new Map(rows.map((r) => [r.session_id, { windows: r.windows ?? [], blackouts: r.blackouts ?? [] }]))
}
