import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'

// Per-suite fixtures so no spec file depends on (or changes) the seeded gatherings.
//
//   createTestGathering(sql, { tag, ... })  a uniquely-slugged event, optionally with a program
//                                           (venues, tracks, time slots) and a gathering DID
//                                           minted on the local PDS through the app's own code.
//   createTestAccount(who)                  a custodial account through the real email door.
//
// Both return a `cleanup()` that removes every row and PDS account they created.
loadEnvConfig(process.cwd(), true)

export const TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001'
const pdsUrl = () => (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const ownerUrl = () => process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''

/* ───────────────────────────── shared bits ───────────────────────────── */

/** Lowercase base36, `n` chars. */
export function randomTag(n = 6): string {
  let out = ''
  while (out.length < n) out += BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36)
  return out.slice(0, n)
}

/**
 * `src/lib/**` starts with `import 'server-only'`, which throws outside the react-server bundle.
 * Runs `fn` with that import resolved to Next's empty stub, then restores whatever resolver was
 * installed before (a suite's own shim included).
 */
export async function withServerOnlyShim<T>(fn: () => T | Promise<T>): Promise<T> {
  type Resolver = (request: string, ...rest: unknown[]) => string
  const M = Module as unknown as { _resolveFilename: Resolver }
  const previous = M._resolveFilename
  const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'server-only' ? stub : previous.call(this, request, ...rest)
  }
  try {
    return await fn()
  } finally {
    M._resolveFilename = previous
  }
}

/** Delete a PDS account by DID (admin). "Not found" counts as done. */
export async function deletePdsAccount(did: string): Promise<void> {
  const pds = pdsUrl()
  const password = process.env.PDS_ADMIN_PASSWORD || ''
  if (!pds || !password || !did.startsWith('did:')) return
  const res = await fetch(`${pds}/xrpc/com.atproto.admin.deleteAccount`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
    },
    body: JSON.stringify({ did }),
  }).catch(() => null)
  if (res && !res.ok && res.status !== 400 && res.status !== 404) {
    console.warn(`[test helpers] PDS deleteAccount ${did}: ${res.status} ${await res.text().catch(() => '')}`)
  }
}

