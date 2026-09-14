import 'server-only'
/**
 * Ingest: network records → `at_records` (+ app-side side effects).
 *
 * One function, `ingestRecord`, is the whole contract. Both feeds go through
 * it — the Jetstream consumer (`scripts/atproto-indexer.ts`, live, via
 * `ingestFromJetstreamFrame`) and the cron reconciliation (`/api/atproto/sync`,
 * at-least-once, via `reconcileAll`) — so the two can never disagree about
 * what a record means for the app.
 *
 * Rules (docs/ATPROTO_IMPLEMENTATION.md §4, docs/ATPROTO_MIGRATION_SPEC.md §6):
 *   - every record in `INDEXED_COLLECTIONS` is validated locally and indexed;
 *     invalid records are skipped and logged, never partially indexed
 *   - a `schellingpoint.draft.proposal` offered to a gathering we host links
 *     to `sessions` (create pending / update content / withdraw on delete);
 *     a proposal written by the gathering actor itself (a stub) is index-only
 *   - cid drift on a SCHEDULED session never overwrites content: an `at_audit`
 *     row (`proposal-drift`) records it for the organiser to review
 *   - `schellingpoint.draft.cohost` pairs with `session_cohosts` only when the
 *     author's DID is linked to a profile (double opt-in, both halves present)
 *   - everything the gathering actor writes (calendar events, configs, slots,
 *     grids, venues, tracks, tallies, the gathering itself) is index-only: the
 *     app is the source of truth for those and wrote them in the first place
 *   - endorsements and RSVPs are index-only
 *
 * Nothing here ever invents a person: an imported session has `host_id` =
 * the linked profile or NULL, `host_name` NULL, `host_did` = the author.
 */
import { createAdminClient } from '@/lib/supabase/server'
import { jetstreamUrl } from './config'
import { atUri } from './identity'
import { deleteIndexedRecord, getIndexedRecord, upsertIndexedRecord, setCursor, getCursor } from './index-store'
import { INDEXED_COLLECTIONS, NSID } from './nsids'
import type { CohostRecord, ProposalRecord } from './types'
import { isValidRecord } from './validate'
import { listRecords } from './write'

/* ───────────────────────────── types ───────────────────────────── */

export type IngestOperation = 'create' | 'update' | 'delete'

export interface IngestInput {
  uri: string
  did: string
  collection: string
  rkey: string
  cid?: string | null
  /** Absent on delete. */
  record?: Record<string, unknown> | null
  /** `jetstream`, `backfill:<did>`, … — lands in `at_records.source`. */
  source: string
  operation: IngestOperation
  /** Jetstream `time_us` (unix microseconds) when known. */
  timeUs?: number
}

export type IngestOutcome =
  | 'indexed'
  | 'deleted'
  | 'skipped:collection'
  | 'skipped:invalid'
  | 'skipped:no-record'

export interface IngestResult {
  uri: string
  collection: string
  operation: IngestOperation
  outcome: IngestOutcome
  /** App-side effects that happened (`session-created`, `session-updated`, …). */
  sideEffects: string[]
  /** Non-fatal problems (a trigger rejected an insert, an update was refused, …). */
  warnings: string[]
}

/**
 * A Jetstream v1 (`/subscribe`) frame. Validated against the live stream and
 * the Jetstream RFD (§5.1): `record` and `cid` are absent on `delete`;
 * `identity`/`account` frames carry no `commit`. `cursor` only exists on v2.
 */
export interface JetstreamFrame {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account' | string
  cursor?: number
  commit?: {
    rev: string
    operation: IngestOperation
    collection: string
    rkey: string
    cid?: string
    record?: Record<string, unknown>
  }
  identity?: Record<string, unknown>
  account?: Record<string, unknown>
}

export interface ReconcileRepoResult {
  did: string
  records: number
  deleted: number
  errors: string[]
}

