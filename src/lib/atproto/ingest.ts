import 'server-only'
/**
 * Ingest: network records → `at_records` (+ app-side side effects).
 *
 * One function, `ingestRecord`, is the whole contract. Every feed goes through it — the Jetstream
 * consumer (`scripts/atproto-indexer.ts`, live), and `listRecords` reconciliation
 * (`/api/atproto/sync`, at-least-once) — so the feeds can never disagree about what a record means.
 *
 * Rules (spec §6, plan §6 items 16–22):
 *   - relevance first: a record is indexed only when its repo is one we know (our PDS, a linked
 *     OAuth account, a gathering actor, a peer, the skills authority) or it references something
 *     of ours (a gathering we host, a proposal or calendar event on our schedule). Jetstream
 *     carries the whole network's calendar events; we do not mirror the network.
 *   - every record is lexicon-validated; an invalid one is skipped and logged, never partially
 *     indexed. Per-record error boundary: one bad record never stops a batch or a stream.
 *   - a proposal offered to a gathering we host links to `sessions`. A proposal on the PUBLISHED
 *     schedule is never overwritten: a changed cid is cid drift (organisers flagged + notified).
 *     A deleted proposal is a withdrawal (flagged + notified); the schedule is never auto-changed.
 *   - a `schellingpoint.draft.cohost` pairs with `session_cohosts` only when the proposer's half
 *     of the double opt-in exists (an accepted invite or an existing pairing).
 *   - everything the gathering actor writes is index-only (the app wrote it).
 *
 * Nothing here invents a person: an imported session has `host_id` = the linked account or NULL,
 * `host_name` NULL, `host_did` = the author.
 */
import { sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { jetstreamUrl, pdsInternalUrl } from './config'
import { checkProposalDrift, flagProposalWithdrawn } from './drift'
import { atUri } from './identity'
import { advanceCursor, deleteIndexedRecord, getCursor, getIndexedRecord, listIndexedKeys, setCursor, upsertIndexedRecord } from './index-store'
import { GATHERING_COLLECTIONS, INDEXED_COLLECTIONS, JETSTREAM_COLLECTIONS, NSID, PARTICIPANT_COLLECTIONS } from './nsids'
import { routePeerListings } from './listings'
import { materializeAllSeries } from './series'
import { ensureSkillsFresh, skillsAuthorityDid } from './skills'
import type { CohostRecord, ProposalRecord } from './types'
import { isValidRecord } from './validate'
import { listAllRecords } from './write'

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
  /** Skip the relevance filter (reconciliation of a repo we already chose to follow). */
  trusted?: boolean
}

export type IngestOutcome =
  | 'indexed'
  | 'deleted'
  | 'skipped:collection'
  | 'skipped:irrelevant'
  | 'skipped:invalid'
  | 'skipped:no-record'
  | 'error'

export interface IngestResult {
  uri: string
  collection: string
  operation: IngestOperation
  outcome: IngestOutcome
  sideEffects: string[]
  warnings: string[]
}

/** A Jetstream v1 frame: `record`/`cid` absent on delete; identity/account frames have no commit. */
export interface JetstreamFrame {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account' | string
  commit?: {
    rev: string
    operation: IngestOperation
    collection: string
    rkey: string
    cid?: string
    record?: Record<string, unknown>
  }
}

export interface ReconcileRepoResult {
  did: string
  records: number
  deleted: number
  errors: string[]
}

export interface ReconcileAllResult {
  /** Occurrences of recurring gatherings written by this run. */
  series?: { series: number; written: number; errors: number }
  repos: number
  records: number
  deleted: number
  listings: number
  skills: { refreshedAt: string | null; stale: boolean } | { error: string }
  errors: { did: string; error: string }[]
  startedAt: string
  finishedAt: string
}

/* ───────────────────────────── constants ───────────────────────────── */

export const WITHDRAWN_REASON = 'Proposal withdrawn by the author on the network'
export const JETSTREAM_CURSOR_SOURCE = 'jetstream'
export const RECONCILE_CURSOR_SOURCE = 'reconcile'
export { PARTICIPANT_COLLECTIONS }

const SESSION_FORMATS = ['talk', 'workshop', 'discussion', 'panel', 'demo', 'fireside', 'ceremony'] as const
const FALLBACK_FORMAT = 'discussion'

const indexed = new Set<string>([...INDEXED_COLLECTIONS, NSID.skill])

