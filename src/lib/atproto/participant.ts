/**
 * Participant-side writes: the records that live in a PERSON's own repo.
 *
 *   - `schellingpoint.draft.proposal`     the author's offer            (`sessions.proposal_uri/cid`)
 *   - `schellingpoint.draft.cohost`       a co-host's own confirmation  (`session_cohosts.cohost_uri`)
 *   - `schellingpoint.draft.endorsement`  a participant's public "yes"  (indexed in `at_records`)
 *   - `community.lexicon.calendar.rsvp`   an attendee's opt-in RSVP     (`session_rsvps.rsvp_uri`)
 *
 * Every function takes app-side ids plus the acting `userId`, resolves that
 * user's linked DID, writes into THAT repo only, and persists the resulting
 * AT-URI on the app-side row. Organizers cannot call these for someone else:
 * a proposal is the author's, a cohost record is the co-host's (spec §4.2, R9).
 *
 * Network I/O is injectable (`ParticipantDeps`) so the flows are unit-testable
 * without a PDS. The defaults are loaded lazily because `agent.ts`, `write.ts`
 * and `index-store.ts` are `server-only`; this module itself stays importable
 * from Node (tests) as long as callers pass their own deps.
 */
import type { Agent } from '@atproto/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'
import { NSID } from './nsids'
import { tid } from './rkey'
import {
  assertNoForeignDid,
  buildCohostRecord,
  buildEndorsementRecord,
  buildProposalRecord,
  buildRsvpRecord,
  type ProposalSessionInput,
} from './records'
import type { StrongRef } from './types'
import type { DeleteRecordInput, PutRecordInput, WriteResult } from './write'
import type { UpsertIndexedRecordInput } from './index-store'

/* ─────────────────────────────── errors ─────────────────────────────── */

export type ParticipantErrorCode =
  | 'link_atproto_first'
  | 'not_found'
  | 'forbidden'
  | 'gathering_not_published'
  | 'proposal_not_published'
  | 'calendar_event_not_published'
  | 'not_cohost'
  | 'no_rsvp'
  | 'nothing_to_withdraw'
  | 'invalid_note'

const STATUS_FOR: Record<ParticipantErrorCode, number> = {
  link_atproto_first: 409,
  not_found: 404,
  forbidden: 403,
  gathering_not_published: 409,
  proposal_not_published: 409,
  calendar_event_not_published: 409,
  not_cohost: 403,
  no_rsvp: 409,
  nothing_to_withdraw: 409,
  invalid_note: 400,
}

