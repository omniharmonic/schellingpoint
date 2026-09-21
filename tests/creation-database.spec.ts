import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { signInWithEmail } from './helpers/gathering'

// Creating, publishing and deleting a gathering against the running dev server (:3001) and the
// local stack (Postgres :55432, dev PDS :2583 with handle domain `.test`), plus the database
// guarantees of `create_event_with_program`. The dev server must run without a Resend key.
//
// Every account, event and gathering identity created here is removed afterwards, from
// Postgres and from the PDS.
loadEnvConfig(process.cwd(), true)

const base = process.env.EVENTS_TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const handleDomain = (process.env.PDS_HANDLE_DOMAIN || '').replace(/^\./, '')
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()
const configured = Boolean(isLocal && pdsUrl && pdsAdminPassword && handleDomain)

// Short and unique: a slug of at most 18 characters becomes the gathering's own handle.
const run = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1e3)}`
const emailPrefix = `pkga-create-${run}`
const shortSlug = `ga-${run}` // ≤ 18
const longSlug = `a-long-gathering-name-${run}` // > 18, ≤ 32
const draftSlug = `gd-${run}`
const privateSlug = `gp-${run}`

test.describe.configure({ mode: 'serial', retries: 0 })

const adminAuth = () => `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`

async function signIn(email: string): Promise<string> {
  return signInWithEmail(email, base)
}

function wizardState(slug: string, overrides: { visibility?: string; thresholds?: Record<string, unknown> } = {}) {
  return {
    currentStep: 9,
    basics: { name: `Creation test ${slug}`, tagline: '', description: 'A test gathering', slug, eventType: 'unconference', visibility: overrides.visibility ?? 'public' },
    dates: { startDate: '2027-03-01', endDate: '2027-03-02', timezone: 'America/Denver', locationName: 'Boulder', locationAddress: '', locationType: 'in-person' },
    venues: [{ id: 'room-1', name: 'Main hall', capacity: 40, features: [], address: '' }],
    schedule: { timeSlots: [{ id: 'slot-1', venueId: 'room-1', dayDate: '2027-03-01', startTime: '10:00', endTime: '11:00', label: '', isBreak: false }] },
    tracks: [{ id: 'track-1', name: 'Commons', color: '#246653', description: '' }],
    suggestedTopics: [],
    voting: {
      credits: 100, mechanism: 'quadratic', votingOpensAt: null, votingClosesAt: null, proposalsOpenAt: null, proposalsCloseAt: null,
      maxProposalsPerUser: 3, requireProposalApproval: false, allowedFormats: ['talk', 'workshop'], allowedDurations: [30, 60],
      policyThresholds: overrides.thresholds ?? { destructiveActionStewards: 2, feedbackK: 3, publishRoles: false },
    },
    branding: {
      logoUrl: null, bannerUrl: null,
      theme: { primary: '#246653', secondary: '#E8F1EB', accent: '#DCD5ED', mode: 'light' },
      // The wizard edits one list; storage keeps the four legacy keys plus `links` for everything else.
      social: { twitter: '', telegram: '', discord: '', website: 'https://example.test', links: [{ label: 'Signal', url: 'https://signal.group/example' }] },
    },
    identity: { acknowledged: true, termsAccepted: true },
    validation: {},
  }
}

async function create(cookie: string, state: unknown) {
  const res = await fetch(`${base}/api/events/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ wizardState: state }),
  })
  return { status: res.status, body: await res.json() }
}

async function patch(cookie: string, eventId: string, body: unknown) {
  const res = await fetch(`${base}/api/events/${eventId}/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function resolveHandle(handle: string): Promise<string | null> {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`)
  if (!res.ok) return null
  return ((await res.json()) as { did?: string }).did ?? null
}

