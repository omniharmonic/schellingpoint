import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import {
  cleanupAccount,
  createTestAccount,
  createTestGathering,
  TEST_BASE_URL,
  type TestAccount,
  type TestGathering,
} from './helpers/gathering'

/**
 * Subject rights (spec §7–§9, MT §12.6): "download my data" and "delete my account".
 *
 * The two claims this file exists to hold the implementation to:
 *
 *   1. The export is complete about the person and silent about their ballots — because after
 *      a round closes there is no longer anything in the database that says which entries were
 *      theirs, and manufacturing that link to satisfy an export would undo §5.
 *   2. Deletion removes the person and keeps the money fact. A paid ticket keeps its amount and
 *      loses its holder; a gathering's books do not change because somebody exercised a right.
 *      And a custodial repository is DEACTIVATED, never deleted: PLC history is permanent by
 *      design, so deleting the repo would destroy the person's own copy of their records while
 *      the public, append-only part stayed exactly where it is.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || TEST_BASE_URL
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(ownerUrl && pdsUrl && pdsAdminPassword)
const adminAuth = `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`

async function api(path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { origin: base }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, text, headers: res.headers }
}

/** Ask the PDS, admin-side, whether an account still exists and whether it is deactivated. */
async function pdsAccount(did: string): Promise<{ exists: boolean; deactivated: boolean }> {
  const url = new URL(`${pdsUrl}/xrpc/com.atproto.admin.getAccountInfos`)
  url.searchParams.append('dids', did)
  const res = await fetch(url, { headers: { authorization: adminAuth } })
  if (!res.ok) return { exists: false, deactivated: false }
  const body = (await res.json()) as { infos?: Array<{ did?: string; deactivatedAt?: string }> }
  const info = (body.infos ?? []).find((i) => i.did === did)
  return { exists: Boolean(info), deactivated: Boolean(info?.deactivatedAt) }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('subject rights', () => {
  test.skip(!configured, 'needs the local stack (Postgres + PDS) and the dev server')

  let sql: postgres.Sql
  let gathering: TestGathering
  let owner: TestAccount
  let subject: TestAccount
  let sessionId: string
  let tierId: string
  /** A gathering the subject founded and then handed over — the shape that used to break deletion. */
  let founded: TestGathering
  let foundedTrackId: string
  const connectedDid = 'did:plc:subjectconnectedgathering'

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'rights', status: 'proposals_open' })
    owner = await createTestAccount('rights-owner', { sql, base })
    subject = await createTestAccount('rights-subject', { sql, base })
    await sql`
      insert into event_members (event_id, user_id, role)
      values (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${subject.id}, 'attendee')
    `
    const [session] = await sql<{ id: string }[]>`
      insert into sessions (event_id, host_id, title, format, duration, status)
      values (${gathering.id}, ${subject.id}, 'Something I proposed', 'discussion', 30, 'approved')
      returning id
    `
    sessionId = session!.id
    await sql`insert into favorites (event_id, session_id, user_id) values (${gathering.id}, ${sessionId}, ${subject.id})`

    const [tier] = await sql<{ id: string }[]>`
      insert into ticket_tiers (event_id, name, price_cents) values (${gathering.id}, 'Paid', 2500) returning id
    `
    tierId = tier!.id
    await sql`
      insert into tickets (event_id, tier_id, user_id, status, amount_paid_cents, paid_currency, payment_intent_id, platform_fee_cents)
      values (${gathering.id}, ${tierId}, ${subject.id}, 'confirmed', 2500, 'usd', 'pi_test_rights', 25)
    `

    // The subject founded a second gathering and handed it over. `events.created_by` and
    // `tracks.lead_user_id` used to be ON DELETE NO ACTION, so exactly this person — the one
    // the ownership check lets through — could never actually be deleted (migration 0035).
    founded = await createTestGathering(sql, { tag: 'rights-f', status: 'published' })
    await sql`update events set created_by = ${subject.id} where id = ${founded.id}`
    await sql`insert into event_members (event_id, user_id, role) values (${founded.id}, ${owner.id}, 'owner')`
    const [track] = await sql<{ id: string }[]>`
      insert into tracks (event_id, name, slug, lead_user_id) values (${founded.id}, 'Led by the subject', 'led', ${subject.id})
      returning id
    `
    foundedTrackId = track!.id

    // Two credentials that must be told apart: the gathering's, which the subject merely
    // connected, and the subject's own, whose subject is their DID.
    await sql`
      insert into at_credentials (did, kind, identifier, pds_url, created_by)
      values (${connectedDid}, 'app-password', 'a-gathering.example', 'http://pds.test', ${subject.id})
    `
    await sql`
      insert into at_credentials (did, kind, identifier, pds_url, created_by)
      values (${subject.did}, 'app-password', ${subject.did}, 'http://pds.test', ${subject.id})
      on conflict (did) do nothing
    `

    // An audit row naming them as the caller, and a geocoding rate-limit row.
    await sql`
      insert into at_audit (event_id, actor_did, caller_user_id, action, collection, decision, reason)
      values (${founded.id}, ${connectedDid}, ${subject.id}, 'put', 'schellingpoint.draft.gathering', 'allow', 'fixture')
    `
    await sql`insert into geocode_requests (account_id) values (${subject.id})`
  })

  test.afterAll(async () => {
    await gathering?.cleanup().catch(() => undefined)
    await founded?.cleanup().catch(() => undefined)
    await sql`delete from at_credentials where did = ${connectedDid}`.catch(() => undefined)
    await owner?.cleanup().catch(() => undefined)
    // The subject's account is deleted by the test; clean up whatever survived.
    await cleanupAccount(subject.email, sql).catch(() => undefined)
    await sql?.end({ timeout: 5 })
  })

  test('the export carries everything about the account and nothing about its ballots', async () => {
    const minted = await api('/api/me/assistant-tokens', { method: 'POST', cookie: subject.cookie, json: { name: 'Test assistant' } })
    expect(minted.status).toBe(201)

    const res = await fetch(`${base}/api/me/export`, { headers: { cookie: subject.cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const data = JSON.parse(await res.text())

    expect(data.format).toBe('unconference.account-export/1')
    expect(data.account.did).toBe(subject.did)
    expect(data.account.email).toBe(subject.email)
    expect(data.memberships.some((m: any) => m.gathering === gathering.slug)).toBe(true)
    expect(data.proposals.some((p: any) => p.id === sessionId)).toBe(true)
    expect(data.favorites.length).toBe(1)
    expect(data.tickets.length).toBe(1)
    expect(data.assistant_tokens.length).toBe(1)

    // Metadata, never the secret.
    expect(JSON.stringify(data)).not.toContain('unc_')
    expect(JSON.stringify(data)).not.toContain('token_hash')

    // The two documented absences, said out loud in the file itself.
    expect(data.ballots).toBeUndefined()
    expect(data.votes).toBeUndefined()
    expect(data.about.not_included.join(' ')).toContain('Your votes')
    expect(data.about.your_repository.how).toContain('com.atproto.sync.getRepo')

    expect((await api('/api/me/export')).status).toBe(401)
  })

  test('deletion is refused while the person is the only owner of a live gathering', async () => {
    const preview = await api('/api/me/delete', { cookie: owner.cookie })
    expect(preview.status).toBe(200)
    expect(preview.body.blockingGatherings.map((g: any) => g.slug)).toContain(gathering.slug)

    const refused = await api('/api/me/delete', { method: 'POST', cookie: owner.cookie, json: { confirm: owner.handle } })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('LastOwner')

    const [still] = await sql`select 1 from accounts where id = ${owner.id}`
    expect(still).toBeTruthy()
  })

  test('deletion needs the handle typed, and refuses a cross-origin caller', async () => {
    const wrong = await api('/api/me/delete', { method: 'POST', cookie: subject.cookie, json: { confirm: 'not-my-handle' } })
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('ConfirmMismatch')

    const crossed = await fetch(`${base}/api/me/delete`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie: subject.cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ confirm: subject.handle }),
    })
    expect(crossed.status).toBe(403)

    const [still] = await sql`select 1 from accounts where id = ${subject.id}`
    expect(still).toBeTruthy()
  })

  test('deleting an account removes the person, keeps the money fact, and deactivates the repository', async () => {
    const before = await pdsAccount(subject.did)
    expect(before.exists).toBe(true)
    expect(before.deactivated).toBe(false)

    const preview = await api('/api/me/delete', { cookie: subject.cookie })
    expect(preview.body.pds).toBe('deactivated')
    expect(preview.body.pdsSentence).toContain('permanent by design')

    const done = await api('/api/me/delete', { method: 'POST', cookie: subject.cookie, json: { confirm: subject.handle } })
    expect(done.status).toBe(200)
    expect(done.body.deleted).toBe(true)
    expect(done.body.pds).toBe('deactivated')
    // The cookie is cleared on the way out, so the browser stops presenting a dead credential.
    expect((done.headers.getSetCookie?.() ?? []).join(';')).toContain('sp_at_session=')

    // The account and everything hanging off it is gone.
    const [account] = await sql`select 1 from accounts where id = ${subject.id}`
    expect(account).toBeUndefined()
    const [profile] = await sql`select 1 from profiles where id = ${subject.id}`
    expect(profile).toBeUndefined()
    const [membership] = await sql`select 1 from event_members where user_id = ${subject.id}`
    expect(membership).toBeUndefined()
    const [favorite] = await sql`select 1 from favorites where user_id = ${subject.id}`
    expect(favorite).toBeUndefined()
    const [token] = await sql`select 1 from assistant_tokens where account_id = ${subject.id}`
    expect(token).toBeUndefined()
    const [session] = await sql`select 1 from at_sessions where user_id = ${subject.id}`
    expect(session).toBeUndefined()

    // The session cookie now resolves to nothing.
    expect((await api('/api/me/export', { cookie: subject.cookie })).status).toBe(401)

    // The proposal survives its author: it is the author's own record, marked so organizers see it.
    const [proposal] = await sql<{ host_id: string | null; author_left_at: string | null; title: string }[]>`
      select host_id, author_left_at, title from sessions where id = ${sessionId}
    `
    expect(proposal!.title).toBe('Something I proposed')
    expect(proposal!.host_id).toBeNull()
    expect(proposal!.author_left_at).not.toBeNull()

    // The paid ticket keeps its amount and loses its holder.
    const [ticket] = await sql<{ user_id: string | null; amount_paid_cents: number | null; platform_fee_cents: number | null }[]>`
      select user_id, amount_paid_cents, platform_fee_cents from tickets where event_id = ${gathering.id}
    `
    expect(ticket!.user_id).toBeNull()
    expect(ticket!.amount_paid_cents).toBe(2500)
    expect(ticket!.platform_fee_cents).toBe(25)

    // The repository is deactivated, not deleted. PLC history is permanent by design.
    const after = await pdsAccount(subject.did)
    expect(after.exists).toBe(true)
    expect(after.deactivated).toBe(true)

    // A gathering they founded and handed over survives, with no author.
    const [stillThere] = await sql<{ created_by: string | null }[]>`
      select created_by from events where id = ${founded.id}
    `
    expect(stillThere, 'the gathering they founded must outlive them').toBeTruthy()
    expect(stillThere!.created_by).toBeNull()

    // So does the track they led, with no lead.
    const [track] = await sql<{ lead_user_id: string | null }[]>`
      select lead_user_id from tracks where id = ${foundedTrackId}
    `
    expect(track).toBeTruthy()
    expect(track!.lead_user_id).toBeNull()

    // The gathering credential they merely CONNECTED stays — forgetting the organizer must
    // never stop a gathering publishing. Their own credential goes with them.
    const [connected] = await sql<{ created_by: string | null }[]>`
      select created_by from at_credentials where did = ${connectedDid}
    `
    expect(connected, 'a gathering credential must not be deleted with the organizer who connected it').toBeTruthy()
    expect(connected!.created_by).toBeNull()
    const [own] = await sql`select 1 from at_credentials where did = ${subject.did}`
    expect(own).toBeUndefined()

    // The audit trail is kept and the caller is forgotten (spec §9 "audit retained").
    const [audit] = await sql<{ caller_user_id: string | null }[]>`
      select caller_user_id from at_audit where actor_did = ${connectedDid}
    `
    expect(audit).toBeTruthy()
    expect(audit!.caller_user_id).toBeNull()

    // The geocoding rate-limit ledger has no foreign key of its own, so it is swept by hand.
    const [geo] = await sql`select 1 from geocode_requests where account_id = ${subject.id}`
    expect(geo).toBeUndefined()
  })
})