export interface ReconcileAllResult {
  repos: number
  records: number
  deleted: number
  errors: { did: string; error: string }[]
  startedAt: string
  finishedAt: string
}

/* ───────────────────────────── constants ───────────────────────────── */

export const WITHDRAWN_REASON = 'Proposal withdrawn by the author on the network'
export const JETSTREAM_CURSOR_SOURCE = 'jetstream'
export const RECONCILE_CURSOR_SOURCE = 'reconcile'

/** Collections a PERSON's repo can hold that matter to us (reconciliation scope for `profiles.did`). */
export const PARTICIPANT_COLLECTIONS: readonly string[] = [
  NSID.proposal,
  NSID.cohost,
  NSID.endorsement,
  NSID.timePreference,
  NSID.rsvp,
]

/** What `sessions.format` accepts (CHECK constraint, `20260205100000_ethboulder_schema_extensions.sql`). */
const SESSION_FORMATS = ['talk', 'workshop', 'discussion', 'panel', 'demo', 'fireside', 'ceremony'] as const
const FALLBACK_FORMAT = 'discussion'

const indexed = new Set<string>(INDEXED_COLLECTIONS)

export function isIndexedCollection(nsid: string): boolean {
  return indexed.has(nsid)
}

function log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void {
  const line = `[atproto:ingest] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`
  if (level === 'warn') console.warn(line)
  else console.log(line)
}

/* ───────────────────────────── URL helper ───────────────────────────── */

/**
 * The Jetstream v1 subscribe URL: `wantedCollections` repeated per NSID and an
 * optional `cursor` (unix microseconds; inclusive, at-least-once replay).
 */
export function jetstreamSubscribeUrl(collections: readonly string[], cursor?: string | number | null): string {
  const url = new URL(jetstreamUrl())
  for (const c of collections) url.searchParams.append('wantedCollections', c)
  if (cursor !== undefined && cursor !== null && String(cursor).trim() !== '') {
    url.searchParams.set('cursor', String(cursor))
  }
  return url.toString()
}

/* ───────────────────────────── main entry ───────────────────────────── */

export async function ingestRecord(input: IngestInput): Promise<IngestResult> {
  const result: IngestResult = {
    uri: input.uri,
    collection: input.collection,
    operation: input.operation,
    outcome: 'indexed',
    sideEffects: [],
    warnings: [],
  }
  if (!isIndexedCollection(input.collection)) {
    result.outcome = 'skipped:collection'
    return result
  }

  if (input.operation === 'delete') {
    const previous = await getIndexedRecord(input.uri)
    await deleteIndexedRecord(input.uri)
    result.outcome = 'deleted'
    await applyDeleteSideEffects(input, previous?.record ?? null, result)
    return result
  }

  if (!input.record || typeof input.record !== 'object') {
    result.outcome = 'skipped:no-record'
    log('warn', 'commit without a record body', { uri: input.uri, operation: input.operation })
    return result
  }
  if (!isValidRecord(input.collection, input.record)) {
    result.outcome = 'skipped:invalid'
    log('warn', 'record failed lexicon validation; not indexed', { uri: input.uri, collection: input.collection })
    return result
  }

  await upsertIndexedRecord({
    uri: input.uri,
    did: input.did,
    collection: input.collection,
    rkey: input.rkey,
    cid: input.cid ?? null,
    record: input.record,
    source: input.source,
  })
  await applyUpsertSideEffects(input, result)
  return result
}

/** Parse one Jetstream frame and ingest it. `null` when the frame is not a commit we index. */
export async function ingestFromJetstreamFrame(
  frame: JetstreamFrame,
  source = JETSTREAM_CURSOR_SOURCE,
): Promise<IngestResult | null> {
  if (!frame || frame.kind !== 'commit' || !frame.commit) return null
  const { commit } = frame
  if (!commit.collection || !commit.rkey || !frame.did) return null
  if (!isIndexedCollection(commit.collection)) return null
  if (commit.operation !== 'create' && commit.operation !== 'update' && commit.operation !== 'delete') return null
  return ingestRecord({
    uri: atUri(frame.did, commit.collection, commit.rkey),
    did: frame.did,
    collection: commit.collection,
    rkey: commit.rkey,
    cid: commit.cid ?? null,
    record: commit.record ?? null,
    source,
    operation: commit.operation,
    timeUs: frame.time_us,
  })
}