/** Runs `fn` with a short-lived owner connection, or the one given. */
async function withSql<T>(given: postgres.Sql | undefined, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  if (given) return fn(given)
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => {} })
  try {
    return await fn(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/* ───────────────────────────── gatherings ───────────────────────────── */

export type GatheringStatus = 'draft' | 'published' | 'proposals_open' | 'voting_open' | 'scheduling' | 'live' | 'completed' | 'archived'

export interface CreateTestGatheringOptions {
  /** Short label that ends up in the slug (`t-<tag>-<rand>`); trimmed to keep the slug ≤ 18 chars. */
  tag: string
  name?: string
  status?: GatheringStatus
  visibility?: 'public' | 'unlisted' | 'private'
  voting?: {
    mechanism?: 'quadratic' | 'linear' | 'approval'
    credits?: number
    opensAt?: Date | string | null
    closesAt?: Date | string | null
  }
  /** Merged over the column default `{feedbackK: 3, publishRoles: false, destructiveActionStewards: 2}`. */
  policyThresholds?: Partial<{ feedbackK: number; publishRoles: boolean; destructiveActionStewards: number }>
  /** Days from today to the first day (default 14, like the seeded demo gathering). Two days long. */
  startInDays?: number
  requireProposalApproval?: boolean
  ticketingEnabled?: boolean
  /** Like the seed's demo gathering: 3 venues, 4 tracks, 6 slots per venue per day (one a lunch break). */
  withProgram?: boolean
  /** Mint the gathering's DID on the local PDS via the app's `mintGatheringActor`. */
  mintIdentity?: boolean
  /** Account id recorded as the minting caller (defaults to a random uuid). */
  mintedBy?: string
}

export interface TestGathering {
  id: string
  slug: string
  name: string
  actorDid?: string
  actorHandle?: string
  venueIds: string[]
  trackIds: string[]
  /** Deletes the event (cascades), its PDS account and its at_credentials / at_records / at_audit rows. */
  cleanup(): Promise<void>
}

const DEFAULT_THRESHOLDS = { feedbackK: 3, publishRoles: false, destructiveActionStewards: 2 }

export async function createTestGathering(sql: postgres.Sql, opts: CreateTestGatheringOptions): Promise<TestGathering> {
  const tag = opts.tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 9).replace(/-+$/, '') || 'g'
  const slug = `t-${tag}-${randomTag(6)}`
  const name = opts.name ?? `Test Gathering ${slug}`
  const start = opts.startInDays ?? 14
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.policyThresholds ?? {}) }
  const toTs = (v: Date | string | null | undefined) => (v == null ? null : v instanceof Date ? v.toISOString() : v)

  const [event] = await sql<{ id: string }[]>`
    insert into events (
      slug, name, tagline, start_date, end_date, timezone, location_name, status, visibility,
      vote_credits_per_user, voting_mechanism, voting_opens_at, voting_closes_at,
      allowed_formats, allowed_durations, max_proposals_per_user, require_proposal_approval,
      ticketing_enabled, policy_thresholds
    ) values (
      ${slug}, ${name}, 'A throwaway gathering for tests', current_date + ${start}::int, current_date + ${start + 1}::int,
      'America/Denver', 'Test Hall', ${opts.status ?? 'proposals_open'}, ${opts.visibility ?? 'public'},
      ${opts.voting?.credits ?? 100}, ${opts.voting?.mechanism ?? 'quadratic'},
      ${toTs(opts.voting?.opensAt)}, ${toTs(opts.voting?.closesAt)},
      ${['talk', 'workshop', 'panel', 'discussion']}, ${[15, 30, 45, 60]}, 5, ${opts.requireProposalApproval ?? false},
      ${opts.ticketingEnabled ?? false}, ${sql.json(thresholds)}
    )
    returning id
  `
  const gathering: TestGathering = {
    id: event!.id,
    slug,
    name,
    venueIds: [],
    trackIds: [],
    cleanup: () => cleanupGathering(sql, event!.id),
  }

  try {
    if (opts.withProgram) {
      const venues = await sql<{ id: string }[]>`
        insert into venues (event_id, name, slug, capacity, features, is_primary)
        values (${gathering.id}, 'Main Hall', 'main-hall', 120, ${['projector', 'microphone']}, true),
               (${gathering.id}, 'Workshop Room', 'workshop-room', 30, ${['whiteboard']}, false),
               (${gathering.id}, 'Garden', 'garden', 40, '{}'::text[], false)
        returning id
      `
      gathering.venueIds = venues.map((v) => v.id)
      const tracks = await sql<{ id: string }[]>`
        insert into tracks (event_id, name, slug, description, color, display_order, is_active)
        values (${gathering.id}, 'Governance', 'governance', 'Coordination and decision making', '#6366f1', 0, true),
               (${gathering.id}, 'Public Goods', 'public-goods', 'Funding the commons', '#10b981', 1, true),
               (${gathering.id}, 'Local Life', 'local-life', 'Food, land, neighbourhoods', '#f59e0b', 2, true),
               (${gathering.id}, 'Open Source', 'open-source', 'Building in the open', '#ec4899', 3, true)
        returning id
      `
      gathering.trackIds = tracks.map((t) => t.id)
      await sql`
        insert into time_slots (event_id, venue_id, day_date, start_time, end_time, label, is_break, slot_type)
        select ${gathering.id}, v.id, d.day,
               (d.day + s.starts) at time zone 'America/Denver', (d.day + s.ends) at time zone 'America/Denver',
               s.label, s.is_break, s.slot_type
        from unnest(${gathering.venueIds}::uuid[]) as v(id)
        cross join (select (current_date + ${start}::int + g)::date as day from generate_series(0, 1) g) d
        cross join (values
          (time '09:00', time '10:00', 'Morning session', false, 'session'),
          (time '10:15', time '11:15', 'Late morning',    false, 'session'),
          (time '11:30', time '12:30', 'Before lunch',    false, 'session'),
          (time '12:30', time '13:30', 'Lunch',           true,  'break'),
          (time '13:30', time '14:30', 'Afternoon',       false, 'session'),
          (time '14:45', time '15:45', 'Late afternoon',  false, 'session')
        ) as s(starts, ends, label, is_break, slot_type)
      `
    }

    if (opts.mintIdentity) {
      const minted = await withServerOnlyShim(async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const actors = require('../../src/lib/atproto/actors') as typeof import('../../src/lib/atproto/actors')
        return actors.mintGatheringActor(gathering.id, opts.mintedBy ?? randomUUID())
      })
      gathering.actorDid = minted.did
      gathering.actorHandle = minted.handle
    }
  } catch (e) {
    await gathering.cleanup().catch(() => undefined)
    throw e
  }
  return gathering
}

/**
 * Removes a gathering and everything hanging off it. The DID is read from the row at cleanup
 * time, so an identity minted later (e.g. through the admin API) is torn down too.
 */