export class ParticipantError extends Error {
  readonly status: number
  constructor(readonly code: ParticipantErrorCode, message?: string) {
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
  /** `agentForUser` — throws `ProfileNotLinkedError` when the profile has no DID. */
  agentFor: (userId: string) => Promise<Agent>
  put: (agent: Agent, input: PutRecordInput) => Promise<WriteResult>
  del: (agent: Agent, input: DeleteRecordInput) => Promise<void>
  /** `at_records` writes so a self-written record is visible before the indexer sees it. */
  index?: ParticipantIndex
  /** Service-role client; defaults to `createAdminClient()`. */
  db?: SupabaseClient
}

let cachedDefaults: Promise<ParticipantDeps> | undefined

async function defaultDeps(): Promise<ParticipantDeps> {
  if (!cachedDefaults) {
    cachedDefaults = (async () => {
      const [agent, write, index] = await Promise.all([import('./agent'), import('./write'), import('./index-store')])
      return {
        agentFor: agent.agentForUser,
        put: write.putRecord,
        del: write.deleteRecord,
        index: { upsert: index.upsertIndexedRecord, remove: index.deleteIndexedRecord },
      }
    })()
  }
  return cachedDefaults
}

async function resolveDeps(deps?: Partial<ParticipantDeps>): Promise<Required<Pick<ParticipantDeps, 'agentFor' | 'put' | 'del' | 'db'>> & Pick<ParticipantDeps, 'index'>> {
  const base = deps?.agentFor && deps?.put && deps?.del ? (deps as ParticipantDeps) : { ...(await defaultDeps()), ...deps }
  return {
    agentFor: base.agentFor,
    put: base.put,
    del: base.del,
    index: base.index,
    db: base.db ?? (await createAdminClient()),
  }
}

/** Sentinel used when a caller wants no index side effects (tests). */
export const NO_INDEX: ParticipantIndex = { upsert: async () => undefined, remove: async () => undefined }

/* ─────────────────────────────── helpers ─────────────────────────────── */

const AT_URI_RE = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/

/** Parse `at://did/collection/rkey`; `null` for anything else. Dependency-free (identity.ts is server-only). */
export function splitAtUri(uri: string | null | undefined): { did: string; collection: string; rkey: string } | null {
  if (!uri) return null
  const m = AT_URI_RE.exec(uri)
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null
}

/** The rkey to reuse when `uri` already names a record of `collection` in `did`'s repo; otherwise a fresh TID. */
function rkeyFor(uri: string | null | undefined, did: string, collection: string): { rkey: string; existing: boolean } {
  const parsed = splitAtUri(uri)
  if (parsed && parsed.did === did && parsed.collection === collection) return { rkey: parsed.rkey, existing: true }
  return { rkey: tid(), existing: false }
}

interface LinkedProfile {
  id: string
  did: string
  handle: string | null
}

async function linkedProfile(db: SupabaseClient, userId: string): Promise<LinkedProfile> {
  const { data, error } = await db.from('profiles').select('id, did, atproto_handle').eq('id', userId).maybeSingle()
  if (error) throw new Error(`profiles get: ${error.message}`)
  if (!data) throw new ParticipantError('not_found', 'Profile not found')
  const did = (data.did as string | null) ?? null
  if (!did) throw new ParticipantError('link_atproto_first', 'Link an ATProto account before publishing')
  return { id: data.id as string, did, handle: (data.atproto_handle as string | null) ?? null }
}

interface SessionRow {
  id: string
  event_id: string
  host_id: string | null
  title: string
  description: string | null
  format: string
  duration: number
  topic_tags: string[] | null
  expected_attendance: number | null
  required_features: string[] | null
  is_self_hosted: boolean | null
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  custom_location: string | null
  created_at: string
  track_id: string | null
  proposal_uri: string | null
  proposal_cid: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
}

const SESSION_SELECT =
  'id, event_id, host_id, title, description, format, duration, topic_tags, expected_attendance, required_features, is_self_hosted, self_hosted_start_time, self_hosted_end_time, custom_location, created_at, track_id, proposal_uri, proposal_cid, calendar_event_uri, calendar_event_cid'

async function loadSession(db: SupabaseClient, sessionId: string): Promise<SessionRow> {
  const { data, error } = await db.from('sessions').select(SESSION_SELECT).eq('id', sessionId).maybeSingle()
  if (error) throw new Error(`sessions get: ${error.message}`)
  if (!data) throw new ParticipantError('not_found', 'Session not found')
  return data as unknown as SessionRow
}

function proposalRef(session: SessionRow): StrongRef {
  if (!session.proposal_uri || !session.proposal_cid) {
    throw new ParticipantError('proposal_not_published', 'The author has not published this proposal to the network yet')
  }
  return { uri: session.proposal_uri, cid: session.proposal_cid }
}

function calendarEventRef(session: SessionRow): StrongRef {
  if (!session.calendar_event_uri || !session.calendar_event_cid) {
    throw new ParticipantError('calendar_event_not_published', 'The gathering has not published this session to the network yet')
  }
  return { uri: session.calendar_event_uri, cid: session.calendar_event_cid }
}

async function indexSelf(index: ParticipantIndex | undefined, result: WriteResult, record: Record<string, unknown>): Promise<void> {
  if (!index) return
  await index.upsert({ uri: result.uri, cid: result.cid, record, source: 'self' })
}

/* ───────────────────────────── proposal ───────────────────────────── */

export interface SessionUserInput {
  sessionId: string
  userId: string
}

/**
 * Publish (or re-publish) the session as a `schellingpoint.draft.proposal` in
 * the AUTHOR's repo. A second call rewrites the same rkey with `swapRecord`
 * set to the stored CID, so it is an update, not a duplicate.
 */
export async function publishProposal(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  const d = await resolveDeps(deps)
  const session = await loadSession(d.db, input.sessionId)
  if (session.host_id !== input.userId) throw new ParticipantError('forbidden', 'Only the proposal author can publish it')

  const { data: event, error: eventError } = await d.db
    .from('events')
    .select('id, gathering_uri, actor_did')
    .eq('id', session.event_id)
    .maybeSingle()
  if (eventError) throw new Error(`events get: ${eventError.message}`)
  const gatheringUri = (event?.gathering_uri as string | null) ?? null
  if (!gatheringUri) throw new ParticipantError('gathering_not_published', 'This gathering is not on the network yet')

  let trackUri: string | null = null
  if (session.track_id) {
    const { data: track } = await d.db.from('tracks').select('at_uri').eq('id', session.track_id).maybeSingle()
    trackUri = (track?.at_uri as string | null) ?? null
  }

  const profile = await linkedProfile(d.db, input.userId)
  const agent = await d.agentFor(input.userId)

  // A human's publish is never an import stub: `imported`/`importedFrom` stay absent.
  const sessionInput: ProposalSessionInput = { ...session, imported_from: null }
  const record = buildProposalRecord({ session: sessionInput, gatheringUri, trackUri })
  assertNoForeignDid(record, profile.did, { gatheringDid: (event?.actor_did as string | null) ?? undefined })

  const { rkey, existing } = rkeyFor(session.proposal_uri, profile.did, NSID.proposal)
  const result = await d.put(agent, {
    repo: profile.did,
    collection: NSID.proposal,
    rkey,
    record: record as unknown as Record<string, unknown>,
    ...(existing && session.proposal_cid ? { swapRecord: session.proposal_cid } : {}),
  })

  const { error: updateError } = await d.db
    .from('sessions')
    .update({
      proposal_uri: result.uri,
      proposal_cid: result.cid,
      host_did: profile.did,
      atproto_published_at: new Date().toISOString(),
    })
    .eq('id', session.id)
  if (updateError) throw new Error(`sessions update: ${updateError.message}`)

  await indexSelf(d.index, result, record as unknown as Record<string, unknown>)
  return result
}

/**
 * Delete the author's proposal record and clear the pointer. The session row
 * and its status are untouched: the gathering decides what happens to the
 * programme, and the author may publish again later.
 */
export async function withdrawProposal(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  const session = await loadSession(d.db, input.sessionId)
  if (session.host_id !== input.userId) throw new ParticipantError('forbidden', 'Only the proposal author can withdraw it')
  const profile = await linkedProfile(d.db, input.userId)

  const parsed = splitAtUri(session.proposal_uri)
  if (!parsed || parsed.did !== profile.did || parsed.collection !== NSID.proposal) {
    throw new ParticipantError('nothing_to_withdraw', 'No proposal record of yours to withdraw')
  }
  const agent = await d.agentFor(input.userId)
  await d.del(agent, { repo: profile.did, collection: NSID.proposal, rkey: parsed.rkey })

  const { error } = await d.db
    .from('sessions')
    .update({ proposal_uri: null, proposal_cid: null })
    .eq('id', session.id)
  if (error) throw new Error(`sessions update: ${error.message}`)
  await d.index?.remove(session.proposal_uri!)
  return { uri: session.proposal_uri! }
}

/* ────────────────────────────── cohost ────────────────────────────── */

interface CohostRow {
  id: string
  display_order: number | null
  added_at: string | null
  cohost_uri: string | null
}

async function loadCohostRow(db: SupabaseClient, sessionId: string, userId: string): Promise<CohostRow> {
  const { data, error } = await db
    .from('session_cohosts')
    .select('id, display_order, added_at, cohost_uri')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`session_cohosts get: ${error.message}`)
  if (!data) throw new ParticipantError('not_cohost', 'You are not a co-host of this session')
  return data as unknown as CohostRow
}

