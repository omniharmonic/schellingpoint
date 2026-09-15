import 'server-only'
/**
 * `at_records`: our index of PUBLIC network records — ours, proposers', peers', the skills
 * authority's. Fed three ways, all idempotent upserts keyed by AT-URI:
 *
 *   - read-your-writes: every write we make upserts here immediately (`source: 'local-write'`)
 *   - the Jetstream consumer (`scripts/atproto-indexer.ts`, `source: 'jetstream'`)
 *   - `listRecords` reconciliation (`/api/atproto/sync`, `source: 'backfill:<did>'`)
 *
 * Rows are world-readable in spirit (the records already are) but served only through
 * `/api/atproto/records`, which applies the gathering's visibility rules. Cursors for every
 * feed live in `at_sync_cursor`.
 */
import { sql, type Sql } from '@/lib/db'
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

interface Row {
  uri: string
  did: string
  collection: string
  rkey: string
  cid: string | null
  record: Record<string, unknown>
  indexed_at: string
  source: string | null
}

function toRecord(row: Row): IndexedRecord {
  return {
    uri: row.uri,
    did: row.did,
    collection: row.collection,
    rkey: row.rkey,
    cid: row.cid ?? null,
    record: row.record ?? {},
    indexedAt: row.indexed_at,
    source: row.source ?? null,
  }
}

/** Insert or replace one record. `did`/`collection`/`rkey` default to the parsed `uri`. */
export async function upsertIndexedRecord(input: UpsertIndexedRecordInput, db: Sql = sql): Promise<IndexedRecord> {
  const parsed = parseAtUri(input.uri)
  const [row] = await db<Row[]>`
    insert into at_records (uri, did, collection, rkey, cid, record, indexed_at, source)
    values (
      ${input.uri}, ${input.did ?? parsed.did}, ${input.collection ?? parsed.collection}, ${input.rkey ?? parsed.rkey},
      ${input.cid ?? null}, ${sql.json(input.record as never)}, now(), ${input.source ?? null}
    )
    on conflict (uri) do update set
      cid = excluded.cid, record = excluded.record, indexed_at = excluded.indexed_at, source = excluded.source
    returning uri, did, collection, rkey, cid, record, indexed_at, source
  `
  return toRecord(row!)
}

export async function deleteIndexedRecord(uri: string, db: Sql = sql): Promise<void> {
  await db`delete from at_records where uri = ${uri}`
}

export async function getIndexedRecord(uri: string, db: Sql = sql): Promise<IndexedRecord | null> {
  const rows = await db<Row[]>`
    select uri, did, collection, rkey, cid, record, indexed_at, source from at_records where uri = ${uri}
  `
  return rows[0] ? toRecord(rows[0]) : null
}

/** The cid we last saw for `uri`, or null when we hold no such record. */
export async function getIndexedCid(uri: string, db: Sql = sql): Promise<string | null> {
  const rows = await db<{ cid: string | null }[]>`select cid from at_records where uri = ${uri}`
  return rows[0]?.cid ?? null
}

export async function listIndexed(
  collection: string,
  opts: { did?: string; limit?: number } = {},
  db: Sql = sql,
): Promise<IndexedRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const rows = opts.did
    ? await db<Row[]>`
        select uri, did, collection, rkey, cid, record, indexed_at, source from at_records
        where collection = ${collection} and did = ${opts.did}
        order by indexed_at desc limit ${limit}
      `
    : await db<Row[]>`
        select uri, did, collection, rkey, cid, record, indexed_at, source from at_records
        where collection = ${collection}
        order by indexed_at desc limit ${limit}
      `
  return rows.map(toRecord)
}

/** Every indexed `{uri, rkey, cid}` for one repo and collection (reconciliation's deletion diff). */
export async function listIndexedKeys(did: string, collection: string, db: Sql = sql): Promise<Array<{ uri: string; rkey: string; cid: string | null }>> {
  return db<{ uri: string; rkey: string; cid: string | null }[]>`
    select uri, rkey, cid from at_records where did = ${did} and collection = ${collection}
  `
}

export async function getCursor(source: string, db: Sql = sql): Promise<string | null> {
  const rows = await db<{ cursor: string | null }[]>`select cursor from at_sync_cursor where source = ${source}`
  return rows[0]?.cursor ?? null
}

export async function setCursor(source: string, cursor: string | null, db: Sql = sql): Promise<void> {
  await db`
    insert into at_sync_cursor (source, cursor, updated_at) values (${source}, ${cursor}, now())
    on conflict (source) do update set cursor = excluded.cursor, updated_at = excluded.updated_at
  `
}

/**
 * Advance a NUMERIC cursor (Jetstream `time_us`, a PDS `seq`) monotonically: a slow writer
 * handing back a lower value never walks the stored position backwards. Returns the value
 * now stored.
 */
export async function advanceCursor(source: string, cursor: number | bigint, db: Sql = sql): Promise<string> {
  const value = String(cursor)
  if (!/^\d+$/.test(value)) throw new Error('advanceCursor needs a non-negative integer cursor')
  const [row] = await db<{ cursor: string }[]>`
    insert into at_sync_cursor (source, cursor, updated_at) values (${source}, ${value}, now())
    on conflict (source) do update set
      cursor = case
        when at_sync_cursor.cursor ~ '^[0-9]+$' and at_sync_cursor.cursor::numeric >= excluded.cursor::numeric
          then at_sync_cursor.cursor
        else excluded.cursor
      end,
      updated_at = now()
    returning cursor
  `
  return row!.cursor
}
