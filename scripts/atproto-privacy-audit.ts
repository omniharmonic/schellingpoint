/**
 * Privacy audit (spec §9 "privacy-audit.ts", §12 release gate; plan §6 item 27).
 *
 *   npm run atproto:audit            exit 0 = PASS, exit 1 = a violation (or the audit could not run)
 *
 * Assertions:
 *   1. foreign-did    no record a GATHERING wrote names a DID other than its own (outside the
 *                     fields `records.ts` allows). Checked twice: every such row in `at_records`,
 *                     AND every record fetched LIVE from our PDS with `listRecords` (the index could
 *                     be stale or incomplete). The single exemption is a `coop.lexicon.membership`
 *                     claim whose subject passes all three gates right now (policy publishRoles,
 *                     subject opted in, derived role >= host). Feed posts (`app.bsky.feed.post`,
 *                     design §7) may name a DID only in a mention facet, and only when the ledger
 *                     (`feed_posts.mentions`) recorded that DID as consented at post time.
 *   2. host-name      no gathering-written record contains a name an organiser typed for a person
 *                     — post text included —
 *                     (`session_host_listings.host_name`, `sessions.host_name`, `tracks.lead_name`,
 *                     `tracks.lead_email`) or equals a host's or co-host's display name.
 *   3. vote-columns   `vote_entries` and `vote_ballots` carry no account/user/DID column
 *                     (information_schema).
 *   4. ballot-key     no `vote_rounds.ballot_key` survives past `closes_at`.
 *   5. event-scope    no row without `event_id` in any event-scoped table (every public table with
 *                     an `event_id` column, except the three where a global row is by design).
 *   6. borrowed       no borrowed-lexicon record we wrote (gathering or member repos) carries a
 *                     field its lexicon does not define, and every one validates.
 *   7. tally-k        every tally entry below k is suppressed and carries no counts.
 *   8. exact-location no indexed record (any repo) and no live gathering record contains a value
 *                     equal to a session's exact location or meeting link (`sessions.custom_location`);
 *                     a gathering-written record may not even contain one.
 *   9. geo           no gathering-written record carries a `community.lexicon.location.geo` within
 *                     0.005° of a private-residence venue's point or of a session's exact
 *                     `location_lat/lng`, unless it equals that session's coarse `public_geo`
 *                     (spec §8.1: exact points are attendee-only; only the ≈1 km point is published).
 *
 * Read-only. Output names collections, rkeys and counts — never a DID, handle or record body.
 */
import { loadEnvConfig } from '@next/env'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')

import { GATHERING_COLLECTIONS, NSID, isBorrowedNsid } from '../src/lib/atproto/nsids'
import { assertNoForeignDid, ForeignDidError } from '../src/lib/atproto/records'

type Validate = typeof import('../src/lib/atproto/validate')

/**
 * `@atproto/lexicon` (via multiformats) only resolves under Node's ESM loader, and tsx runs this
 * script as CommonJS. Bundle `validate.ts` to an ESM file inside the project (so bare imports
 * resolve against ./node_modules) and import that, exactly as the indexer does.
 */
async function loadValidate(): Promise<Validate> {
  const root = process.cwd()
  const outdir = path.resolve(root, 'node_modules/.cache/schellingpoint-atproto/audit')
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: { validate: path.resolve(root, 'src/lib/atproto/validate.ts') },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
  })
  return (await import(pathToFileURL(path.join(outdir, 'validate.js')).href)) as Validate
}

type Check = 'foreign-did' | 'host-name' | 'exact-location' | 'vote-columns' | 'ballot-key' | 'event-scope' | 'borrowed' | 'tally-k' | 'geo'

interface Finding {
  check: Check
  where: string
  detail: string
}

interface Rec {
  uri: string
  did: string
  collection: string
  record: Record<string, unknown>
  source: 'index' | 'live'
}

/** Tables with an `event_id` whose NULL rows are global by design, not a scoping leak. */
const GLOBAL_BY_DESIGN = new Set(['notifications', 'notification_preferences', 'at_audit'])
const ACCOUNT_COLUMNS = ['account_id', 'user_id', 'did', 'voter_id', 'voter_did', 'account', 'profile_id', 'host_id', 'email']