test.describe('creating a gathering', () => {
  test.skip(!configured, 'needs the local stack: local DATABASE_URL, PDS_URL, PDS_ADMIN_PASSWORD, PDS_HANDLE_DOMAIN')

  let sql: postgres.Sql
  let owner = ''
  let outsider = ''
  const gatheringDids = new Set<string>()

  test.beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 2, onnotice: () => {} })
    owner = await signIn(`${emailPrefix}-owner@example.com`)
    outsider = await signIn(`${emailPrefix}-outsider@example.com`)
  })

  test.afterAll(async () => {
    const events = await sql<{ id: string; actor_did: string | null }[]>`
      select id, actor_did from events where slug in ${sql([shortSlug, longSlug, draftSlug, privateSlug])}
    `
    for (const e of events) if (e.actor_did) gatheringDids.add(e.actor_did)
    const accounts = await sql<{ id: string; did: string }[]>`select id, did from accounts where email like ${`${emailPrefix}%`}`
    const accountIds = accounts.map((a) => a.id)
    const eventIds = events.map((e) => e.id)
    // Identities minted (and possibly deleted again) by this run's organisers, from their audit trail.
    if (accountIds.length) {
      const audited = await sql<{ actor_did: string }[]>`
        select distinct actor_did from at_audit where caller_user_id in ${sql(accountIds)} and actor_did is not null
      `
      for (const a of audited) gatheringDids.add(a.actor_did)
    }
    const allDids = [...gatheringDids, ...accounts.map((a) => a.did)]
    if (allDids.length) await sql`delete from at_records where did in ${sql(allDids)}`
    if (gatheringDids.size) await sql`delete from at_audit where actor_did in ${sql([...gatheringDids])}`
    if (eventIds.length) await sql`delete from at_audit where event_id in ${sql(eventIds)}`
    if (accountIds.length) await sql`delete from at_audit where caller_user_id in ${sql(accountIds)}`
    if (events.length) await sql`delete from events where id in ${sql(eventIds)}`
    for (const did of [...gatheringDids, ...accounts.map((a) => a.did)]) {
      await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: adminAuth() },
        body: JSON.stringify({ did }),
      })
    }
    if (gatheringDids.size) await sql`delete from at_credentials where did in ${sql([...gatheringDids])}`
    if (accounts.length) await sql`delete from accounts where id in ${sql(accounts.map((a) => a.id))}`
    await sql`delete from auth_email_tokens where email like ${`${emailPrefix}%`}`
    await sql.end()
  })

  test('a signed-in custodial user creates a gathering: owner, program, thresholds, and a DID with its own handle', async () => {
    const { status, body } = await create(owner, wizardState(shortSlug, { thresholds: { destructiveActionStewards: 3, feedbackK: 4, publishRoles: false } }))
    expect(status, JSON.stringify(body)).toBe(201)
    expect(body).toMatchObject({ success: true, eventSlug: shortSlug, identity: { status: 'created', handle: `${shortSlug}.${handleDomain}` } })
    expect(body.identity.did).toMatch(/^did:plc:/)
    gatheringDids.add(body.identity.did)

    const [event] = await sql<{
      id: string; status: string; actor_did: string; actor_handle: string; policy_thresholds: Record<string, unknown>
      require_proposal_approval: boolean; created_by: string; owner_email: string; venues: number; slots: number; tracks: number
      theme: { social?: Record<string, unknown> }
    }[]>`
      select e.id, e.status, e.actor_did, e.actor_handle, e.policy_thresholds, e.require_proposal_approval, e.created_by, e.theme,
             (select a.email from event_members m join accounts a on a.id = m.user_id where m.event_id = e.id and m.role = 'owner') as owner_email,
             (select count(*)::int from venues where event_id = e.id) as venues,
             (select count(*)::int from time_slots where event_id = e.id) as slots,
             (select count(*)::int from tracks where event_id = e.id) as tracks
      from events e where e.slug = ${shortSlug}
    `
    expect(event).toMatchObject({
      status: 'draft',
      actor_did: body.identity.did,
      actor_handle: `${shortSlug}.${handleDomain}`,
      require_proposal_approval: false,
      owner_email: `${emailPrefix}-owner@example.com`,
      venues: 1, slots: 1, tracks: 1,
    })
    expect(event.policy_thresholds).toEqual({ destructiveActionStewards: 3, feedbackK: 4, publishRoles: false })
    // Social links: legacy keys stay where they were; other labels land in `theme.social.links`.
    expect(event.theme.social).toMatchObject({ website: 'https://example.test', links: [{ label: 'Signal', url: 'https://signal.group/example' }] })
    expect(event.theme.social).not.toHaveProperty('twitter')

    // The DID exists on our PDS and the handle resolves to it.
    expect(await resolveHandle(`${shortSlug}.${handleDomain}`)).toBe(body.identity.did)
    const [credential] = await sql<{ kind: string; wrapped: boolean }[]>`
      select kind, wrapped is not null as wrapped from at_credentials where did = ${body.identity.did}
    `
    expect(credential).toMatchObject({ kind: 'app-password', wrapped: true })

    // A draft has published nothing.
    const record = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${body.identity.did}&collection=schellingpoint.draft.gathering&rkey=self`)
    expect(record.status).toBe(400)
  })

  test('the slug is now taken, as an event and as a handle label', async () => {
    const again = await create(outsider, wizardState(shortSlug))
    expect(again.status).toBe(409)
    expect(again.body.success).toBe(false)
  })

  test('a slug longer than the PDS label limit gets a generated handle', async () => {
    const { status, body } = await create(owner, wizardState(longSlug))
    expect(status, JSON.stringify(body)).toBe(201)
    expect(body.identity.status).toBe('created')
    gatheringDids.add(body.identity.did)
    expect(body.identity.handle).not.toContain(longSlug)
    expect(body.identity.handle.endsWith(`.${handleDomain}`)).toBe(true)
    expect(await resolveHandle(body.identity.handle)).toBe(body.identity.did)
  })

  test('invalid thresholds and oversize slugs are refused before anything is written', async () => {
    const thresholds = await create(owner, wizardState(`gx-${run}`, { thresholds: { destructiveActionStewards: 9, feedbackK: 3, publishRoles: false } }))
    expect(thresholds.status).toBe(400)
    const tooLong = await create(owner, wizardState(`this-slug-is-far-too-long-for-a-label-${run}`))
    expect(tooLong.status).toBe(400)
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from events where slug like ${`gx-${run}%`} or slug like ${`this-slug-is-far%`}`
    expect(n.n).toBe(0)
  })

  test('only organizers change settings; others get 403 or 404', async () => {
    const [event] = await sql<{ id: string }[]>`select id from events where slug = ${shortSlug}`
    // Draft: an outsider cannot even learn it exists.
    expect((await patch(outsider, event.id, { name: 'Hijacked' })).status).toBe(404)
    const saved = await patch(owner, event.id, { policy_thresholds: { feedbackK: 5 }, require_proposal_approval: true })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.event.policy_thresholds).toEqual({ destructiveActionStewards: 3, feedbackK: 5, publishRoles: false })
    expect(saved.body.network).toEqual([]) // a draft writes nothing to the network
  })

  test('draft → published writes gathering@self in the gathering repo', async () => {
    const [event] = await sql<{ id: string; actor_did: string }[]>`select id, actor_did from events where slug = ${shortSlug}`
    const { status, body } = await patch(owner, event.id, { status: 'published' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.event.status).toBe('published')
    expect(body.network).toHaveLength(1)
    expect(body.network[0]).toMatchObject({ action: 'publish-gathering', ok: true })
    expect(body.network[0].written).toContain(`at://${event.actor_did}/schellingpoint.draft.gathering/self`)

    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${event.actor_did}&collection=schellingpoint.draft.gathering&rkey=self`)
    expect(res.status).toBe(200)
    const record = await res.json()
    expect(record.value).toMatchObject({ $type: 'schellingpoint.draft.gathering', name: `Creation test ${shortSlug}` })

    const [row] = await sql<{ gathering_uri: string; published: boolean }[]>`
      select gathering_uri, atproto_published_at is not null as published from events where id = ${event.id}
    `
    expect(row).toMatchObject({ gathering_uri: `at://${event.actor_did}/schellingpoint.draft.gathering/self`, published: true })

    // Now public: the page names the gathering's handle.
    const page = await (await fetch(`${base}/e/${shortSlug}`)).text()
    expect(page).toContain(`${shortSlug}.${handleDomain}`)
  })

  test('a gathering with published records cannot be deleted', async () => {
    const [event] = await sql<{ id: string }[]>`select id from events where slug = ${shortSlug}`
    const res = await fetch(`${base}/api/events/${event.id}/settings`, { method: 'DELETE', headers: { origin: base, cookie: owner } })
    expect(res.status).toBe(409)
  })

  test('deleting a draft removes its PDS account and credential', async () => {
    const { status, body } = await create(owner, wizardState(draftSlug))
    expect(status, JSON.stringify(body)).toBe(201)
    const did = body.identity.did as string
    gatheringDids.add(did)
    expect(await resolveHandle(`${draftSlug}.${handleDomain}`)).toBe(did)

    const forbidden = await fetch(`${base}/api/events/${body.event.id}/settings`, { method: 'DELETE', headers: { origin: base, cookie: outsider } })
    expect(forbidden.status).toBe(404)

    const res = await fetch(`${base}/api/events/${body.event.id}/settings`, { method: 'DELETE', headers: { origin: base, cookie: owner } })
    expect(res.status, await res.clone().text()).toBe(200)

    expect(await resolveHandle(`${draftSlug}.${handleDomain}`)).toBeNull()
    const info = await fetch(`${pdsUrl}/xrpc/com.atproto.admin.getAccountInfo?did=${encodeURIComponent(did)}`, { headers: { authorization: adminAuth() } })
    expect(info.ok).toBe(false)
    const [counts] = await sql<{ events: number; credentials: number }[]>`
      select (select count(*)::int from events where slug = ${draftSlug}) as events,
             (select count(*)::int from at_credentials where did = ${did}) as credentials
    `
    expect(counts).toEqual({ events: 0, credentials: 0 })
    gatheringDids.delete(did)
  })

  test('joining is refused while a paid ticket is required, and allowed once it is not', async () => {
    const [event] = await sql<{ id: string }[]>`select id from events where slug = ${shortSlug}`
    await sql`update events set ticketing_enabled = true where id = ${event.id}`
    const [tier] = await sql<{ id: string }[]>`
      insert into ticket_tiers (event_id, name, price_cents, is_active) values (${event.id}, 'Supporter', 2500, true) returning id
    `
    const me = await (await fetch(`${base}/api/v1/events/${shortSlug}/me`, { headers: { cookie: outsider } })).json()
    expect(me).toMatchObject({ member: false, joinable: false, joinBlockedBy: 'ticket-required' })
    const refused = await fetch(`${base}/api/v1/events/${shortSlug}/me`, { method: 'POST', headers: { cookie: outsider, origin: base } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'TicketRequired', ticketsUrl: `/e/${shortSlug}/tickets` })

    await sql`delete from ticket_tiers where id = ${tier.id}`
    await sql`update events set ticketing_enabled = false where id = ${event.id}`
    const joined = await fetch(`${base}/api/v1/events/${shortSlug}/me`, { method: 'POST', headers: { cookie: outsider, origin: base } })
    expect(joined.status).toBe(201)
    const [row] = await sql<{ role: string }[]>`
      select m.role from event_members m join accounts a on a.id = m.user_id
      where m.event_id = ${event.id} and a.email = ${`${emailPrefix}-outsider@example.com`}
    `
    expect(row?.role).toBe('attendee')
  })

  test('a private gathering is gated for non-members', async () => {
    const { status, body } = await create(owner, wizardState(privateSlug, { visibility: 'private' }))
    expect(status, JSON.stringify(body)).toBe(201)
    gatheringDids.add(body.identity.did)
    await patch(owner, body.event.id, { status: 'published' })

    const outsiderPage = await (await fetch(`${base}/e/${privateSlug}`, { headers: { cookie: outsider } })).text()
    expect(outsiderPage).toContain('<title>Gathering not available</title>')
    expect(outsiderPage).not.toContain(`Creation test ${privateSlug}`)
    expect((await fetch(`${base}/api/v1/events/${privateSlug}/me`, { headers: { cookie: outsider } })).status).toBe(404)
    expect((await fetch(`${base}/api/v1/events/${privateSlug}/me`, { method: 'POST', headers: { cookie: outsider, origin: base } })).status).toBe(404)

    const ownerPage = await (await fetch(`${base}/e/${privateSlug}`, { headers: { cookie: owner } })).text()
    expect(ownerPage).toContain(`Creation test ${privateSlug}`)

    const directory = await (await fetch(`${base}/events`)).text()
    expect(directory).not.toContain(`Creation test ${privateSlug}`)
  })
})