/* ───────────────────────────── side effects ───────────────────────────── */

async function applyUpsertSideEffects(input: IngestInput, result: IngestResult): Promise<void> {
  try {
    if (input.collection === NSID.proposal) {
      await linkProposal(input, input.record as unknown as ProposalRecord, result)
    } else if (input.collection === NSID.cohost) {
      await linkCohost(input, input.record as unknown as CohostRecord, result)
    }
    // Everything else — the gathering's own records, endorsements, RSVPs — is index-only.
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.warnings.push(`side effect failed: ${msg}`)
    log('warn', 'side effect failed', { uri: input.uri, error: msg })
  }
}

async function applyDeleteSideEffects(
  input: IngestInput,
  previous: Record<string, unknown> | null,
  result: IngestResult,
): Promise<void> {
  try {
    if (input.collection === NSID.proposal) {
      await withdrawLinkedSession(input, result)
    } else if (input.collection === NSID.cohost) {
      await unlinkCohost(input, previous, result)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.warnings.push(`delete side effect failed: ${msg}`)
    log('warn', 'delete side effect failed', { uri: input.uri, error: msg })
  }
}

interface HostedEvent {
  id: string
  slug: string
  actor_did: string | null
  allowed_formats: string[] | null
  allowed_durations: number[] | null
}

async function hostedEventForGathering(gatheringUri: string | undefined): Promise<HostedEvent | null> {
  if (!gatheringUri) return null
  const db = await createAdminClient()
  const { data, error } = await db
    .from('events')
    .select('id, slug, actor_did, allowed_formats, allowed_durations')
    .eq('gathering_uri', gatheringUri)
    .maybeSingle()
  if (error) throw new Error(`events lookup: ${error.message}`)
  return (data as HostedEvent | null) ?? null
}

async function profileIdForDid(did: string): Promise<string | null> {
  const db = await createAdminClient()
  const { data, error } = await db.from('profiles').select('id').eq('did', did).maybeSingle()
  if (error) throw new Error(`profiles lookup: ${error.message}`)
  return (data?.id as string | undefined) ?? null
}

/** Map a record's `format` onto what `sessions.format` and the event allow. */
export function coerceFormat(format: string | undefined, allowed: string[] | null | undefined): string {
  const known = (SESSION_FORMATS as readonly string[]).includes(format ?? '') ? (format as string) : FALLBACK_FORMAT
  if (!allowed || allowed.length === 0) return known
  if (allowed.includes(known)) return known
  return allowed.includes(FALLBACK_FORMAT) ? FALLBACK_FORMAT : allowed[0]
}

/** Snap a duration to the nearest value the event allows (ties go to the shorter slot). */
export function coerceDuration(minutes: number | undefined, allowed: number[] | null | undefined): number | null {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.trunc(minutes) : null
  if (!allowed || allowed.length === 0) return value
  if (value === null) return allowed[0]
  return [...allowed].sort((a, b) => a - b).reduce((best, d) => (Math.abs(d - value) < Math.abs(best - value) ? d : best))
}

function contentFromProposal(record: ProposalRecord, event: HostedEvent) {
  return {
    title: record.title,
    description: record.description ?? null,
    format: coerceFormat(record.format, event.allowed_formats),
    duration: coerceDuration(record.durationMinutes, event.allowed_durations),
    topic_tags: record.topics ?? [],
    expected_attendance: record.expectedAttendance ?? null,
    required_features: record.requiredFeatures ?? [],
    is_self_hosted: record.selfHosted === true,
    custom_location: record.selfHosted ? (record.place ?? null) : null,
    self_hosted_start_time: record.selfHosted ? (record.startsAt ?? null) : null,
    self_hosted_end_time: record.selfHosted ? (record.endsAt ?? null) : null,
  }
}

interface LinkedSession {
  id: string
  status: string | null
  host_id: string | null
  proposal_cid: string | null
  imported_from: string | null
  event_id: string
}

async function sessionForProposal(uri: string): Promise<LinkedSession | null> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('sessions')
    .select('id, status, host_id, proposal_cid, imported_from, event_id')
    .eq('proposal_uri', uri)
    .maybeSingle()
  if (error) throw new Error(`sessions lookup: ${error.message}`)
  return (data as LinkedSession | null) ?? null
}