export function isIndexedCollection(nsid: string): boolean {
  return indexed.has(nsid)
}

/** Logs carry collections and outcomes, never DIDs, handles or record bodies (R9). */
function log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void {
  const line = `[atproto:ingest] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`
  if (level === 'warn') console.warn(line)
  else console.log(line)
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

/** The Jetstream v1 subscribe URL: `wantedCollections` per NSID and an optional `cursor` (µs). */
export function jetstreamSubscribeUrl(collections: readonly string[] = JETSTREAM_COLLECTIONS, cursor?: string | number | null): string {
  const url = new URL(jetstreamUrl())
  for (const c of collections) url.searchParams.append('wantedCollections', c)
  if (cursor !== undefined && cursor !== null && String(cursor).trim() !== '') url.searchParams.set('cursor', String(cursor))
  return url.toString()
}

/* ───────────────────────────── relevance ───────────────────────────── */

const knownCache = { at: 0, dids: new Set<string>() }
const KNOWN_TTL_MS = 60 * 1000

/** Repos we follow: accounts (both doors), gathering actors, peers, the skills authority. */
export async function knownDids(force = false): Promise<Set<string>> {
  if (!force && Date.now() - knownCache.at < KNOWN_TTL_MS) return knownCache.dids
  const rows = await sql<{ did: string }[]>`
    select did from accounts
    union select actor_did from events where actor_did is not null
    union select peer_did from peers
  `
  const dids = new Set(rows.map((r) => r.did))
  dids.add(skillsAuthorityDid())
  knownCache.dids = dids
  knownCache.at = Date.now()
  return dids
}

async function referencesOurs(input: IngestInput): Promise<boolean> {
  const r = input.record ?? {}
  if (input.collection === NSID.proposal && typeof r.gathering === 'string') {
    return !!(await hostedEventForGathering(r.gathering))
  }
  const refUri =
    input.collection === NSID.rsvp ? (r.subject as { uri?: string } | undefined)?.uri
    : (r.proposal as { uri?: string } | undefined)?.uri ?? (r.event as { uri?: string } | undefined)?.uri
  if (!refUri) return false
  const hit = await sql`
    select 1 from sessions where proposal_uri = ${refUri} or calendar_event_uri = ${refUri}
    union all select 1 from events where calendar_event_uri = ${refUri}
    limit 1
  `
  return hit.length > 0
}

/* ───────────────────────────── main entry ───────────────────────────── */

export async function ingestRecord(input: IngestInput): Promise<IngestResult> {
  const result: IngestResult = { uri: input.uri, collection: input.collection, operation: input.operation, outcome: 'indexed', sideEffects: [], warnings: [] }
  try {
    if (!isIndexedCollection(input.collection)) {
      result.outcome = 'skipped:collection'
      return result
    }
    if (input.collection === NSID.skill && input.did !== skillsAuthorityDid()) {
      result.outcome = 'skipped:irrelevant' // only the authority's taxonomy is ours to cache
      return result
    }

    if (input.operation === 'delete') {
      const previous = await getIndexedRecord(input.uri)
      if (!previous && !input.trusted && !(await knownDids()).has(input.did)) {
        result.outcome = 'skipped:irrelevant'
        return result
      }
      await deleteIndexedRecord(input.uri)
      result.outcome = 'deleted'
      await applyDeleteSideEffects(input, result)
      return result
    }

    if (!input.record || typeof input.record !== 'object') {
      result.outcome = 'skipped:no-record'
      return result
    }
    if (!input.trusted && !(await knownDids()).has(input.did) && !(await referencesOurs(input))) {
      result.outcome = 'skipped:irrelevant'
      return result
    }
    if (!isValidRecord(input.collection, input.record)) {
      result.outcome = 'skipped:invalid'
      log('warn', 'record failed lexicon validation; not indexed', { collection: input.collection })
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
  } catch (e) {
    result.outcome = 'error'
    result.warnings.push(describe(e))
    log('warn', 'ingest failed for one record', { collection: input.collection, operation: input.operation, error: e instanceof Error ? e.name : 'error' })
    return result
  }
}

/** Parse one Jetstream frame and ingest it. `null` when the frame is not a commit we index. */
export async function ingestFromJetstreamFrame(frame: JetstreamFrame, source = JETSTREAM_CURSOR_SOURCE): Promise<IngestResult | null> {
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
  })
}

