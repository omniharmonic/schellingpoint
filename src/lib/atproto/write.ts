import 'server-only'
/**
 * Repo I/O against a PDS.
 *
 * Writes go out with `validate: false` because our lexicons are unpublished
 * (a PDS cannot fetch them), so `putRecord` runs `assertValidRecord` LOCALLY
 * first. Reads are unauthenticated: the repo's own PDS is found from its DID
 * document and asked directly.
 */
import { Agent, AtpAgent, XRPCError } from '@atproto/api'
import { pdsInternalUrl } from './config'
import { atUri, resolveIdentifier } from './identity'
import { isBorrowedNsid } from './nsids'
import { classifyXrpcError, paceRepoWrite, PDS_WRITE_POINTS, withXrpcBackoff } from './rate-limit'
import { atpAgentForService, serviceForDid } from './service-url'
import { assertNoUnknownFields, assertValidRecord } from './validate'

/** Collections we borrow and must never extend (the sidecar rule, enforced at write time). */
export function isBorrowedCollection(collection: string): boolean {
  return isBorrowedNsid(collection)
}

/** The PDS refused a CAS write: the record's current cid is not the one we asserted. */
export function isInvalidSwap(e: unknown): boolean {
  if (e instanceof XRPCError) return e.error === 'InvalidSwap'
  const err = e as { error?: string; message?: string } | undefined
  return err?.error === 'InvalidSwap' || /InvalidSwap/.test(err?.message ?? '')
}

export interface WriteResult {
  uri: string
  cid: string
}

export interface PutRecordInput {
  /** DID (or handle) of the repo — must be the agent's own. */
  repo: string
  collection: string
  rkey: string
  record: Record<string, unknown>
  /**
   * CAS: the CID the record must currently have (`null` = must not exist).
   * Omit for a plain upsert. Only sent when explicitly provided.
   */
  swapRecord?: string | null
  /** Skip the local lexicon check (only for records we cannot validate). */
  skipLocalValidation?: boolean
}

export interface DeleteRecordInput {
  repo: string
  collection: string
  rkey: string
  swapRecord?: string
}

export interface FetchedRecord<T = Record<string, unknown>> {
  uri: string
  cid: string
  value: T
}

/** Reads get a shorter wait budget than writes: a page render should not hang on a PDS. */
const READ_MAX_WAIT_MS = 15_000

/** Network-level failure (no HTTP response), as opposed to an XRPC error the PDS returned. */
export function isNetworkError(e: unknown): boolean {
  return classifyXrpcError(e) === 'network'
}

/** Unauthenticated read: 429 / 5xx / connection failures backed off (see `rate-limit.ts`). */
function withReadRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withXrpcBackoff(fn, { maxTotalWaitMs: READ_MAX_WAIT_MS, transientRetries: 2 })
}

export async function putRecord(agent: Agent, input: PutRecordInput): Promise<WriteResult> {
  if (!input.skipLocalValidation) {
    assertValidRecord(input.collection, input.record)
    if (isBorrowedCollection(input.collection)) assertNoUnknownFields(input.collection, input.record as object)
  }
  const record = { ...input.record, $type: input.collection }
  // One write per repo at a time, paced under the PDS's points budget, 429/5xx backed off.
  const res = await paceRepoWrite(input.repo, PDS_WRITE_POINTS.update, () =>
    agent.com.atproto.repo.putRecord({
      repo: input.repo,
      collection: input.collection,
      rkey: input.rkey,
      record,
      validate: false,
      // `swapRecord: null` asserts "must not exist yet"; only send it when the
      // caller chose one, otherwise this is an ordinary upsert.
      ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
    }),
  )
  return { uri: res.data.uri, cid: res.data.cid }
}

export async function deleteRecord(agent: Agent, input: DeleteRecordInput): Promise<void> {
  await paceRepoWrite(input.repo, PDS_WRITE_POINTS.delete, () =>
    agent.com.atproto.repo.deleteRecord({
      repo: input.repo,
      collection: input.collection,
      rkey: input.rkey,
      ...(input.swapRecord !== undefined ? { swapRecord: input.swapRecord } : {}),
    }),
  )
}

/* ─────────────────────── unauthenticated reads ─────────────────────── */

const pdsAgents = new Map<string, { agent: AtpAgent; at: number }>()
const PDS_AGENT_TTL_MS = 10 * 60 * 1000

const PDS_AGENT_CACHE_CAP = 512

/**
 * An unauthenticated agent pointed at the PDS that hosts `repo`: our own PDS through its
 * internal URL, anything else through the endpoint its DID document names (validated, and
 * dialled only through `safeFetch` — see `service-url.ts`).
 */
export async function pdsAgentFor(repo: string): Promise<{ did: string; agent: AtpAgent }> {
  const did = await resolveIdentifier(repo)
  const cached = pdsAgents.get(did)
  if (cached && Date.now() - cached.at < PDS_AGENT_TTL_MS) return { did, agent: cached.agent }
  // SSRF guard: own PDS via the internal URL; any other PDS only through safeFetch.
  const agent = atpAgentForService(await serviceForDid(did))
  if (pdsAgents.size >= PDS_AGENT_CACHE_CAP) pdsAgents.delete(pdsAgents.keys().next().value as string)
  pdsAgents.set(did, { agent, at: Date.now() })
  return { did, agent }
}

