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
 *
 * THE JETSTREAM FEED (`processJetstreamFrame`, used by the indexer):
 *   - `commit` frames whose collection has app-side side effects (`SIDE_EFFECT_COLLECTIONS`:
 *     proposals → review queue, co-host pairings, endorsements, opt-in RSVPs, peer listings) are
 *     VERIFIED before anything is applied: Jetstream relays records without the signed commit, so the
 *     record is fetched from the author's own PDS (`getRecord`, via `service-url.ts`) and its cid
 *     and value must match the frame (a delete must be gone there too). A mismatch or a failed fetch
 *     indexes nothing and requests a targeted reconcile of that repo. Index-only collections are
 *     indexed as `jetstream-unverified` until reconciliation (`backfill:<did>`) confirms them.
 *   - `account` frames hide or restore a repo (`repo-status.ts`); `deleted` purges its index rows as
 *     withdrawals; becoming active reconciles the repo.
 *   - `identity` frames evict every cache for the DID and re-verify its handle both ways.
 *   One frame's failure never stops the stream; the caller keeps advancing the cursor.
 * `ingestFromJetstreamFrame` is the UNVERIFIED primitive underneath (trusted replays and tests).
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
import { applyIdentityChange, applyRepoStatus, hidesRepo, isTrackedDid, type ApplyStatusResult, type IdentityChangeResult } from './repo-status'
import type { HandleVerifier } from './identity'
import { getRecord, getRepoStatus, listAllRecords, ownPdsRepoStatus, type RepoHostingStatus } from './write'

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
  | 'skipped:unverified'
  | 'error'

export interface IngestResult {
  uri: string
  collection: string
  operation: IngestOperation
  outcome: IngestOutcome
  sideEffects: string[]
  warnings: string[]
}

/**
 * A Jetstream v1 (`/subscribe`) frame. Shapes verified against the Jetstream README
 * (bluesky-social/jetstream-legacy) and the v2 RFD §5.1, which keeps the v1 wire frozen:
 *   commit    {did, time_us, kind:'commit', commit:{rev, operation, collection, rkey, cid?, record?}}
 *   identity  {did, time_us, kind:'identity', identity:{did, handle?, seq, time}}
 *   account   {did, time_us, kind:'account', account:{active, did, seq, time, status?}}
 * `status` ∈ takendown | suspended | deleted | deactivated | desynchronized | throttled (open set).
 * v1 delivers identity/account frames for EVERY DID regardless of `wantedCollections`; v2 adds a
 * numeric `cursor`. `record`/`cid` are absent on delete.
 */