test.describe('create_event_with_program', () => {
  test.skip(!isLocal, 'Database regression tests only run against the local stack')

  let sql: postgres.Sql
  test.beforeAll(() => { sql = postgres(databaseUrl, { max: 2, onnotice: () => {} }) })
  test.afterAll(async () => { await sql.end() })

  const baseEvent = (slug: string, createdBy: string | null) => ({
    slug, name: 'Rollback test', start_date: '2026-10-16', end_date: '2026-10-17', timezone: 'UTC',
    created_by: createdBy, visibility: 'private', vote_credits_per_user: 36, voting_mechanism: 'quadratic',
  })

  test('a failed room write rolls back the event rather than returning partial success', async () => {
    const slug = `rollback-room-${run}`
    const [profile] = await sql<{ id: string }[]>`select id from profiles limit 1`
    const error = await sql`
      select public.create_event_with_program(
        ${sql.json(baseEvent(slug, profile.id) as never)}::jsonb,
        ${sql.json([{ id: randomUUID(), name: null, slug: 'invalid' }] as never)}::jsonb,
        '[]'::jsonb, '[]'::jsonb)
    `.then(() => null, (e: { code?: string }) => e)
    expect(error?.code).toBe('23502')
    expect(await sql`select id from events where slug = ${slug}`).toHaveLength(0)
  })

  test('owner membership failure rolls back the entire event', async () => {
    const slug = `rollback-owner-${run}`
    const error = await sql`
      select public.create_event_with_program(${sql.json(baseEvent(slug, null) as never)}::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
    `.then(() => null, (e: { code?: string }) => e)
    expect(error?.code).toBe('23502')
    expect(await sql`select id from events where slug = ${slug}`).toHaveLength(0)
  })

  test('a schedule slot may not reference another event’s room', async () => {
    const slug = `rollback-slot-${run}`
    const [profile] = await sql<{ id: string }[]>`select id from profiles limit 1`
    const [foreign] = await sql<{ id: string }[]>`select id from venues limit 1`
    test.skip(!foreign, 'no seeded venue to borrow')
    const error = await sql`
      select public.create_event_with_program(
        ${sql.json(baseEvent(slug, profile.id) as never)}::jsonb, '[]'::jsonb, '[]'::jsonb,
        ${sql.json([{ venue_id: foreign.id, start_time: '2026-10-16T10:00:00Z', end_time: '2026-10-16T11:00:00Z', day_date: '2026-10-16', is_break: false, slot_type: 'session' }] as never)}::jsonb)
    `.then(() => null, (e: { code?: string }) => e)
    expect(error?.code).toBe('23514')
    expect(await sql`select id from events where slug = ${slug}`).toHaveLength(0)
  })

  test('the signed-in and anonymous roles cannot call it directly', async () => {
    for (const role of ['anon', 'authenticated']) {
      const error = await sql.begin(async (t) => {
        await t`select set_config('role', ${role}, true)`
        await t`select public.create_event_with_program('{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`
      }).then(() => null, (e: { code?: string }) => e)
      expect(error?.code, role).toBe('42501')
    }
  })

  test('new events default to open proposals and the default thresholds', async () => {
    const [defaults] = await sql<{ approval: string; thresholds: string }[]>`
      select
        (select column_default from information_schema.columns where table_name = 'events' and column_name = 'require_proposal_approval') as approval,
        (select column_default from information_schema.columns where table_name = 'events' and column_name = 'policy_thresholds') as thresholds
    `
    expect(defaults.approval).toBe('false')
    expect(defaults.thresholds).toContain('"destructiveActionStewards": 2')
    expect(defaults.thresholds).toContain('"feedbackK": 3')
    expect(defaults.thresholds).toContain('"publishRoles": false')
    const bad = await sql`select public.valid_policy_thresholds('{"destructiveActionStewards": 6, "feedbackK": 3, "publishRoles": false}'::jsonb) as ok`
    expect(bad[0].ok).toBe(false)
  })
})