export async function cleanupGathering(sql: postgres.Sql, eventId: string): Promise<void> {
  const [row] = await sql<{ actor_did: string | null; slug: string }[]>`select actor_did, slug from events where id = ${eventId}`
  if (!row) return
  const did = row.actor_did
  if (did) await deletePdsAccount(did)
  await sql.begin(async (t) => {
    await t`delete from at_audit where event_id = ${eventId}`
    if (did) {
      await t`delete from at_audit where actor_did = ${did}`
      await t`delete from at_records where did = ${did}`
      await t`delete from at_credentials where did = ${did}`
    }
    await t`delete from events where id = ${eventId}`
  })
}

/* ───────────────────────────── accounts ───────────────────────────── */

export interface VerifyResult {
  status: number
  location: string | null
  /** `sp_at_session=<value>`, or null when verification set no cookie. */
  cookie: string | null
  setCookie: string | null
}

function sessionCookie(res: Response): { cookie: string | null; setCookie: string | null } {
  const all = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
  const raw = all.find((c) => c.startsWith('sp_at_session=')) ?? null
  const cookie = raw ? raw.split(';')[0]! : null
  return { cookie: cookie && cookie !== 'sp_at_session=' ? cookie : null, setCookie: raw }
}

/**
 * Consume a magic link. Prefers the confirmation flow (`POST /auth/verify`, form body `token=`,
 * same origin, answered with a 303 carrying the cookie); falls back to the legacy
 * `GET /auth/verify?token=` only when the route has no POST handler (405).
 */
export async function verifyMagicLink(verifyUrl: string, base = TEST_BASE_URL): Promise<VerifyResult> {
  const url = new URL(verifyUrl, base)
  const token = url.searchParams.get('token') ?? ''
  const origin = new URL(base).origin
  const post = await fetch(`${origin}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  })
  const res = post.status === 405 ? await fetch(url, { redirect: 'manual' }) : post
  return { status: res.status, location: res.headers.get('location'), ...sessionCookie(res) }
}

/** Ask the email door for a link (dev server with mail disabled) and consume it. Returns the session cookie. */
export async function signInWithEmail(email: string, base = TEST_BASE_URL): Promise<string> {
  const res = await fetch(`${base}/api/auth/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, next: '/' }),
  })
  const body = (await res.json().catch(() => ({}))) as { devVerifyUrl?: string }
  if (res.status !== 200) throw new Error(`POST /api/auth/email for ${email}: ${res.status} ${JSON.stringify(body)}`)
  if (typeof body.devVerifyUrl !== 'string') throw new Error('no devVerifyUrl: run the dev server without RESEND_API_KEY')
  const verified = await verifyMagicLink(body.devVerifyUrl, base)
  if (!verified.cookie) throw new Error(`verifying the link for ${email} set no session cookie (${verified.status})`)
  return verified.cookie
}

export interface TestAccount {
  email: string
  cookie: string
  id: string
  did: string
  handle: string
  /** Deletes the PDS account, the account row (cascades), its email tokens, indexed records and repo state. */
  cleanup(): Promise<void>
}

/**
 * A custodial account through the real email door. `who` becomes part of the address
 * (`t-<who>-<rand>@example.test`) unless `email` is given.
 */
export async function createTestAccount(who: string, opts: { sql?: postgres.Sql; email?: string; base?: string } = {}): Promise<TestAccount> {
  const label = who.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'someone'
  const email = (opts.email ?? `t-${label}-${randomTag(8)}@example.test`).toLowerCase()
  const cookie = await signInWithEmail(email, opts.base)
  const [row] = await withSql(opts.sql, (sql) => sql<{ id: string; did: string; handle: string | null }[]>`
    select id, did, handle from accounts where email = ${email}
  `)
  if (!row) throw new Error(`no account row for ${email} after sign-in`)
  return {
    email,
    cookie,
    id: row.id,
    did: row.did,
    handle: row.handle ?? '',
    cleanup: () => cleanupAccount(email, opts.sql),
  }
}

/** Remove an account created through the email door, by email: PDS account first, then rows. */
export async function cleanupAccount(email: string, given?: postgres.Sql): Promise<void> {
  await withSql(given, async (sql) => {
    const rows = await sql<{ id: string; did: string }[]>`select id, did from accounts where email = ${email}`
    for (const r of rows) await deletePdsAccount(r.did)
    const dids = rows.map((r) => r.did)
    const ids = rows.map((r) => r.id)
    if (dids.length) {
      await sql`delete from at_records where did in ${sql(dids)}`
      await sql`delete from at_repo_state where did in ${sql(dids)}`
      await sql`delete from at_repo_status where did in ${sql(dids)}`
    }
    if (ids.length) {
      await sql`delete from at_credentials where created_by in ${sql(ids)}`
      await sql`delete from accounts where id in ${sql(ids)}`
    }
    await sql`delete from auth_email_tokens where email = ${email}`
  })
}