/** Persist the Jetstream position monotonically (a late batch never walks the cursor back). */
export async function persistJetstreamCursor(timeUs: number): Promise<string> {
  return advanceCursor(JETSTREAM_CURSOR_SOURCE, Math.trunc(timeUs))
}

/* ───────────────────────────── side effects ───────────────────────────── */

async function applyUpsertSideEffects(input: IngestInput, result: IngestResult): Promise<void> {
  if (input.collection === NSID.proposal) await linkProposal(input, input.record as unknown as ProposalRecord, result)
  else if (input.collection === NSID.cohost) await linkCohost(input, input.record as unknown as CohostRecord, result)
}

async function applyDeleteSideEffects(input: IngestInput, result: IngestResult): Promise<void> {
  if (input.collection === NSID.proposal) await withdrawLinkedSession(input, result)
  else if (input.collection === NSID.cohost) {
    const rows = await sql<{ id: string }[]>`update session_cohosts set cohost_uri = null where cohost_uri = ${input.uri} returning id`
    if (rows.length) result.sideEffects.push('cohost-record-cleared')
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
  const m = /^at:\/\/([^/]+)\/schellingpoint\.draft\.gathering\/self$/.exec(gatheringUri)
  const rows = await sql<HostedEvent[]>`
    select id, slug, actor_did, allowed_formats, allowed_durations from events
    where gathering_uri = ${gatheringUri} ${m ? sql`or actor_did = ${m[1]!}` : sql``}
    limit 1
  `
  return rows[0] ?? null
}

/** Map a record's `format` onto what `sessions.format` and the event allow. */
export function coerceFormat(format: string | undefined, allowed: string[] | null | undefined): string {
  const known = (SESSION_FORMATS as readonly string[]).includes(format ?? '') ? (format as string) : FALLBACK_FORMAT
  if (!allowed || allowed.length === 0) return known
  if (allowed.includes(known)) return known
  return allowed.includes(FALLBACK_FORMAT) ? FALLBACK_FORMAT : allowed[0]!
}

/** Snap a duration to the nearest value the event allows (ties go to the shorter slot). */
export function coerceDuration(minutes: number | undefined, allowed: number[] | null | undefined): number | null {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.trunc(minutes) : null
  if (!allowed || allowed.length === 0) return value
  if (value === null) return allowed[0]!
  return [...allowed].sort((a, b) => a - b).reduce((best, d) => (Math.abs(d - value) < Math.abs(best - value) ? d : best))
}

interface LinkedSession {
  id: string
  event_id: string
  status: string | null
  host_id: string | null
  proposal_cid: string | null
  slot_uri: string | null
  imported_from: string | null
  proposal_withdrawn_at: string | null
}

async function sessionForProposal(uri: string): Promise<LinkedSession | null> {
  const rows = await sql<LinkedSession[]>`
    select id, event_id, status, host_id, proposal_cid, slot_uri, imported_from, proposal_withdrawn_at
    from sessions where proposal_uri = ${uri} limit 1
  `
  return rows[0] ?? null
}

async function linkProposal(input: IngestInput, record: ProposalRecord, result: IngestResult): Promise<void> {
  const event = await hostedEventForGathering(record.gathering)
  if (!event) return // offered to a gathering we do not host: index only

  // A proposal in the gathering's own repo is a stub the app wrote (spec §11 phase 3).
  if ((event.actor_did && input.did === event.actor_did) || record.imported === true) {
    result.sideEffects.push('stub:index-only')
    return
  }

  const existing = await sessionForProposal(input.uri)
  if (existing) {
    if (existing.event_id !== event.id) {
      result.warnings.push('proposal re-targeted to a different gathering; the existing session is left untouched')
      return
    }
    if (existing.proposal_withdrawn_at) {
      await sql`update sessions set proposal_withdrawn_at = null where id = ${existing.id}`
      result.sideEffects.push('withdrawal-cleared')
    }
    if (existing.slot_uri && input.cid) {
      // On the published schedule: never overwrite; flag drift for the organisers.
      const outcome = await checkProposalDrift({ sessionId: existing.id, currentCid: input.cid })
      await sql`update sessions set proposal_cid = ${input.cid} where id = ${existing.id}`
      result.sideEffects.push(`drift:${outcome}`)
      return
    }
    if (input.cid && existing.proposal_cid === input.cid) return
    await sql`
      update sessions set
        title = ${record.title}, description = ${record.description ?? null},
        format = ${coerceFormat(record.format, event.allowed_formats)},
        duration = ${coerceDuration(record.durationMinutes, event.allowed_durations)},
        topic_tags = ${record.topics ?? []}, skill_uris = ${(record.skills ?? []).slice(0, 5)},
        expected_attendance = ${record.expectedAttendance ?? null}, required_features = ${record.requiredFeatures ?? []},
        is_self_hosted = ${record.selfHosted === true},
        public_place = ${record.selfHosted ? (record.place?.slice(0, 200) ?? null) : null},
        self_hosted_start_time = ${record.selfHosted ? (record.startsAt ?? null) : null},
        self_hosted_end_time = ${record.selfHosted ? (record.endsAt ?? null) : null},
        proposal_cid = ${input.cid ?? existing.proposal_cid}, host_did = ${input.did}, updated_at = now()
      where id = ${existing.id}
    `
    result.sideEffects.push('session-updated')
    return
  }

  const [account] = await sql<{ id: string }[]>`select id from accounts where did = ${input.did}`
  try {
    const inserted = await sql.begin(async (t) => {
      const rows = await t<{ id: string }[]>`
        insert into sessions (
          event_id, title, description, format, duration, topic_tags, skill_uris, expected_attendance, required_features,
          is_self_hosted, public_place, self_hosted_start_time, self_hosted_end_time,
          host_id, host_name, host_did, imported_from, status, session_type, proposal_uri, proposal_cid, created_at
        ) values (
          ${event.id}, ${record.title}, ${record.description ?? null}, ${coerceFormat(record.format, event.allowed_formats)},
          ${coerceDuration(record.durationMinutes, event.allowed_durations)}, ${record.topics ?? []}, ${(record.skills ?? []).slice(0, 5)},
          ${record.expectedAttendance ?? null}, ${record.requiredFeatures ?? []}, ${record.selfHosted === true},
          ${record.selfHosted ? (record.place?.slice(0, 200) ?? null) : null}, ${record.selfHosted ? (record.startsAt ?? null) : null},
          ${record.selfHosted ? (record.endsAt ?? null) : null},
          ${account?.id ?? null}, null, ${input.did}, 'atproto', 'pending', 'proposed', ${input.uri}, ${input.cid ?? null},
          ${record.createdAt ?? new Date().toISOString()}
        )
        returning id
      `
      const organizers = await t<{ user_id: string }[]>`
        select user_id from event_members where event_id = ${event.id} and role in ('owner', 'admin', 'moderator')
      `
      try {
        await t.savepoint((sp) =>
          notify(sp, {
            eventId: event.id,
            userIds: organizers.map((o) => o.user_id),
            type: 'new_proposal',
            title: `New proposal from the network: “${record.title.slice(0, 120)}”`,
            actionUrl: `/e/${event.slug}/admin/sessions`,
            data: { sessionId: rows[0]!.id, source: 'network' },
          }),
        )
      } catch {
        // a notification failure never drops the proposal
      }
      return rows[0]!
    })
    result.sideEffects.push(`session-created:${inserted.id}`)
  } catch (e) {
    // The proposal rules trigger refuses when proposals are closed or the format is not allowed.
    // The record stays indexed; the next reconcile retries; the audit row says why.
    await sql`
      insert into at_audit (event_id, actor_did, caller_user_id, action, collection, rkey, uri, decision, reason)
      values (${event.id}, ${event.actor_did}, null, 'proposal-ingest', ${input.collection}, ${input.rkey}, ${input.uri}, 'deny',
              ${`sessions insert rejected: ${e instanceof Error ? e.message : 'error'}`.slice(0, 2000)})
    `.catch(() => undefined)
    result.warnings.push(`session not created: ${e instanceof Error ? e.message : 'error'}`)
  }
}

async function withdrawLinkedSession(input: IngestInput, result: IngestResult): Promise<void> {
  const existing = await sessionForProposal(input.uri)
  if (!existing) return
  if (existing.slot_uri || existing.status === 'scheduled' || existing.status === 'approved') {
    await flagProposalWithdrawn({ sessionId: existing.id })
    result.sideEffects.push('proposal-withdrawn:flagged')
    return
  }
  // A pending proposal that only ever existed because ingest saw the record.
  if (existing.imported_from === 'atproto' && existing.status === 'pending') {
    await sql`
      update sessions set status = 'rejected', rejection_reason = ${WITHDRAWN_REASON}, proposal_withdrawn_at = now(), updated_at = now()
      where id = ${existing.id}
    `
    result.sideEffects.push('session-withdrawn')
    return
  }
  await flagProposalWithdrawn({ sessionId: existing.id })
  result.sideEffects.push('proposal-withdrawn:flagged')
}

/**
 * Pair a co-host's own record with the proposer's half of the double opt-in: an accepted invite
 * by that account, or an existing pairing. A cohost record from someone never invited stays a
 * public claim in their own repo and is NOT rendered as a co-host.
 */
async function linkCohost(input: IngestInput, record: CohostRecord, result: IngestResult): Promise<void> {
  const proposalUri = record.proposal?.uri
  if (!proposalUri) return
  const session = await sessionForProposal(proposalUri)
  if (!session) return
  const [account] = await sql<{ id: string }[]>`select id from accounts where did = ${input.did}`
  if (!account) {
    result.sideEffects.push('cohost:unlinked-did')
    return
  }
  const paired = await sql<{ id: string }[]>`
    update session_cohosts set cohost_uri = ${input.uri}
    where session_id = ${session.id} and user_id = ${account.id}
    returning id
  `
  if (paired.length) {
    result.sideEffects.push('cohost-linked')
    return
  }
  const [invite] = await sql<{ id: string }[]>`
    select id from cohost_invites where session_id = ${session.id} and accepted_by = ${account.id} and status = 'accepted' limit 1
  `
  if (!invite) {
    result.sideEffects.push('cohost:no-invite')
    return
  }
  await sql`
    insert into session_cohosts (session_id, user_id, event_id, cohost_uri)
    values (${session.id}, ${account.id}, ${session.event_id}, ${input.uri})
    on conflict do nothing
  `
  result.sideEffects.push('cohost-linked')
}

/* ───────────────────────────── reconciliation ───────────────────────────── */

/**
 * `listRecords` (every page) each collection of a repo and ingest each record; then delete from
 * the index anything we hold for that (did, collection) the repo no longer has. One error boundary
 * per collection: a PDS hiccup on one collection never hides the others, and a collection whose
 * fetch failed is never diffed (a partial list must not look like deletions).
 */
export async function reconcileRepo(did: string, collections: readonly string[], source = `backfill:${did}`): Promise<ReconcileRepoResult> {
  const out: ReconcileRepoResult = { did, records: 0, deleted: 0, errors: [] }
  for (const collection of collections) {
    if (!isIndexedCollection(collection)) continue
    let fetched
    try {
      fetched = await listAllRecords(did, collection)
    } catch (e) {
      out.errors.push(`${collection}: ${describe(e)}`)
      continue
    }
    const seen = new Set<string>()
    for (const r of fetched) {
      seen.add(r.uri)
      const res = await ingestRecord({
        uri: r.uri,
        did,
        collection,
        rkey: r.uri.slice(r.uri.lastIndexOf('/') + 1),
        cid: r.cid || null,
        record: r.value,
        source,
        operation: 'update',
        trusted: true,
      })
      if (res.outcome === 'indexed') out.records++
      if (res.outcome === 'error') out.errors.push(`${collection}: ${res.warnings.join('; ')}`)
    }
    try {
      for (const row of await listIndexedKeys(did, collection)) {
        if (seen.has(row.uri)) continue
        const res = await ingestRecord({ uri: row.uri, did, collection, rkey: row.rkey, source, operation: 'delete', trusted: true })
        if (res.outcome === 'deleted') out.deleted++
      }
    } catch (e) {
      out.errors.push(`${collection} (deletions): ${describe(e)}`)
    }
  }
  await sql`
    insert into at_repo_state (did, source, reconciled_at, last_error, last_error_at, updated_at)
    values (${did}, ${source.startsWith('peer') ? 'peer' : 'own-pds'}, ${out.errors.length ? null : new Date()},
            ${out.errors[0]?.slice(0, 500) ?? null}, ${out.errors.length ? new Date() : null}, now())
    on conflict (did) do update set
      reconciled_at = coalesce(excluded.reconciled_at, at_repo_state.reconciled_at),
      last_error = excluded.last_error, last_error_at = coalesce(excluded.last_error_at, at_repo_state.last_error_at),
      updated_at = now()
  `.catch(() => undefined)
  return out
}

/** Every active repo on OUR PDS (`com.atproto.sync.listRepos`, paginated). */
export async function listOwnPdsRepos(): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10_000; page++) {
    const url = new URL(`${pdsInternalUrl()}/xrpc/com.atproto.sync.listRepos`)
    url.searchParams.set('limit', '500')
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    if (!res.ok) throw new Error(`listRepos failed (${res.status})`)
    const body = (await res.json()) as { repos?: Array<{ did?: string; active?: boolean }>; cursor?: string }
    const repos = body.repos ?? []
    for (const r of repos) if (r.did && r.active !== false) dids.push(r.did)
    if (!body.cursor || repos.length === 0) break
    cursor = body.cursor
  }
  return dids
}

