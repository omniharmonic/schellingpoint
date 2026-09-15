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
import { atUri, describeOwnRepo, resolveDidDoc, resolveIdentifier } from './identity'
import { isBorrowedNsid } from './nsids'
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

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 300

/** Network-level failure (no HTTP response), as opposed to an XRPC error the PDS returned. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof XRPCError) return e.status === 1 /* ResponseType.Unknown */
  if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) return true
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code
  return typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(code)
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (!isNetworkError(e) || attempt === RETRY_ATTEMPTS) throw e
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    }
  }
  throw lastError
}

export async function putRecord(agent: Agent, input: PutRecordInput): Promise<WriteResult> {
  if (!input.skipLocalValidation) {
    assertValidRecord(input.collection, input.record)
    if (isBorrowedCollection(input.collection)) assertNoUnknownFields(input.collection, input.record as object)
  }
  const record = { ...input.record, $type: input.collection }
  const res = await withRetry(() =>
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
  await withRetry(() =>
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
 * internal URL, anything else through the endpoint its DID document names.
 */
export async function pdsAgentFor(repo: string): Promise<{ did: string; agent: AtpAgent }> {
  const did = await resolveIdentifier(repo)
  const cached = pdsAgents.get(did)
  if (cached && Date.now() - cached.at < PDS_AGENT_TTL_MS) return { did, agent: cached.agent }
  const own = await describeOwnRepo(did).catch(() => null)
  const service = own ? pdsInternalUrl() : (await resolveDidDoc(did)).pds
  const agent = new AtpAgent({ service })
  if (pdsAgents.size >= PDS_AGENT_CACHE_CAP) pdsAgents.delete(pdsAgents.keys().next().value as string)
  pdsAgents.set(did, { agent, at: Date.now() })
  return { did, agent }
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
    const res = await withRetry(() => agent.com.atproto.repo.getRecord({ repo: did, collection, rkey }))
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
  const res = await withRetry(() =>
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
