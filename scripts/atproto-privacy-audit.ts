/**
 * Privacy audit over the public record index (docs/ATPROTO_IMPLEMENTATION.md §6).
 *
 *   npm run atproto:audit
 *
 * Walks `at_records` and fails (exit 1) when:
 *   1. a record authored by a gathering actor (`events.actor_did`) names a DID
 *      other than the actor's own outside the fields `records.ts` allows (R9);
 *   2. any proposal / slot / tally record contains a string equal to a
 *      `sessions.host_name` — names must never reach a public record;
 *   3. any `schellingpoint.draft.tally` entry reports `voters` below the
 *      tally's `k` without being suppressed.
 *
 * Read-only. Uses the service role against the database `.env.local` points at.
 */
import { loadEnvConfig } from '@next/env'
import { createClient } from '@supabase/supabase-js'

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')

import { NSID } from '../src/lib/atproto/nsids'
import { assertNoForeignDid, ForeignDidError } from '../src/lib/atproto/records'

interface RecordRow {
  uri: string
  did: string
  collection: string
  record: Record<string, unknown>
}

interface Finding {
  check: 'foreign-did' | 'host-name' | 'tally-k'
  uri: string
  detail: string
}

const NAME_CHECKED_COLLECTIONS: readonly string[] = [NSID.proposal, NSID.slot, NSID.tally]
const PAGE = 500

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function* strings(node: unknown, path = ''): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path, node]
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* strings(node[i], `${path}[${i}]`)
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k)
  }
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: events, error: eventsError } = await db.from('events').select('id, slug, actor_did').not('actor_did', 'is', null)
  if (eventsError) throw new Error(`events: ${eventsError.message}`)
  const actorDids = new Set<string>()
  for (const e of (events ?? []) as { actor_did: string | null }[]) if (e.actor_did) actorDids.add(e.actor_did)

  const { data: hosts, error: hostsError } = await db.from('sessions').select('host_name').not('host_name', 'is', null)
  if (hostsError) throw new Error(`sessions: ${hostsError.message}`)
  const hostNames = new Set<string>()
  for (const h of (hosts ?? []) as { host_name: string | null }[]) {
    const n = h.host_name ? normalizeName(h.host_name) : ''
    if (n.length >= 3) hostNames.add(n)
  }

  const findings: Finding[] = []
  const counts = { records: 0, actorRecords: 0, nameChecked: 0, tallies: 0 }

  let from = 0
  for (;;) {
    const { data, error } = await db
      .from('at_records')
      .select('uri, did, collection, record')
      .order('uri', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`at_records: ${error.message}`)
    const rows = (data ?? []) as RecordRow[]
    for (const row of rows) {
      counts.records++

      if (actorDids.has(row.did)) {
        counts.actorRecords++
        try {
          assertNoForeignDid(row.record, row.did, { gatheringDid: row.did })
        } catch (e) {
          const detail = e instanceof ForeignDidError ? e.message : e instanceof Error ? e.message : String(e)
          findings.push({ check: 'foreign-did', uri: row.uri, detail })
        }
      }

      if (NAME_CHECKED_COLLECTIONS.includes(row.collection) && hostNames.size) {
        counts.nameChecked++
        for (const [path, value] of strings(row.record)) {
          if (hostNames.has(normalizeName(value))) {
            findings.push({ check: 'host-name', uri: row.uri, detail: `${path} equals a sessions.host_name` })
          }
        }
      }

      if (row.collection === NSID.tally) {
        counts.tallies++
        const k = typeof row.record.k === 'number' ? row.record.k : null
        const entries = Array.isArray(row.record.entries) ? (row.record.entries as Record<string, unknown>[]) : []
        entries.forEach((entry, i) => {
          if (entry.suppressed === true) {
            if ('voters' in entry || 'votes' in entry || 'credits' in entry) {
              findings.push({ check: 'tally-k', uri: row.uri, detail: `entries[${i}] is suppressed but carries counts` })
            }
            return
          }
          if (k !== null && typeof entry.voters === 'number' && entry.voters < k) {
            findings.push({ check: 'tally-k', uri: row.uri, detail: `entries[${i}].voters=${entry.voters} is below k=${k} and not suppressed` })
          }
        })
      }
    }
    if (rows.length < PAGE) break
    from += PAGE
  }

  console.log('atproto privacy audit')
  console.log(`  database:            ${url}`)
  console.log(`  gathering actors:    ${actorDids.size}`)
  console.log(`  host names known:    ${hostNames.size}`)
  console.log(`  records scanned:     ${counts.records}`)
  console.log(`  actor records (R9):  ${counts.actorRecords}`)
  console.log(`  name-checked:        ${counts.nameChecked}`)
  console.log(`  tallies:             ${counts.tallies}`)
  console.log(`  findings:            ${findings.length}`)
  for (const f of findings) console.log(`  [${f.check}] ${f.uri} — ${f.detail}`)
  if (findings.length) {
    console.error('FAIL: public records violate the privacy rules above')
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => {
  console.error('audit failed to run:', e instanceof Error ? e.message : e)
  process.exit(1)
})