/** Forget the cached read agent for a repo (identity change: its PDS may have moved). */
export function forgetPdsAgent(did: string): void {
  pdsAgents.delete(did)
}

export interface RepoHostingStatus {
  did: string
  active: boolean
  /** `takendown` | `suspended` | `deleted` | `deactivated` | `desynchronized` | `throttled` | `not-found` | … */
  status: string | null
  rev: string | null
  /** `own` = OUR PDS answered (authoritative for the repos it hosts). */
  host: 'own' | 'foreign'
}

/** `getRepoStatus` on OUR PDS (internal URL). `null` when it does not host the repo. */
export async function ownPdsRepoStatus(did: string): Promise<RepoHostingStatus | null> {
  const url = new URL(`${pdsInternalUrl()}/xrpc/com.atproto.sync.getRepoStatus`)
  url.searchParams.set('did', did)
  const res = await withReadRetry(async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`getRepoStatus ${r.status}`), { status: r.status, headers: Object.fromEntries(r.headers) })
    return r
  })
  const body = (await res.json().catch(() => ({}))) as { active?: boolean; status?: string; rev?: string; error?: string }
  if (res.ok) return { did, active: body.active === true, status: body.active ? null : (body.status ?? null), rev: body.rev ?? null, host: 'own' }
  if (res.status === 400 && body.error === 'RepoNotFound') return null
  throw new Error(`getRepoStatus failed (${body.error ?? res.status})`)
}

/**
 * `com.atproto.sync.getRepoStatus` for a repo, from the host that holds it. OUR PDS is asked
 * first through its internal URL — it answers for its taken-down and deactivated repos too (which
 * `describeRepo` hides) and is authoritative for them. Any other repo is asked on the PDS its DID
 * document names, only through `safeFetch` (`service-url.ts`). A host that answers `RepoNotFound`
 * no longer hosts the repo: `active: false, status: 'not-found'` (hidden, not a deletion).
 */
export async function getRepoStatus(did: string): Promise<RepoHostingStatus> {
  const own = await ownPdsRepoStatus(did)
  if (own) return own
  const service = await serviceForDid(did)
  if (service.internal) return { did, active: false, status: 'not-found', rev: null, host: 'own' }
  const agent = atpAgentForService(service)
  try {
    const res = await withReadRetry(() => agent.com.atproto.sync.getRepoStatus({ did }))
    return { did, active: res.data.active === true, status: res.data.active ? null : (res.data.status ?? null), rev: res.data.rev ?? null, host: 'foreign' }
  } catch (e) {
    if (e instanceof XRPCError && e.error === 'RepoNotFound') return { did, active: false, status: 'not-found', rev: null, host: 'foreign' }
    throw e
  }
}

function isRecordNotFound(e: unknown): boolean {
  return e instanceof XRPCError && (e.error === 'RecordNotFound' || e.status === 404)
}

/** Fetch one record from the repo's own PDS. `null` when it does not exist. */
export async function getRecord<T = Record<string, unknown>>(
  repo: string,
  collection: string,
  rkey: string,
): Promise<FetchedRecord<T> | null> {
  const { did, agent } = await pdsAgentFor(repo)
  try {
    const res = await withReadRetry(() => agent.com.atproto.repo.getRecord({ repo: did, collection, rkey }))
    return { uri: res.data.uri, cid: res.data.cid ?? '', value: res.data.value as T }
  } catch (e) {
    if (isRecordNotFound(e)) return null
    throw e
  }
}

export async function listRecords<T = Record<string, unknown>>(
  repo: string,
  collection: string,
  opts: { cursor?: string; limit?: number; reverse?: boolean } = {},
): Promise<{ records: FetchedRecord<T>[]; cursor?: string }> {
  const { did, agent } = await pdsAgentFor(repo)
  const res = await withReadRetry(() =>
    agent.com.atproto.repo.listRecords({
      repo: did,
      collection,
      limit: Math.min(Math.max(opts.limit ?? 50, 1), 100),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      ...(opts.reverse ? { reverse: true } : {}),
    }),
  )
  return {
    records: res.data.records.map((r) => ({ uri: r.uri, cid: r.cid, value: r.value as T })),
    ...(res.data.cursor ? { cursor: res.data.cursor } : {}),
  }
}

/** A PDS clamps `listRecords` at 100 per page; ask for exactly that and follow the cursor. */
export const LIST_RECORDS_PAGE = 100

/**
 * Every record in one collection of a repo, all pages. A page that comes back with a cursor
 * but no records ends the walk (some PDS versions hand back a trailing cursor).
 */
export async function listAllRecords<T = Record<string, unknown>>(
  repo: string,
  collection: string,
  opts: { maxPages?: number } = {},
): Promise<FetchedRecord<T>[]> {
  const out: FetchedRecord<T>[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await listRecords<T>(repo, collection, { limit: LIST_RECORDS_PAGE, cursor })
    out.push(...page.records)
    cursor = page.records.length > 0 ? page.cursor : undefined
    pages++
  } while (cursor && pages < (opts.maxPages ?? 10_000))
  return out
}

/** Convenience: the AT-URI a `putRecord` with these inputs will produce. */
export function uriFor(input: Pick<PutRecordInput, 'repo' | 'collection' | 'rkey'>): string {
  return atUri(input.repo, input.collection, input.rkey)
}
