import 'server-only'
/**
 * The shared skill taxonomy (spec §4.1, §10): `freeschool.draft.skill` records published by the
 * Free School skills authority. One vocabulary, one authority DID, `rkey = slug`, so a
 * Schelling Point session and a Free School class on the same subject are discoverable together
 * and we never fork the tree into a `schellingpoint.draft.topic`.
 *
 * We READ the authority's records — resolve its PDS from its DID document, `listRecords` every
 * page — and cache them in `at_records` (`source: 'skills-authority'`), refreshed at most every
 * 24 h. A record that fails lexicon validation is skipped, never partially cached. Nodes the
 * authority deleted are removed from the cache after a complete fetch (never after a partial one).
 */
import { sql } from '@/lib/db'
import { NSID } from './nsids'
import { getCursor, setCursor } from './index-store'
import { resolveDidDoc } from './identity'
import { isValidRecord } from './validate'
import { listAllRecords } from './write'

export const DEFAULT_SKILLS_AUTHORITY_DID = 'did:plc:yekh7akcatgn7o7foedjpgj4'
export const SKILLS_REFRESH_MS = 24 * 60 * 60 * 1000
export const MAX_PROPOSAL_SKILLS = 5

export function skillsAuthorityDid(): string {
  return process.env.SKILLS_AUTHORITY_DID?.trim() || DEFAULT_SKILLS_AUTHORITY_DID
}

function cursorKey(did: string): string {
  return `skills:${did}`
}

export interface SkillView {
  uri: string
  cid: string | null
  id: string
  label: string
  description: string | null
  status: string
  broader: string[]
}

export interface RefreshResult {
  did: string
  fetched: number
  cached: number
  invalid: number
  removed: number
  refreshedAt: string
}

let inflight: Promise<RefreshResult> | null = null

/** Fetch every skill node from the authority's PDS and replace the cache. Deduplicated in-process. */
export function refreshSkills(): Promise<RefreshResult> {
  if (!inflight) {
    inflight = doRefresh().finally(() => {
      inflight = null
    })
  }
  return inflight
}

async function doRefresh(): Promise<RefreshResult> {
  const did = skillsAuthorityDid()
  // Resolve first so an unreachable authority fails before we touch the cache.
  await resolveDidDoc(did)
  const records = await listAllRecords<Record<string, unknown>>(did, NSID.skill)
  const valid: Array<{ uri: string; did: string; collection: string; rkey: string; cid: string; record: Record<string, unknown> }> = []
  let invalid = 0
  for (const r of records) {
    const record = { ...r.value, $type: NSID.skill }
    if (!r.uri.startsWith(`at://${did}/${NSID.skill}/`) || !isValidRecord(NSID.skill, record)) {
      invalid++
      continue
    }
    valid.push({ uri: r.uri, did, collection: NSID.skill, rkey: r.uri.slice(r.uri.lastIndexOf('/') + 1), cid: r.cid, record })
  }

  const refreshedAt = new Date().toISOString()
  let removed = 0
  await sql.begin(async (t) => {
    for (let i = 0; i < valid.length; i += 200) {
      const chunk = valid.slice(i, i + 200)
      await t`
        insert into at_records (uri, did, collection, rkey, cid, record, indexed_at, source)
        select x.uri, x.did, x.collection, x.rkey, x.cid, x.record, now(), 'skills-authority'
        from jsonb_to_recordset(${t.json(chunk as never)}) as x(uri text, did text, collection text, rkey text, cid text, record jsonb)
        on conflict (uri) do update set cid = excluded.cid, record = excluded.record, indexed_at = excluded.indexed_at, source = excluded.source
      `
    }
    const keep = valid.map((v) => v.uri)
    const gone = keep.length
      ? await t`delete from at_records where did = ${did} and collection = ${NSID.skill} and not (uri = any(${keep}::text[])) returning uri`
      : await t`delete from at_records where did = ${did} and collection = ${NSID.skill} returning uri`
    removed = gone.length
    await t`
      insert into at_repo_state (did, source, reconciled_at, last_error, last_error_at, updated_at)
      values (${did}, 'authority', now(), null, null, now())
      on conflict (did) do update set reconciled_at = now(), last_error = null, updated_at = now()
    `
  })
  await setCursor(cursorKey(did), refreshedAt)
  return { did, fetched: records.length, cached: valid.length, invalid, removed, refreshedAt }
}

/**
 * Refresh when the cache is older than 24 h. A failed refresh with a usable cache is logged and
 * served stale; with an empty cache it throws.
 */