export interface RepoPlan {
  did: string
  collections: readonly string[]
  source: string
}

/** Which repos to reconcile and what each is expected to hold. */
export async function planRepos(): Promise<RepoPlan[]> {
  const plans = new Map<string, RepoPlan>()
  const actorRows = await sql<{ actor_did: string }[]>`select distinct actor_did from events where actor_did is not null`
  const actors = new Set(actorRows.map((r) => r.actor_did))
  for (const did of await listOwnPdsRepos()) {
    plans.set(did, { did, collections: actors.has(did) ? GATHERING_COLLECTIONS : PARTICIPANT_COLLECTIONS, source: `backfill:${did}` })
  }
  // Gathering actors brought through OAuth live on other PDSes.
  for (const did of actors) if (!plans.has(did)) plans.set(did, { did, collections: GATHERING_COLLECTIONS, source: `backfill:${did}` })
  const oauth = await sql<{ did: string }[]>`select did from accounts where kind = 'oauth'`
  for (const { did } of oauth) if (!plans.has(did)) plans.set(did, { did, collections: PARTICIPANT_COLLECTIONS, source: `backfill:${did}` })
  const peers = await sql<{ peer_did: string }[]>`select distinct peer_did from peers`
  const peerCollections = [NSID.gathering, NSID.event, NSID.eventConfig, NSID.eventListing, NSID.series, NSID.occurrence]
  for (const { peer_did } of peers) if (!plans.has(peer_did)) plans.set(peer_did, { did: peer_did, collections: peerCollections, source: `peer:${peer_did}` })
  return [...plans.values()]
}