export interface JetstreamFrame {
  did: string
  time_us: number
  cursor?: number
  kind: 'commit' | 'identity' | 'account' | string
  identity?: { did?: string; handle?: string; seq?: number; time?: string }
  account?: { did?: string; active?: boolean; status?: string; seq?: number; time?: string }
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
  /** The host's `getRepoStatus` answer, when it gave one. */
  status?: { active: boolean; status: string | null; hidden: boolean }
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

const trackedCache = { at: 0, dids: new Set<string>() }

/**
 * Account/identity frames arrive for EVERY DID on the network: filter them against an in-memory
 * set (refreshed every minute) of repos we hold anything from, so the stream never waits on a
 * query per frame. A DID first seen inside the refresh window is caught by the hourly reconcile.
 */
export async function isTrackedDidCached(did: string, force = false): Promise<boolean> {
  if (force || Date.now() - trackedCache.at >= KNOWN_TTL_MS) {
    const rows = await sql<{ did: string }[]>`
      select distinct did from at_records
      union select did from at_repo_status
      union select host_did from sessions where host_did is not null
    `
    const dids = new Set(rows.map((r) => r.did))
    for (const d of await knownDids(force)) dids.add(d)
    trackedCache.dids = dids
    trackedCache.at = Date.now()
  }
  return trackedCache.dids.has(did) || (force ? false : (await knownDids()).has(did))
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

/** The relevance rule `ingestRecord` applies, without indexing anything (so a verifier can run first). */
export async function isRelevantInput(input: IngestInput): Promise<boolean> {
  if (input.trusted) return true
  if (input.collection === NSID.skill) return input.did === skillsAuthorityDid()
  if ((await knownDids()).has(input.did)) return true
  if (input.operation === 'delete') return !!(await getIndexedRecord(input.uri))
  return input.record ? referencesOurs(input) : false
}

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

/**
 * Parse one Jetstream commit frame and ingest it WITHOUT verifying the record against its author's
 * PDS. `null` when the frame is not a commit we index. The live feed uses `processJetstreamFrame`.
 */
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

/* ───────────────────────────── verified Jetstream feed ───────────────────────────── */

/** Collections whose ingestion changes app state: verified against the author's PDS first. */
export const SIDE_EFFECT_COLLECTIONS: ReadonlySet<string> = new Set([NSID.proposal, NSID.cohost, NSID.endorsement, NSID.rsvp, NSID.eventListing])

export const UNVERIFIED_SOURCE = 'jetstream-unverified'

/** Reads a record from its author's own PDS. Injectable for tests. */
export interface RecordVerifier {
  fetch(did: string, collection: string, rkey: string): Promise<{ cid: string; value: Record<string, unknown> } | null>
}

export const pdsRecordVerifier: RecordVerifier = {
  fetch: (did, collection, rkey) => getRecord(did, collection, rkey),
}

export interface ProcessFrameOptions {
  verifier?: RecordVerifier
  handleVerifier?: HandleVerifier
  /** Our PDS's view of a repo (default `ownPdsRepoStatus`; `null` = not ours). */
  ownRepoStatus?: (did: string) => Promise<RepoHostingStatus | null>
  /** Reconcile a repo that became active again right away (default true; the request is recorded either way). */
  reconcileOnActivate?: boolean
  /** Check relevance against the database instead of the minute-old in-memory set (tests, replays). */
  forceTracked?: boolean
}

export type FrameResult =
  | { kind: 'commit'; result: IngestResult }
  | { kind: 'account'; did: string; outcome: 'skipped:irrelevant' | 'skipped:malformed' | 'applied'; status?: ApplyStatusResult; purged?: number; reconciled?: ReconcileRepoResult | { error: string } }
  | { kind: 'identity'; did: string; outcome: 'skipped:irrelevant' | 'skipped:malformed' | 'applied'; identity?: IdentityChangeResult }

/** Canonical JSON (sorted keys) so a relay's rendering and a PDS's compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export type VerifyOutcome = 'match' | 'mismatch' | 'fetch-failed'

/** Does the author's PDS hold exactly what the frame claims (or, for a delete, nothing)? */
export async function verifyAgainstAuthorPds(input: IngestInput, verifier: RecordVerifier = pdsRecordVerifier): Promise<VerifyOutcome> {
  let live: { cid: string; value: Record<string, unknown> } | null
  try {
    live = await verifier.fetch(input.did, input.collection, input.rkey)
  } catch {
    return 'fetch-failed'
  }
  if (input.operation === 'delete') return live ? 'mismatch' : 'match'
  if (!live || !input.cid || live.cid !== input.cid) return 'mismatch'
  return canonical(live.value) === canonical(input.record) ? 'match' : 'mismatch'
}

/** Ask for a targeted reconcile of one repo (drained by the indexer and `/api/atproto/sync`). */
export async function requestReconcile(did: string): Promise<void> {
  await sql`
    insert into at_repo_state (did, source, reconcile_requested_at, updated_at)
    values (${did}, 'own-pds', now(), now())
    on conflict (did) do update set reconcile_requested_at = coalesce(at_repo_state.reconcile_requested_at, now()), updated_at = now()
  `
}

/** Reconcile up to `limit` repos whose reconcile was requested. Never throws for one repo. */
export async function drainReconcileRequests(limit = 10): Promise<{ repos: number; errors: number }> {
  // The timestamp travels as text: a JS Date would truncate Postgres's microseconds.
  const rows = await sql<{ did: string; reconcile_requested_at: string }[]>`
    select did, reconcile_requested_at::text as reconcile_requested_at from at_repo_state
    where reconcile_requested_at is not null order by reconcile_requested_at limit ${limit}
  `
  let errors = 0
  for (const row of rows) {
    try {
      const r = await reconcileRepoForDid(row.did)
      if (r.errors.length) errors++
    } catch {
      errors++
    }
    // Clear only the request we served; a newer one stays queued.
    await sql`update at_repo_state set reconcile_requested_at = null where did = ${row.did} and reconcile_requested_at <= ${row.reconcile_requested_at}::timestamptz`
  }
  return { repos: rows.length, errors }
}

/** A verified commit: see the module doc. */
async function ingestVerifiedCommit(frame: JetstreamFrame, opts: ProcessFrameOptions): Promise<IngestResult | null> {
  const commit = frame.commit
  if (!commit?.collection || !commit.rkey || !frame.did || !isIndexedCollection(commit.collection)) return null
  if (commit.operation !== 'create' && commit.operation !== 'update' && commit.operation !== 'delete') return null
  const input: IngestInput = {
    uri: atUri(frame.did, commit.collection, commit.rkey),
    did: frame.did,
    collection: commit.collection,
    rkey: commit.rkey,
    cid: commit.cid ?? null,
    record: commit.record ?? null,
    source: UNVERIFIED_SOURCE,
    operation: commit.operation,
  }
  if (!SIDE_EFFECT_COLLECTIONS.has(input.collection)) return ingestRecord(input)

  const base: IngestResult = { uri: input.uri, collection: input.collection, operation: input.operation, outcome: 'skipped:irrelevant', sideEffects: [], warnings: [] }
  try {
    // Cheap checks first: never dial a PDS for a record we would not index anyway.
    if (!(await isRelevantInput(input))) return base
    if (input.operation !== 'delete') {
      if (!input.record || typeof input.record !== 'object') return { ...base, outcome: 'skipped:no-record' }
      if (!isValidRecord(input.collection, input.record)) return { ...base, outcome: 'skipped:invalid' }
    }
    const verdict = await verifyAgainstAuthorPds(input, opts.verifier)
    if (verdict !== 'match') {
      await requestReconcile(input.did).catch(() => undefined)
      log('warn', 'jetstream record did not verify against its author PDS; not indexed, reconcile requested', { collection: input.collection, verdict })
      return { ...base, outcome: 'skipped:unverified', warnings: [verdict], sideEffects: ['reconcile-requested'] }
    }
  } catch (e) {
    await requestReconcile(input.did).catch(() => undefined)
    return { ...base, outcome: 'error', warnings: [describe(e)] }
  }
  return ingestRecord({ ...input, source: JETSTREAM_CURSOR_SOURCE })
}

/** Every index row a deleted repo held, removed as withdrawals (side effects included). */
export async function purgeRepo(did: string, source = 'account-deleted'): Promise<number> {
  const rows = await sql<{ uri: string; collection: string; rkey: string }[]>`select uri, collection, rkey from at_records where did = ${did}`
  let purged = 0
  for (const r of rows) {
    const res = await ingestRecord({ uri: r.uri, did, collection: r.collection, rkey: r.rkey, source, operation: 'delete', trusted: true })
    if (res.outcome === 'deleted') purged++
  }
  return purged
}

/** A relay `#account` frame (see the module doc). Our PDS's own answer wins for repos it hosts. */
export async function applyAccountFrame(frame: JetstreamFrame, opts: ProcessFrameOptions = {}): Promise<Extract<FrameResult, { kind: 'account' }>> {
  const did = frame.account?.did ?? frame.did
  if (!did || typeof frame.account?.active !== 'boolean') return { kind: 'account', did: did ?? '', outcome: 'skipped:malformed' }
  if (!(await isTrackedDidCached(did)) && !(opts.forceTracked && (await isTrackedDid(did)))) return { kind: 'account', did, outcome: 'skipped:irrelevant' }
  const own = await (opts.ownRepoStatus ?? ownPdsRepoStatus)(did).catch(() => null)
  const out: Extract<FrameResult, { kind: 'account' }> = { kind: 'account', did, outcome: 'applied' }

  if (own && hidesRepo(own.active, own.status)) {
    // Our PDS hosts it and does not serve it, whatever the relay says.
    out.status = await applyRepoStatus({ did, active: false, status: own.status, source: 'pds', authoritative: true })
  } else if (!frame.account.active) {
    out.status = await applyRepoStatus({ did, active: false, status: frame.account.status ?? null, source: 'relay' })
  } else {
    out.status = await applyRepoStatus({ did, active: true, source: own ? 'pds' : 'relay', authoritative: !!own })
  }

  if (!out.status.hidden) {
    await requestReconcile(did).catch(() => undefined)
    if (opts.reconcileOnActivate !== false) {
      out.reconciled = await reconcileRepoForDid(did).catch((e) => ({ error: describe(e) }))
    }
  } else if ((own?.status ?? frame.account.status) === 'deleted') {
    out.purged = await purgeRepo(did)
  }
  return out
}

/** A relay `#identity` frame: evict caches, re-verify the handle both ways, store it. */
export async function applyIdentityFrame(frame: JetstreamFrame, opts: ProcessFrameOptions = {}): Promise<Extract<FrameResult, { kind: 'identity' }>> {
  const did = frame.identity?.did ?? frame.did
  if (!did) return { kind: 'identity', did: '', outcome: 'skipped:malformed' }
  if (!(await isTrackedDidCached(did)) && !(opts.forceTracked && (await isTrackedDid(did)))) return { kind: 'identity', did, outcome: 'skipped:irrelevant' }
  // The frame's `handle` is a hint only; never stored without verification.
  return { kind: 'identity', did, outcome: 'applied', identity: await applyIdentityChange(did, opts.handleVerifier) }
}

/**
 * The live feed's entry point: every Jetstream frame kind, verified where it changes app state.
 * Never throws; `null` for frames we do not handle.
 */
export async function processJetstreamFrame(frame: JetstreamFrame, opts: ProcessFrameOptions = {}): Promise<FrameResult | null> {
  if (!frame || typeof frame !== 'object') return null
  try {
    if (frame.kind === 'commit') {
      const result = await ingestVerifiedCommit(frame, opts)
      return result ? { kind: 'commit', result } : null
    }
    if (frame.kind === 'account') return await applyAccountFrame(frame, opts)
    if (frame.kind === 'identity') return await applyIdentityFrame(frame, opts)
  } catch (e) {
    log('warn', 'frame handling failed', { kind: frame.kind, error: e instanceof Error ? e.name : 'error' })
  }
  return null
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
          host_id, host_name, host_did, imported_from, status, session_type, proposal_uri, proposal_cid, created_at,
          author_inactive_at
        ) values (
          ${event.id}, ${record.title}, ${record.description ?? null}, ${coerceFormat(record.format, event.allowed_formats)},
          ${coerceDuration(record.durationMinutes, event.allowed_durations)}, ${record.topics ?? []}, ${(record.skills ?? []).slice(0, 5)},
          ${record.expectedAttendance ?? null}, ${record.requiredFeatures ?? []}, ${record.selfHosted === true},
          ${record.selfHosted ? (record.place?.slice(0, 200) ?? null) : null}, ${record.selfHosted ? (record.startsAt ?? null) : null},
          ${record.selfHosted ? (record.endsAt ?? null) : null},
          ${account?.id ?? null}, null, ${input.did}, 'atproto', 'pending', 'proposed', ${input.uri}, ${input.cid ?? null},
          ${record.createdAt ?? new Date().toISOString()},
          case when exists (select 1 from at_repo_status where did = ${input.did} and hidden) then now() end
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
    insert into session_cohosts (session_id, user_id, event_id, cohost_uri, cohost_inactive_at)
    values (${session.id}, ${account.id}, ${session.event_id}, ${input.uri},
            case when exists (select 1 from at_repo_status where did = ${input.did} and hidden) then now() end)
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
  // Hosting status first (catches account events missed while the indexer was down): a repo its
  // host does not serve is hidden, not listed; a deleted one is purged.
  let hosting: RepoHostingStatus | null = null
  try {
    hosting = await getRepoStatus(did)
  } catch (e) {
    // A host without getRepoStatus, or one we cannot reach: listing below reports its own errors.
    log('warn', 'getRepoStatus failed; status left unchanged', { error: e instanceof Error ? e.name : 'error' })
  }
  if (hosting) {
    const applied = await applyRepoStatus({ did, active: hosting.active, status: hosting.status, source: 'pds', authoritative: hosting.host === 'own' })
    out.status = { active: hosting.active, status: hosting.status, hidden: applied.hidden }
    if (applied.hidden) {
      if (hosting.status === 'deleted') out.deleted += await purgeRepo(did, source)
      await recordRepoState(did, source, out)
      return out
    }
  }
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
  await recordRepoState(did, source, out)
  return out
}

async function recordRepoState(did: string, source: string, out: ReconcileRepoResult): Promise<void> {
  await sql`
    insert into at_repo_state (did, source, reconciled_at, last_error, last_error_at, updated_at)
    values (${did}, ${source.startsWith('peer') ? 'peer' : 'own-pds'}, ${out.errors.length ? null : new Date()},
            ${out.errors[0]?.slice(0, 500) ?? null}, ${out.errors.length ? new Date() : null}, now())
    on conflict (did) do update set
      reconciled_at = coalesce(excluded.reconciled_at, at_repo_state.reconciled_at),
      last_error = excluded.last_error, last_error_at = coalesce(excluded.last_error_at, at_repo_state.last_error_at),
      updated_at = now()
  `.catch(() => undefined)
}

const PEER_COLLECTIONS = [NSID.gathering, NSID.event, NSID.eventConfig, NSID.eventListing, NSID.series, NSID.occurrence]

/** `reconcileRepo` for one DID with the collections its role implies (actor, peer, participant). */
export async function reconcileRepoForDid(did: string): Promise<ReconcileRepoResult> {
  const [row] = await sql<{ actor: boolean; peer: boolean }[]>`
    select exists (select 1 from events where actor_did = ${did}) as actor, exists (select 1 from peers where peer_did = ${did}) as peer
  `
  if (row?.actor) return reconcileRepo(did, GATHERING_COLLECTIONS)
  if (row?.peer) return reconcileRepo(did, PEER_COLLECTIONS, `peer:${did}`)
  return reconcileRepo(did, PARTICIPANT_COLLECTIONS)
}

/**
 * Every repo on OUR PDS (`com.atproto.sync.listRepos`, paginated) — inactive ones included, so the
 * sweep applies their status (a takedown missed by the indexer still hides them).
 */
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
    for (const r of repos) if (r.did) dids.push(r.did)
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
  for (const { peer_did } of peers) if (!plans.has(peer_did)) plans.set(peer_did, { did: peer_did, collections: PEER_COLLECTIONS, source: `peer:${peer_did}` })
  // Hidden repos we no longer list anywhere else still get their status re-checked (and restored).
  const hidden = await sql<{ did: string }[]>`select did from at_repo_status where hidden`
  for (const { did } of hidden) if (!plans.has(did)) plans.set(did, { did, collections: PARTICIPANT_COLLECTIONS, source: `backfill:${did}` })
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
  const planned = new Set(plans.map((p) => p.did))
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
  // Every repo was just reconciled: requests for them are served.
  await sql`update at_repo_state set reconcile_requested_at = null where reconcile_requested_at <= ${startedAt} and did = any(${[...planned]}::text[])`.catch(() => undefined)
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