export async function ensureSkillsFresh(): Promise<{ refreshedAt: string | null; stale: boolean }> {
  const did = skillsAuthorityDid()
  const last = await getCursor(cursorKey(did))
  const age = last ? Date.now() - new Date(last).getTime() : Infinity
  if (age < SKILLS_REFRESH_MS) return { refreshedAt: last, stale: false }
  try {
    const r = await refreshSkills()
    return { refreshedAt: r.refreshedAt, stale: false }
  } catch (e) {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from at_records where did = ${did} and collection = ${NSID.skill}`
    await sql`
      insert into at_repo_state (did, source, last_error, last_error_at, updated_at)
      values (${did}, 'authority', ${e instanceof Error ? e.message.slice(0, 500) : 'error'}, now(), now())
      on conflict (did) do update set last_error = excluded.last_error, last_error_at = now(), updated_at = now()
    `.catch(() => undefined)
    if (!n) throw e
    console.warn('[atproto:skills] refresh failed; serving the cached taxonomy')
    return { refreshedAt: last, stale: true }
  }
}

interface SkillRow {
  uri: string
  cid: string | null
  id: string | null
  label: string | null
  description: string | null
  status: string | null
  broader: string[] | null
}

function view(row: SkillRow): SkillView {
  return {
    uri: row.uri,
    cid: row.cid,
    id: row.id ?? row.uri.slice(row.uri.lastIndexOf('/') + 1),
    label: row.label ?? row.id ?? '',
    description: row.description,
    status: row.status ?? 'proposed',
    broader: Array.isArray(row.broader) ? row.broader : [],
  }
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Case-insensitive search over label, slug and description. Deprecated nodes are never offered. */
export async function searchSkills(q: string, opts: { limit?: number } = {}): Promise<SkillView[]> {
  const did = skillsAuthorityDid()
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
  const term = q.trim().slice(0, 80)
  const rows = term
    ? await sql<SkillRow[]>`
        select uri, cid, record ->> 'id' as id, record ->> 'label' as label, record ->> 'description' as description,
               record ->> 'status' as status,
               array(select jsonb_array_elements_text(coalesce(record -> 'broader', '[]'::jsonb))) as broader
        from at_records
        where did = ${did} and collection = ${NSID.skill} and coalesce(record ->> 'status', '') <> 'deprecated'
          and (record ->> 'label' ilike ${likePattern(term)} or record ->> 'id' ilike ${likePattern(term)}
               or record ->> 'description' ilike ${likePattern(term)})
        order by lower(record ->> 'label') = lower(${term}) desc,
                 record ->> 'label' ilike ${`${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} desc,
                 (record ->> 'status') = 'canonical' desc,
                 record ->> 'label'
        limit ${limit}
      `
    : await sql<SkillRow[]>`
        select uri, cid, record ->> 'id' as id, record ->> 'label' as label, record ->> 'description' as description,
               record ->> 'status' as status,
               array(select jsonb_array_elements_text(coalesce(record -> 'broader', '[]'::jsonb))) as broader
        from at_records
        where did = ${did} and collection = ${NSID.skill} and (record ->> 'status') = 'canonical'
        order by record ->> 'label'
        limit ${limit}
      `
  return rows.map(view)
}

/** Resolve specific skill URIs (to label chips). Unknown URIs are simply absent. */
export async function getSkills(uris: readonly string[]): Promise<SkillView[]> {
  const wanted = [...new Set(uris)].slice(0, 50)
  if (!wanted.length) return []
  const rows = await sql<SkillRow[]>`
    select uri, cid, record ->> 'id' as id, record ->> 'label' as label, record ->> 'description' as description,
           record ->> 'status' as status,
           array(select jsonb_array_elements_text(coalesce(record -> 'broader', '[]'::jsonb))) as broader
    from at_records where collection = ${NSID.skill} and uri = any(${wanted}::text[])
  `
  return rows.map(view)
}

/**
 * Validate a proposal's or track's skills: at most `max`, every URI a cached, non-deprecated node
 * of the authority. Returns the de-duplicated list in the given order.
 */
export async function validateSkillUris(uris: unknown, max = MAX_PROPOSAL_SKILLS): Promise<{ ok: true; uris: string[] } | { ok: false; error: string }> {
  if (uris === undefined || uris === null) return { ok: true, uris: [] }
  if (!Array.isArray(uris) || uris.some((u) => typeof u !== 'string')) return { ok: false, error: 'skills must be a list of skill URIs' }
  const list = [...new Set(uris as string[])]
  if (list.length > max) return { ok: false, error: `choose at most ${max} skills` }
  if (!list.length) return { ok: true, uris: [] }
  const found = await getSkills(list)
  const ok = new Set(found.filter((s) => s.status !== 'deprecated' && s.uri.startsWith(`at://${skillsAuthorityDid()}/`)).map((s) => s.uri))
  const bad = list.filter((u) => !ok.has(u))
  if (bad.length) return { ok: false, error: 'one or more skills are not in the shared taxonomy' }
  return { ok: true, uris: list }
}