async function audit(row: {
  eventId: string | null
  actorDid: string | null
  action: string
  collection: string
  rkey: string
  uri: string
  decision: 'allow' | 'deny'
  reason: string
}): Promise<void> {
  const db = await createAdminClient()
  const { error } = await db.from('at_audit').insert({
    event_id: row.eventId,
    actor_did: row.actorDid,
    caller_user_id: null,
    action: row.action,
    collection: row.collection,
    rkey: row.rkey,
    uri: row.uri,
    decision: row.decision,
    reason: row.reason,
  })
  if (error) throw new Error(`at_audit insert: ${error.message}`)
}

async function linkProposal(input: IngestInput, record: ProposalRecord, result: IngestResult): Promise<void> {
  const event = await hostedEventForGathering(record.gathering)
  if (!event) return // offered to a gathering we do not host: index only

  // A proposal written by the gathering actor is a stub the app itself wrote
  // (spec §11 phase 3); so is anything flagged `imported`. Index-only.
  if ((event.actor_did && input.did === event.actor_did) || record.imported === true) {
    result.sideEffects.push('stub:index-only')
    return
  }

  const db = await createAdminClient()
  const existing = await sessionForProposal(input.uri)
  if (existing) {
    const drifted = !!existing.proposal_cid && !!input.cid && existing.proposal_cid !== input.cid
    if (existing.status === 'scheduled' && drifted) {
      await audit({
        eventId: event.id,
        actorDid: event.actor_did,
        action: 'proposal-drift',
        collection: input.collection,
        rkey: input.rkey,
        uri: input.uri,
        decision: 'allow',
        reason: `session ${existing.id} is scheduled against cid ${existing.proposal_cid}; the proposer's record is now ${input.cid}. Content left untouched — review and re-publish.`,
      })
      result.sideEffects.push('proposal-drift')
      log('info', 'proposal drift on a scheduled session; content left untouched', { uri: input.uri, session: existing.id })
      return
    }
    const { error } = await db
      .from('sessions')
      .update({
        ...contentFromProposal(record, event),
        proposal_cid: input.cid ?? existing.proposal_cid,
        host_did: input.did,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (error) throw new Error(`sessions update: ${error.message}`)
    result.sideEffects.push('session-updated')
    return
  }

  const hostId = await profileIdForDid(input.did)
  const { error } = await db.from('sessions').insert({
    event_id: event.id,
    ...contentFromProposal(record, event),
    host_id: hostId,
    host_name: null, // never invented: the record names nobody and neither do we
    host_did: input.did,
    imported_from: 'atproto',
    status: 'pending',
    session_type: 'proposed',
    proposal_uri: input.uri,
    proposal_cid: input.cid ?? null,
    created_at: record.createdAt ?? new Date().toISOString(),
  })
  if (error) {
    // `enforce_event_proposal_rules` (BEFORE INSERT) rejects when proposals are
    // closed or the host is not a member. The record stays indexed; the next
    // reconcile retries, and the audit row tells the organiser why it is missing.
    await audit({
      eventId: event.id,
      actorDid: event.actor_did,
      action: 'proposal-ingest',
      collection: input.collection,
      rkey: input.rkey,
      uri: input.uri,
      decision: 'deny',
      reason: `sessions insert rejected: ${error.message}`,
    })
    result.warnings.push(`session not created: ${error.message}`)
    log('warn', 'sessions insert rejected; record indexed without a session row', { uri: input.uri, error: error.message })
    return
  }
  result.sideEffects.push('session-created')
}

async function withdrawLinkedSession(input: IngestInput, result: IngestResult): Promise<void> {
  const existing = await sessionForProposal(input.uri)
  if (!existing) return
  const db = await createAdminClient()
  const { error } = await db
    .from('sessions')
    .update({ status: 'rejected', rejection_reason: WITHDRAWN_REASON, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
  if (!error) {
    result.sideEffects.push('session-withdrawn')
    return
  }
  // `trigger_session_status_change` notifies the host on pending→rejected and
  // `notifications.user_id` is NOT NULL: a host-less pending import cannot be
  // marked rejected. Ingest created that row from the record; the record is
  // gone, nothing app-side depends on a pending row, so remove it.
  if (existing.host_id === null && existing.status === 'pending' && existing.imported_from === 'atproto') {
    const { error: delError } = await db.from('sessions').delete().eq('id', existing.id)
    if (delError) throw new Error(`sessions delete after withdrawal: ${delError.message}`)
    result.sideEffects.push('session-deleted')
    result.warnings.push(`withdrawal could not be recorded as rejected (${error.message}); pending host-less import removed`)
    return
  }
  throw new Error(`sessions withdraw: ${error.message}`)
}

async function linkCohost(input: IngestInput, record: CohostRecord, result: IngestResult): Promise<void> {
  const proposalUri = record.proposal?.uri
  if (!proposalUri) return
  const session = await sessionForProposal(proposalUri)
  if (!session) return
  const userId = await profileIdForDid(input.did)
  if (!userId) {
    result.sideEffects.push('cohost:unlinked-did')
    return // their half is public; ours needs a linked profile to pair with
  }
  const db = await createAdminClient()
  const { error } = await db
    .from('session_cohosts')
    .upsert(
      { session_id: session.id, user_id: userId, event_id: session.event_id, cohost_uri: input.uri },
      { onConflict: 'session_id,user_id' },
    )
  if (error) throw new Error(`session_cohosts upsert: ${error.message}`)
  result.sideEffects.push('cohost-linked')
}

async function unlinkCohost(input: IngestInput, _previous: Record<string, unknown> | null, result: IngestResult): Promise<void> {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('session_cohosts')
    .select('id, session_id, sessions!inner(imported_from)')
    .eq('cohost_uri', input.uri)
  if (error) throw new Error(`session_cohosts lookup: ${error.message}`)
  for (const row of (data ?? []) as unknown as { id: string; session_id: string; sessions: { imported_from: string | null } }[]) {
    // Rows on an imported session can only have come from ingest: remove them.
    // Rows on an app-native session may predate the record (in-app accept):
    // keep the pairing, drop the public half.
    if (row.sessions?.imported_from === 'atproto') {
      const { error: delError } = await db.from('session_cohosts').delete().eq('id', row.id)
      if (delError) throw new Error(`session_cohosts delete: ${delError.message}`)
      result.sideEffects.push('cohost-removed')
    } else {
      const { error: updError } = await db.from('session_cohosts').update({ cohost_uri: null }).eq('id', row.id)
      if (updError) throw new Error(`session_cohosts update: ${updError.message}`)
      result.sideEffects.push('cohost-uri-cleared')
    }
  }
}

/* ───────────────────────────── reconciliation ───────────────────────────── */

/**
 * `listRecords` every collection in a repo and ingest each; then delete from
 * `at_records` anything we hold for that (did, collection) that the repo no
 * longer has. One error boundary per collection so a PDS hiccup on one
 * collection does not hide the others.
 */
export async function reconcileRepo(
  did: string,
  collections: readonly string[] = INDEXED_COLLECTIONS,
): Promise<ReconcileRepoResult> {
  const out: ReconcileRepoResult = { did, records: 0, deleted: 0, errors: [] }
  const db = await createAdminClient()
  const source = `backfill:${did}`
  for (const collection of collections) {
    if (!isIndexedCollection(collection)) continue
    try {
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await listRecords(did, collection, { limit: 100, cursor })
        for (const r of page.records) {
          seen.add(r.uri)
          const parsed = r.uri.split('/')
          const rkey = parsed[parsed.length - 1]
          const res = await ingestRecord({
            uri: r.uri,
            did,
            collection,
            rkey,
            cid: r.cid || null,
            record: r.value,
            source,
            operation: 'update',
          })
          if (res.outcome === 'indexed') out.records++
        }
        cursor = page.cursor
      } while (cursor)

      const { data, error } = await db.from('at_records').select('uri, rkey').eq('did', did).eq('collection', collection)
      if (error) throw new Error(`at_records list: ${error.message}`)
      for (const row of (data ?? []) as { uri: string; rkey: string }[]) {
        if (seen.has(row.uri)) continue
        await ingestRecord({ uri: row.uri, did, collection, rkey: row.rkey, source, operation: 'delete' })
        out.deleted++
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      out.errors.push(`${collection}: ${msg}`)
      log('warn', 'reconcile failed for a collection', { did, collection, error: msg })
    }
  }
  return out
}

/** Every DID we know about, with the collections each is expected to hold. */
export async function knownRepos(): Promise<Map<string, Set<string>>> {
  const db = await createAdminClient()
  const repos = new Map<string, Set<string>>()
  const add = (did: string | null | undefined, cols: readonly string[]) => {
    if (!did) return
    const set = repos.get(did) ?? new Set<string>()
    for (const c of cols) set.add(c)
    repos.set(did, set)
  }
  const { data: events, error: eErr } = await db.from('events').select('actor_did').not('actor_did', 'is', null)
  if (eErr) throw new Error(`events actor_did: ${eErr.message}`)
  for (const e of (events ?? []) as { actor_did: string | null }[]) add(e.actor_did, INDEXED_COLLECTIONS)
  const { data: profiles, error: pErr } = await db.from('profiles').select('did').not('did', 'is', null)
  if (pErr) throw new Error(`profiles did: ${pErr.message}`)
  for (const p of (profiles ?? []) as { did: string | null }[]) add(p.did, PARTICIPANT_COLLECTIONS)
  return repos
}

/** Reconcile every gathering actor and every linked profile. Never throws for a single repo. */
export async function reconcileAll(): Promise<ReconcileAllResult> {
  const startedAt = new Date().toISOString()
  const out: ReconcileAllResult = { repos: 0, records: 0, deleted: 0, errors: [], startedAt, finishedAt: startedAt }
  const repos = await knownRepos()
  for (const [did, cols] of repos) {
    out.repos++
    try {
      const r = await reconcileRepo(did, [...cols])
      out.records += r.records
      out.deleted += r.deleted
      for (const err of r.errors) out.errors.push({ did, error: err })
    } catch (e) {
      out.errors.push({ did, error: e instanceof Error ? e.message : String(e) })
    }
  }
  out.finishedAt = new Date().toISOString()
  await setCursor(RECONCILE_CURSOR_SOURCE, out.finishedAt)
  log('info', 'reconcileAll finished', { repos: out.repos, records: out.records, deleted: out.deleted, errors: out.errors.length })
  return out
}

/** For the indexer's startup warning: how full the index is and when it was last reconciled. */
export async function indexStats(): Promise<{ records: number; reconciledAt: string | null }> {
  const db = await createAdminClient()
  const { count, error } = await db.from('at_records').select('uri', { count: 'exact', head: true })
  if (error) throw new Error(`at_records count: ${error.message}`)
  return { records: count ?? 0, reconciledAt: await getCursor(RECONCILE_CURSOR_SOURCE) }
}