/** Write the co-host's own `schellingpoint.draft.cohost`, strongRef'ing the published proposal. */
export async function publishCohost(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  const d = await resolveDeps(deps)
  const session = await loadSession(d.db, input.sessionId)
  const proposal = proposalRef(session)
  const row = await loadCohostRow(d.db, input.sessionId, input.userId)
  const profile = await linkedProfile(d.db, input.userId)
  const agent = await d.agentFor(input.userId)

  const record = buildCohostRecord({
    proposal,
    role: 'cohost',
    displayOrder: row.display_order,
    createdAt: row.added_at ?? new Date(),
  })
  assertNoForeignDid(record, profile.did)

  const { rkey } = rkeyFor(row.cohost_uri, profile.did, NSID.cohost)
  const result = await d.put(agent, {
    repo: profile.did,
    collection: NSID.cohost,
    rkey,
    record: record as unknown as Record<string, unknown>,
  })

  const { error } = await d.db.from('session_cohosts').update({ cohost_uri: result.uri }).eq('id', row.id)
  if (error) throw new Error(`session_cohosts update: ${error.message}`)
  await indexSelf(d.index, result, record as unknown as Record<string, unknown>)
  return result
}

export async function withdrawCohost(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  await loadSession(d.db, input.sessionId)
  const row = await loadCohostRow(d.db, input.sessionId, input.userId)
  const profile = await linkedProfile(d.db, input.userId)
  const parsed = splitAtUri(row.cohost_uri)
  if (!parsed || parsed.did !== profile.did || parsed.collection !== NSID.cohost) {
    throw new ParticipantError('nothing_to_withdraw', 'No co-host record of yours to withdraw')
  }
  const agent = await d.agentFor(input.userId)
  await d.del(agent, { repo: profile.did, collection: NSID.cohost, rkey: parsed.rkey })
  const { error } = await d.db.from('session_cohosts').update({ cohost_uri: null }).eq('id', row.id)
  if (error) throw new Error(`session_cohosts update: ${error.message}`)
  await d.index?.remove(row.cohost_uri!)
  return { uri: row.cohost_uri! }
}