/** Reconcile every repo we follow, route peer listings, refresh the skills cache. Never throws for one repo. */
export async function reconcileAll(): Promise<ReconcileAllResult> {
  const startedAt = new Date().toISOString()
  const out: ReconcileAllResult = { repos: 0, records: 0, deleted: 0, listings: 0, skills: { refreshedAt: null, stale: true }, errors: [], startedAt, finishedAt: startedAt }
  let plans: RepoPlan[] = []
  try {
    plans = await planRepos()
  } catch (e) {
    out.errors.push({ did: 'discovery', error: describe(e) })
  }
  for (const plan of plans) {
    out.repos++
    try {
      const r = await reconcileRepo(plan.did, plan.collections, plan.source)
      out.records += r.records
      out.deleted += r.deleted
      for (const err of r.errors) out.errors.push({ did: plan.did, error: err })
    } catch (e) {
      out.errors.push({ did: plan.did, error: describe(e) })
    }
  }
  const withPeers = await sql<{ event_id: string }[]>`select distinct event_id from peers where cross_listing_enabled`
  for (const { event_id } of withPeers) {
    try {
      out.listings += (await routePeerListings(event_id)).filter((r) => !r.error).length
    } catch (e) {
      out.errors.push({ did: `event:${event_id}`, error: describe(e) })
    }
  }
  try {
    out.series = await materializeAllSeries()
  } catch (e) {
    out.errors.push({ did: 'series', error: describe(e) })
  }
  try {
    out.skills = await ensureSkillsFresh()
  } catch (e) {
    out.skills = { error: describe(e) }
  }
  out.finishedAt = new Date().toISOString()
  await setCursor(RECONCILE_CURSOR_SOURCE, out.finishedAt)
  log('info', 'reconcileAll finished', { repos: out.repos, records: out.records, deleted: out.deleted, listings: out.listings, errors: out.errors.length })
  return out
}

/** For the indexer's startup warning: how full the index is and when it was last reconciled. */
export async function indexStats(): Promise<{ records: number; reconciledAt: string | null }> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from at_records`
  return { records: row?.n ?? 0, reconciledAt: await getCursor(RECONCILE_CURSOR_SOURCE) }
}
