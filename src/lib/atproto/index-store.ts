import 'server-only'
/**
 * `at_records`: our index of PUBLIC network records — ours, proposers', peers'.
 * Fed by a Jetstream consumer or a `listRecords` backfill (both keep their
 * position in `at_sync_cursor`). Rows are world-readable (public SELECT policy)
 * because the records already are; writes are service-role only.
 */
import { createAdminClient } from '@/lib/supabase/server'
import { parseAtUri } from './identity'

export interface IndexedRecord {
  uri: string
  did: string
  collection: string
  rkey: string
  cid: string | null
  record: Record<string, unknown>
  indexedAt: string
  source: string | null
}

export interface UpsertIndexedRecordInput {
  uri: string
  did?: string
  collection?: string
  rkey?: string
  cid?: string | null
  record: Record<string, unknown>
  /** e.g. `jetstream`, `backfill:<did>`, `local-write`. */
  source?: string | null
}

function rowToRecord(row: Record<string, unknown>): IndexedRecord {
  return {
    uri: row.uri as string,
    did: row.did as string,
    collection: row.collection as string,
    rkey: row.rkey as string,
    cid: (row.cid as string | null) ?? null,
    record: (row.record as Record<string, unknown>) ?? {},
    indexedAt: row.indexed_at as string,
    source: (row.source as string | null) ?? null,
  }
}

/** Insert or replace one record. `did`/`collection`/`rkey` default to the parsed `uri`. */
export async function upsertIndexedRecord(input: UpsertIndexedRecordInput): Promise<IndexedRecord> {
  const parsed = parseAtUri(input.uri)
  const db = await createAdminClient()
  const row = {
    uri: input.uri,
    did: input.did ?? parsed.did,
    collection: input.collection ?? parsed.collection,
    rkey: input.rkey ?? parsed.rkey,
    cid: input.cid ?? null,
    record: input.record,
    indexed_at: new Date().toISOString(),
    source: input.source ?? null,
  }
  const { data, error } = await db.from('at_records').upsert(row, { onConflict: 'uri' }).select('*').single()
  if (error) throw new Error(`at_records upsert: ${error.message}`)
  return rowToRecord(data as Record<string, unknown>)
}

export async function deleteIndexedRecord(uri: string): Promise<void> {
  const db = await createAdminClient()
  const { error } = await db.from('at_records').delete().eq('uri', uri)
  if (error) throw new Error(`at_records delete: ${error.message}`)
}

export async function getIndexedRecord(uri: string): Promise<IndexedRecord | null> {
  const db = await createAdminClient()
  const { data, error } = await db.from('at_records').select('*').eq('uri', uri).maybeSingle()
  if (error) throw new Error(`at_records get: ${error.message}`)
  return data ? rowToRecord(data as Record<string, unknown>) : null
}

export async function listIndexed(
  collection: string,
  opts: { did?: string; limit?: number } = {},
): Promise<IndexedRecord[]> {
  const db = await createAdminClient()
  let q = db.from('at_records').select('*').eq('collection', collection).order('indexed_at', { ascending: false })
  if (opts.did) q = q.eq('did', opts.did)
  q = q.limit(Math.min(Math.max(opts.limit ?? 100, 1), 1000))
  const { data, error } = await q
  if (error) throw new Error(`at_records list: ${error.message}`)
  return (data ?? []).map((r) => rowToRecord(r as Record<string, unknown>))
}

export async function getCursor(source: string): Promise<string | null> {
  const db = await createAdminClient()
  const { data, error } = await db.from('at_sync_cursor').select('cursor').eq('source', source).maybeSingle()
  if (error) throw new Error(`at_sync_cursor get: ${error.message}`)
  return (data?.cursor as string | null) ?? null
}

export async function setCursor(source: string, cursor: string | null): Promise<void> {
  const db = await createAdminClient()
  const { error } = await db
    .from('at_sync_cursor')
    .upsert({ source, cursor, updated_at: new Date().toISOString() }, { onConflict: 'source' })
  if (error) throw new Error(`at_sync_cursor set: ${error.message}`)
}