function where(r: Rec): string {
  const rkey = r.uri.slice(r.uri.lastIndexOf('/') + 1)
  return `${r.source}:${r.collection}/${rkey}`
}

function* strings(node: unknown, path = ''): Generator<[string, string]> {
  if (typeof node === 'string') yield [path, node]
  else if (Array.isArray(node)) for (let i = 0; i < node.length; i++) yield* strings(node[i], `${path}[${i}]`)
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k)
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function listLive(pds: string, did: string, collection: string): Promise<Rec[]> {
  const out: Rec[] = []
  let cursor: string | undefined
  for (let page = 0; page < 1000; page++) {
    const url = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`)
    url.searchParams.set('repo', did)
    url.searchParams.set('collection', collection)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (res.status === 400) break // repo not on this PDS (a brought gathering account)
    if (!res.ok) throw new Error(`listRecords ${collection} failed (${res.status})`)
    const body = (await res.json()) as { records?: Array<{ uri: string; value: Record<string, unknown> }>; cursor?: string }
    const records = body.records ?? []
    for (const r of records) out.push({ uri: r.uri, did, collection, record: r.value, source: 'live' })
    if (!body.cursor || records.length === 0) break
    cursor = body.cursor
  }
  return out
}

async function tableExists(sql: postgres.Sql, name: string): Promise<boolean> {
  const rows = await sql`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${name}`
  return rows.length > 0
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
  const { assertNoUnknownFields, assertValidRecord } = await loadValidate()
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} })
  const findings: Finding[] = []
  const counts: Record<string, number | string> = {}

  try {
    /* ───────────── actors and consent ───────────── */
    const actors = await sql<{ event_id: string; actor_did: string; publish_roles: boolean }[]>`
      select id as event_id, actor_did,
             coalesce((policy_thresholds ->> 'publishRoles')::boolean, false) as publish_roles
      from events where actor_did is not null
    `
    const actorDids = new Set(actors.map((a) => a.actor_did))
    counts['gathering actors'] = actorDids.size

    // Subjects allowed on a membership claim, per gathering: all three gates hold NOW.
    const consented = await sql<{ actor_did: string; subject_did: string }[]>`
      select e.actor_did, a.did as subject_did
      from events e
      join event_members m on m.event_id = e.id and m.public_role
      join accounts a on a.id = m.user_id
      where e.actor_did is not null
        and coalesce((e.policy_thresholds ->> 'publishRoles')::boolean, false)
        and (
          m.role in ('owner', 'admin', 'moderator', 'track_lead')
          or exists (
            select 1 from sessions s
            where s.event_id = e.id and s.status = 'scheduled' and s.cancelled_at is null
              and (s.host_id = a.id or exists (select 1 from session_cohosts c where c.session_id = s.id and c.user_id = a.id))
          )
        )
    `
    const consent = new Set(consented.map((c) => `${c.actor_did}|${c.subject_did}`))

    // Feed posts (design §7.4): a mention facet may name a DID only when the ledger recorded that
    // DID as consented at post time (`feed_posts.mentions`). Keyed by the post's at-uri.
    const mentionsByUri = new Map<string, Set<string>>()
    if (await tableExists(sql, 'feed_posts')) {
      const posts = await sql<{ uri: string; mentions: unknown }[]>`select uri, mentions from feed_posts where uri is not null`
      for (const p of posts) {
        const dids = Array.isArray(p.mentions) ? (p.mentions as Array<{ did?: unknown }>).map((m) => m?.did).filter((d): d is string => typeof d === 'string') : []
        mentionsByUri.set(p.uri, new Set(dids))
      }
      counts['feed posts (ledger)'] = posts.length
    }

    /* ───────────── gathering-written records: index + live ───────────── */
    const gatheringRecords: Rec[] = []
    if (actorDids.size) {
      const rows = await sql<{ uri: string; did: string; collection: string; record: Record<string, unknown> }[]>`
        select uri, did, collection, record from at_records where did = any(${[...actorDids]}::text[])
      `
      for (const r of rows) gatheringRecords.push({ ...r, source: 'index' })
    }
    counts['gathering records (index)'] = gatheringRecords.length
    let live = 0
    if (pds) {
      for (const did of actorDids) {
        for (const collection of GATHERING_COLLECTIONS) {
          const recs = await listLive(pds, did, collection)
          live += recs.length
          gatheringRecords.push(...recs)
        }
      }
      counts['gathering records (live PDS)'] = live
    } else {
      counts['gathering records (live PDS)'] = 'skipped: PDS_URL not set'
    }

    for (const r of gatheringRecords) {
      const subject = r.collection === NSID.membership && typeof r.record.subject === 'string' ? r.record.subject : undefined
      const consentedSubjectDid = subject && consent.has(`${r.did}|${subject}`) ? subject : undefined
      // A post not in the ledger gets NO mention allowance: any foreign DID in it is a violation.
      const consentedMentionDids = r.collection === NSID.post ? mentionsByUri.get(r.uri) : undefined
      try {
        assertNoForeignDid(r.record, r.did, { gatheringDid: r.did, consentedSubjectDid, consentedMentionDids })
      } catch (e) {
        const detail = e instanceof ForeignDidError ? `names a foreign DID at ${e.path}` : e instanceof Error ? e.message : String(e)
        findings.push({ check: 'foreign-did', where: where(r), detail })
      }
    }

    /* ───────────── host names ───────────── */
    const typed = new Set<string>()
    const equalOnly = new Set<string>()
    const nameRows = await sql<{ kind: string; value: string | null }[]>`
      select 'typed' as kind, host_name as value from sessions where host_name is not null
      union all select 'typed', lead_name from tracks where lead_name is not null
      union all select 'typed', lead_email from tracks where lead_email is not null
      union all select 'equal', p.display_name from profiles p
        where p.display_name is not null
          and (exists (select 1 from sessions s where s.host_id = p.id) or exists (select 1 from session_cohosts c where c.user_id = p.id))
    `
    for (const n of nameRows) {
      const v = n.value ? norm(n.value) : ''
      if (v.length < 3) continue
      ;(n.kind === 'typed' ? typed : equalOnly).add(v)
    }
    if (await tableExists(sql, 'session_host_listings')) {
      for (const n of await sql<{ host_name: string }[]>`select host_name from session_host_listings`) {
        const v = norm(n.host_name)
        if (v.length >= 3) typed.add(v)
      }
    }
    counts['names checked'] = typed.size + equalOnly.size
    for (const r of gatheringRecords) {
      for (const [path, value] of strings(r.record)) {
        if (value.startsWith('at://') || value.startsWith('did:')) continue
        const v = norm(value)
        if (equalOnly.has(v) || typed.has(v)) {
          findings.push({ check: 'host-name', where: where(r), detail: `${path} equals a person's name` })
          continue
        }
        for (const name of typed) {
          if (name.length >= 5 && name.includes(' ') && v.includes(name)) {
            findings.push({ check: 'host-name', where: where(r), detail: `${path} contains an organiser-typed name` })
            break
          }
        }
      }
    }

    /* ───────────── exact locations ───────────── */
    const locationRows = await sql<{ custom_location: string }[]>`
      select distinct custom_location from sessions where custom_location is not null and btrim(custom_location) <> ''
    `
    const locations = new Set(locationRows.map((r) => norm(r.custom_location)).filter((v) => v.length >= 4))
    counts['exact locations checked'] = locations.size
    if (locations.size) {
      const everyIndexed = await sql<{ uri: string; did: string; collection: string; record: Record<string, unknown> }[]>`
        select uri, did, collection, record from at_records
      `
      const candidates: Rec[] = [...everyIndexed.map((r) => ({ ...r, source: 'index' as const })), ...gatheringRecords.filter((r) => r.source === 'live')]
      for (const r of candidates) {
        const gatheringWritten = actorDids.has(r.did)
        for (const [path, value] of strings(r.record)) {
          const v = norm(value)
          if (locations.has(v)) {
            findings.push({ check: 'exact-location', where: where(r), detail: `${path} equals a session's exact location` })
            continue
          }
          if (!gatheringWritten) continue
          for (const loc of locations) {
            if (loc.length >= 12 && v.includes(loc)) {
              findings.push({ check: 'exact-location', where: where(r), detail: `${path} contains a session's exact location` })
              break
            }
          }
        }
      }
    }

    /* ───────────── geo (spec §8.1) ───────────── */
    {
      const geos: Array<{ path: string; lat: number; lng: number; rec: Rec }> = []
      const walk = (node: unknown, path: string, rec: Rec) => {
        if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`, rec))
        else if (node && typeof node === 'object') {
          const o = node as Record<string, unknown>
          if (o.$type === NSID.locationGeo) {
            const lat = Number(o.latitude)
            const lng = Number(o.longitude)
            if (Number.isFinite(lat) && Number.isFinite(lng)) geos.push({ path, lat, lng, rec })
          }
          for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k, rec)
        }
      }
      for (const r of gatheringRecords) walk(r.record, '', r)
      counts['geo points in gathering records'] = geos.length
      const columns = await sql<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns
        where table_schema = 'public' and (table_name, column_name) in (('venues', 'latitude'), ('sessions', 'location_lat'))
      `
      const hasVenueGeo = columns.some((c) => c.table_name === 'venues')
      const hasSessionGeo = columns.some((c) => c.table_name === 'sessions')
      const near = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.abs(a.lat - b.lat) <= 0.005 && Math.abs(a.lng - b.lng) <= 0.005
      const homes = hasVenueGeo
        ? await sql<{ lat: number; lng: number }[]>`
            select latitude::float8 as lat, longitude::float8 as lng from venues
            where is_private_residence and latitude is not null and longitude is not null
          `
        : []
      const exact = hasSessionGeo
        ? await sql<{ lat: number; lng: number; coarse: { lat: number; lng: number } | null }[]>`
            select location_lat::float8 as lat, location_lng::float8 as lng, public_geo as coarse from sessions
            where location_lat is not null and location_lng is not null
          `
        : []
      counts['private-residence points'] = homes.length
      counts['exact session points'] = exact.length
      for (const g of geos) {
        if (homes.some((h) => near(g, h))) {
          findings.push({ check: 'geo', where: where(g.rec), detail: `${g.path} is within 0.005° of a private residence` })
          continue
        }
        for (const e of exact) {
          if (!near(g, e)) continue
          const coarse = e.coarse && Number.isFinite(Number(e.coarse.lat)) && Number.isFinite(Number(e.coarse.lng))
            ? { lat: Math.round(Number(e.coarse.lat) * 100) / 100, lng: Math.round(Number(e.coarse.lng) * 100) / 100 }
            : null
          const equalsCoarse = coarse !== null && Math.abs(g.lat - coarse.lat) < 1e-9 && Math.abs(g.lng - coarse.lng) < 1e-9
          if (!equalsCoarse) {
            findings.push({ check: 'geo', where: where(g.rec), detail: `${g.path} is within 0.005° of a session's exact location and is not its coarse point` })
            break
          }
        }
      }
    }

    /* ───────────── voting tables ───────────── */
    for (const table of ['vote_entries', 'vote_ballots']) {
      if (!(await tableExists(sql, table))) {
        counts[`${table} columns`] = 'table absent'
        continue
      }
      const cols = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}
      `
      const bad = cols.map((c) => c.column_name).filter((c) => ACCOUNT_COLUMNS.includes(c) || /(^|_)(did|account|user|voter)(_|$)/.test(c))
      counts[`${table} columns`] = cols.length
      for (const c of bad) findings.push({ check: 'vote-columns', where: table, detail: `has an identifying column "${c}"` })
    }
    if (await tableExists(sql, 'vote_rounds')) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from vote_rounds where closes_at < now() and ballot_key is not null`
      counts['vote rounds past close with a key'] = row!.n
      if (row!.n > 0) findings.push({ check: 'ballot-key', where: 'vote_rounds', detail: `${row!.n} round(s) past closes_at still hold a ballot_key` })
    } else {
      counts['vote rounds past close with a key'] = 'table absent'
    }

    /* ───────────── event scoping ───────────── */
    const scoped = await sql<{ table_name: string; is_nullable: string }[]>`
      select c.table_name, c.is_nullable
      from information_schema.columns c join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
      where c.table_schema = 'public' and c.column_name = 'event_id' and t.table_type = 'BASE TABLE'
      order by c.table_name
    `
    let scopedChecked = 0
    for (const t of scoped) {
      if (GLOBAL_BY_DESIGN.has(t.table_name)) continue
      scopedChecked++
      if (t.is_nullable === 'NO') continue
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t.table_name)} where event_id is null`
      if (row!.n > 0) findings.push({ check: 'event-scope', where: t.table_name, detail: `${row!.n} row(s) without event_id` })
    }
    counts['event-scoped tables'] = scopedChecked

    /* ───────────── borrowed records ───────────── */
    const ourRows = await sql<{ uri: string; did: string; collection: string; record: Record<string, unknown> }[]>`
      select r.uri, r.did, r.collection, r.record from at_records r
      where r.did in (select did from accounts union select actor_did from events where actor_did is not null)
        and (r.collection like 'community.lexicon.%' or r.collection like 'coop.lexicon.%' or r.collection like 'freeschool.draft.%' or r.collection like 'app.bsky.%')
    `
    const borrowed: Rec[] = [...ourRows.map((r) => ({ ...r, source: 'index' as const })), ...gatheringRecords.filter((r) => r.source === 'live' && isBorrowedNsid(r.collection))]
    counts['borrowed records checked'] = borrowed.length
    for (const r of borrowed) {
      try {
        assertValidRecord(r.collection, { ...r.record, $type: r.collection })
        assertNoUnknownFields(r.collection, { ...r.record, $type: r.collection })
      } catch (e) {
        findings.push({ check: 'borrowed', where: where(r), detail: e instanceof Error ? e.message.replace(/did:[a-z]+:[A-Za-z0-9._:%-]+/g, 'did:…') : String(e) })
      }
    }

    /* ───────────── tallies ───────────── */
    const tallies = gatheringRecords.filter((r) => r.collection === NSID.tally)
    counts['tallies'] = tallies.length
    for (const r of tallies) {
      const k = typeof r.record.k === 'number' ? r.record.k : null
      const entries = Array.isArray(r.record.entries) ? (r.record.entries as Record<string, unknown>[]) : []
      entries.forEach((entry, i) => {
        if (entry.suppressed === true) {
          if ('voters' in entry || 'votes' in entry || 'credits' in entry) findings.push({ check: 'tally-k', where: where(r), detail: `entries[${i}] is suppressed but carries counts` })
          return
        }
        if (k !== null && typeof entry.voters === 'number' && entry.voters < k) {
          findings.push({ check: 'tally-k', where: where(r), detail: `entries[${i}].voters=${entry.voters} is below k=${k} and not suppressed` })
        }
      })
    }
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log('atproto privacy audit')
  for (const [k, v] of Object.entries(counts)) console.log(`  ${`${k}:`.padEnd(40)} ${v}`)
  const byCheck = new Map<Check, number>()
  for (const f of findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1)
  for (const check of ['foreign-did', 'host-name', 'exact-location', 'vote-columns', 'ballot-key', 'event-scope', 'borrowed', 'tally-k', 'geo'] as Check[]) {
    console.log(`  [${byCheck.get(check) ? 'FAIL' : ' ok '}] ${check}${byCheck.get(check) ? ` (${byCheck.get(check)})` : ''}`)
  }
  for (const f of findings.slice(0, 200)) console.log(`  ${f.check}: ${f.where} — ${f.detail}`)
  if (findings.length) {
    console.error(`FAIL: ${findings.length} privacy violation(s)`)
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => {
  console.error('audit failed to run:', e instanceof Error ? e.message : e)
  process.exit(1)
})