/* ──────────────────────────── endorsement ──────────────────────────── */

export const ENDORSEMENT_NOTE_MAX_GRAPHEMES = 150

/** The endorser's existing endorsement of this proposal, from the public index. */
export async function findEndorsement(
  db: SupabaseClient,
  did: string,
  proposalUri: string,
): Promise<{ uri: string; cid: string | null; record: Record<string, unknown> } | null> {
  const { data, error } = await db
    .from('at_records')
    .select('uri, cid, record')
    .eq('collection', NSID.endorsement)
    .eq('did', did)
    .eq('record->proposal->>uri', proposalUri)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`at_records get: ${error.message}`)
  return data ? { uri: data.uri as string, cid: (data.cid as string | null) ?? null, record: (data.record as Record<string, unknown>) ?? {} } : null
}

export interface EndorseInput extends SessionUserInput {
  note?: string | null
}

/**
 * Write a `schellingpoint.draft.endorsement` in the participant's repo. It is
 * a public signal to other humans, never an input to voting. Re-endorsing
 * rewrites the same record (note updates), so a person has at most one.
 */
export async function endorse(input: EndorseInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  const d = await resolveDeps(deps)
  const session = await loadSession(d.db, input.sessionId)
  if (session.host_id === input.userId) throw new ParticipantError('forbidden', 'You cannot endorse your own proposal')
  const proposal = proposalRef(session)
  const note = input.note?.trim() || null
  if (note && [...note].length > ENDORSEMENT_NOTE_MAX_GRAPHEMES) {
    throw new ParticipantError('invalid_note', `Note must be ${ENDORSEMENT_NOTE_MAX_GRAPHEMES} characters or fewer`)
  }
  const profile = await linkedProfile(d.db, input.userId)
  const agent = await d.agentFor(input.userId)

  const existing = await findEndorsement(d.db, profile.did, proposal.uri)
  const createdAt = (existing?.record.createdAt as string | undefined) ?? new Date()
  const record = buildEndorsementRecord({ proposal, note, createdAt })
  assertNoForeignDid(record, profile.did)

  const { rkey } = rkeyFor(existing?.uri, profile.did, NSID.endorsement)
  const result = await d.put(agent, {
    repo: profile.did,
    collection: NSID.endorsement,
    rkey,
    record: record as unknown as Record<string, unknown>,
  })
  await indexSelf(d.index, result, record as unknown as Record<string, unknown>)
  return result
}

export async function unendorse(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  const session = await loadSession(d.db, input.sessionId)
  if (!session.proposal_uri) throw new ParticipantError('nothing_to_withdraw', 'No endorsement of yours to remove')
  const profile = await linkedProfile(d.db, input.userId)
  const existing = await findEndorsement(d.db, profile.did, session.proposal_uri)
  const parsed = splitAtUri(existing?.uri)
  if (!existing || !parsed || parsed.did !== profile.did) {
    throw new ParticipantError('nothing_to_withdraw', 'No endorsement of yours to remove')
  }
  const agent = await d.agentFor(input.userId)
  await d.del(agent, { repo: profile.did, collection: NSID.endorsement, rkey: parsed.rkey })
  await d.index?.remove(existing.uri)
  return { uri: existing.uri }
}

/* ─────────────────────────────── rsvp ─────────────────────────────── */

export type PublicRsvpStatus = 'going' | 'interested' | 'notgoing'
export const PUBLIC_RSVP_STATUSES: readonly PublicRsvpStatus[] = ['going', 'interested', 'notgoing']

export interface PublicRsvpInput extends SessionUserInput {
  status: PublicRsvpStatus
}

interface RsvpRow {
  id: string
  rsvp_uri: string | null
}

async function loadRsvpRow(db: SupabaseClient, sessionId: string, userId: string): Promise<RsvpRow> {
  const { data, error } = await db
    .from('session_rsvps')
    .select('id, rsvp_uri')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`session_rsvps get: ${error.message}`)
  if (!data) throw new ParticipantError('no_rsvp', 'RSVP to the session first, then share it publicly')
  return data as unknown as RsvpRow
}

/**
 * Opt-in: mirror the attendee's app-side RSVP as a public
 * `community.lexicon.calendar.rsvp` in their own repo. Requires the gathering
 * to have published the session's calendar event (the strongRef subject).
 */
export async function publicRsvp(input: PublicRsvpInput, deps?: Partial<ParticipantDeps>): Promise<WriteResult> {
  if (!PUBLIC_RSVP_STATUSES.includes(input.status)) throw new ParticipantError('invalid_note', 'Invalid RSVP status')
  const d = await resolveDeps(deps)
  const session = await loadSession(d.db, input.sessionId)
  const subject = calendarEventRef(session)
  const row = await loadRsvpRow(d.db, input.sessionId, input.userId)
  const profile = await linkedProfile(d.db, input.userId)
  const agent = await d.agentFor(input.userId)

  const record = buildRsvpRecord({ subject, status: input.status })
  assertNoForeignDid(record, profile.did)

  const { rkey } = rkeyFor(row.rsvp_uri, profile.did, NSID.rsvp)
  const result = await d.put(agent, {
    repo: profile.did,
    collection: NSID.rsvp,
    rkey,
    record: record as unknown as Record<string, unknown>,
  })
  const { error } = await d.db.from('session_rsvps').update({ rsvp_uri: result.uri }).eq('id', row.id)
  if (error) throw new Error(`session_rsvps update: ${error.message}`)
  await indexSelf(d.index, result, record as unknown as Record<string, unknown>)
  return result
}

export async function retractPublicRsvp(input: SessionUserInput, deps?: Partial<ParticipantDeps>): Promise<{ uri: string }> {
  const d = await resolveDeps(deps)
  await loadSession(d.db, input.sessionId)
  const row = await loadRsvpRow(d.db, input.sessionId, input.userId)
  const profile = await linkedProfile(d.db, input.userId)
  const parsed = splitAtUri(row.rsvp_uri)
  if (!parsed || parsed.did !== profile.did || parsed.collection !== NSID.rsvp) {
    throw new ParticipantError('nothing_to_withdraw', 'No public RSVP of yours to retract')
  }
  const agent = await d.agentFor(input.userId)
  await d.del(agent, { repo: profile.did, collection: NSID.rsvp, rkey: parsed.rkey })
  const { error } = await d.db.from('session_rsvps').update({ rsvp_uri: null }).eq('id', row.id)
  if (error) throw new Error(`session_rsvps update: ${error.message}`)
  await d.index?.remove(row.rsvp_uri!)
  return { uri: row.rsvp_uri! }
}
