import { test, expect, chromium } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * Map (spec §8) end to end against the running dev server (:3001), the local Postgres and the
 * local PDS: the geocode route's authorization, rate limit and cache; venue coordinates on the
 * admin API and in the published venue record (present for a public venue, absent for a private
 * residence); a self-hosted session's exact point by tier (members with attendee details see it,
 * everyone else the ≈1 km point, the calendar event carries only the coarse one); map reads by
 * membership tier; and the privacy audit's geo check over the data this run created.
 *
 * Nominatim is never contacted: every geocode query used here is seeded into `geocode_cache`
 * first. Everything created here is removed.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.SESSIONS_TEST_BASE_URL || 'http://localhost:3001'
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(ownerUrl && pdsUrl && pdsAdminPassword)
const SHOTS = process.env.MAP_SHOTS_DIR || ''

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
// Away from every venue: the audit refuses any published geo within 0.005° of an exact point.
const EXACT = { lat: 40.041234, lng: -105.231456 }
const COARSE = { lat: 40.04, lng: -105.23 }

async function api(path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { origin: base }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body, text, headers: res.headers }
}

async function getRecord(uri: string): Promise<{ cid: string; value: Record<string, unknown> } | null> {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) return null
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(m[1]!)}&collection=${m[2]}&rkey=${m[3]}`)
  return res.ok ? res.json() : null
}

/** The cache key `src/lib/geo/geocode.ts` uses: sha256 of the normalized query. */
function queryHash(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400)).digest('hex')
}

function geoLocations(record: Record<string, unknown>): Array<{ latitude: string; longitude: string }> {
  const locations = Array.isArray(record.locations) ? (record.locations as Array<Record<string, unknown>>) : []
  return locations.filter((l) => l.$type === 'community.lexicon.location.geo') as Array<{ latitude: string; longitude: string }>
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('map', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')

  let sql: postgres.Sql
  let gathering: TestGathering
  let privateGathering: TestGathering
  let owner: TestAccount
  let attendee: TestAccount
  let stranger: TestAccount
  let publicVenueId = ''
  let homeVenueId = ''
  let selfHostedId = ''
  let slotId = ''
  const QUERY = `Pearl Street Mall, Boulder ${RUN}`

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'map', status: 'proposals_open', withProgram: true })
    privateGathering = await createTestGathering(sql, { tag: 'mapp', status: 'proposals_open', visibility: 'private', withProgram: true })
    owner = await createTestAccount('map-owner', { sql, base })
    attendee = await createTestAccount('map-attendee', { sql, base })
    stranger = await createTestAccount('map-stranger', { sql, base })
    await sql`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${attendee.id}, 'attendee'), (${privateGathering.id}, ${owner.id}, 'owner')`
    // Fresh accounts get the onboarding dialog on every workspace page; the screenshots want the pages themselves.
    await sql`update profiles set onboarding_completed = true where id in ${sql([owner.id, attendee.id, stranger.id])}`
    ;[publicVenueId, homeVenueId] = gathering.venueIds
    const [slot] = await sql<{ id: string }[]>`
      select id from time_slots where event_id = ${gathering.id} and venue_id = ${publicVenueId} and coalesce(is_break, false) = false order by start_time limit 1
    `
    slotId = slot!.id
    // Every lookup this run makes is answered from the cache: Nominatim is never contacted.
    await sql`
      insert into geocode_cache (query_hash, result, fetched_at)
      values (${queryHash(QUERY)}, ${sql.json({ lat: 40.0176, lng: -105.2797, label: 'Pearl Street Mall, Boulder, Colorado' })}, now())
      on conflict (query_hash) do update set result = excluded.result, fetched_at = now()
    `
  })

  test.afterAll(async () => {
    if (!sql) return
    try {
      await sql`delete from geocode_cache where query_hash = ${queryHash(QUERY)}`
      for (const a of [owner, attendee, stranger]) if (a) await sql`delete from geocode_requests where account_id = ${a.id}`
      await gathering?.cleanup()
      await privateGathering?.cleanup()
      for (const a of [owner, attendee, stranger]) await a?.cleanup()
    } finally {
      await sql.end({ timeout: 5 })
    }
  })

  test('geocode: organizers and proposing members may look up, strangers may not, private gatherings answer 404', async () => {
    const path = `/api/v1/events/${gathering.slug}/admin/geocode`
    expect((await api(path, { method: 'POST', json: { query: QUERY } })).status).toBe(401)
    const strangerRes = await api(path, { method: 'POST', cookie: stranger.cookie, json: { query: QUERY } })
    expect(strangerRes.status, strangerRes.text).toBe(403)
    // A cross-site browser request is refused before anything else.
    const cross = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: owner.cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: JSON.stringify({ query: QUERY }) })
    expect(cross.status).toBe(403)
    expect((await api(path, { method: 'POST', cookie: owner.cookie, json: { query: 'ab' } })).status).toBe(400)

    const ownerRes = await api(path, { method: 'POST', cookie: owner.cookie, json: { query: QUERY } })
    expect(ownerRes.status, ownerRes.text).toBe(200)
    expect(ownerRes.body).toEqual({ result: { lat: 40.0176, lng: -105.2797, label: 'Pearl Street Mall, Boulder, Colorado' }, cached: true })
    // The same address sent in parts (what the map editor sends for a room) keys the same cache
    // entry as the one line it makes, so a room is never geocoded twice or answered two ways.
    const [street, ...rest] = QUERY.split(', ')
    const structured = await api(path, { method: 'POST', cookie: owner.cookie, json: { address: { street, locality: rest.join(', ') } } })
    expect(structured.status, structured.text).toBe(200)
    expect(structured.body).toEqual(ownerRes.body)

    // A member while proposals are open (they are placing the session they are about to propose).
    const memberRes = await api(path, { method: 'POST', cookie: attendee.cookie, json: { query: QUERY } })
    expect(memberRes.status, memberRes.text).toBe(200)
    expect(memberRes.body.cached).toBe(true)

    const hidden = await api(`/api/v1/events/${privateGathering.slug}/admin/geocode`, { method: 'POST', cookie: stranger.cookie, json: { query: QUERY } })
    expect(hidden.status).toBe(404)
    expect((await api(`/api/v1/events/${privateGathering.slug}/admin/geocode`, { method: 'POST', cookie: owner.cookie, json: { query: QUERY } })).status).toBe(200)
  })

  test('geocode: 30 lookups an hour per account, then 429 with Retry-After', async () => {
    const path = `/api/v1/events/${gathering.slug}/admin/geocode`
    let ok = 0
    let limited: Awaited<ReturnType<typeof api>> | null = null
    for (let i = 0; i < 35; i++) {
      const res = await api(path, { method: 'POST', cookie: attendee.cookie, json: { query: QUERY } })
      if (res.status === 200) ok++
      else { limited = res; break }
    }
    expect(limited, 'the 31st lookup is refused').not.toBeNull()
    expect(limited!.status).toBe(429)
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(limited!.body.code).toBe('GeocodeRateLimited')
    // One call was spent in the previous test.
    expect(ok).toBe(29)
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from geocode_requests where account_id = ${attendee.id}`
    expect(row!.n).toBe(30)
  })

  test('venue coordinates round-trip; a public venue publishes location.geo, a private residence does not', async () => {
    const admin = `/api/v1/events/${gathering.slug}/admin/venues`
    const placed = await api(`${admin}/${publicVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { latitude: 40.0176, longitude: -105.2797, geocoded_from: QUERY } })
    expect(placed.status, placed.text).toBe(200)
    expect(placed.body.venue).toMatchObject({ latitude: 40.0176, longitude: -105.2797, geocoded_from: QUERY })
    // A home two blocks away: placed for members, never published.
    const home = await api(`${admin}/${homeVenueId}`, {
      method: 'PATCH', cookie: owner.cookie,
      json: { is_private_residence: true, address: `12 Hidden Ct ${RUN}`, locality: 'Boulder', latitude: 40.0301, longitude: -105.265 },
    })
    expect(home.status, home.text).toBe(200)
    expect(home.body.venue).toMatchObject({ latitude: 40.0301, longitude: -105.265, is_private_residence: true })
    // A half point is refused (a single coordinate merges into the existing pin).
    expect((await api(`${admin}/${publicVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { latitude: 41, longitude: null } })).status).toBe(400)
    expect((await api(`${admin}/${publicVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { latitude: 200, longitude: 0 } })).status).toBe(400)
    const listed = await api(admin, { cookie: owner.cookie })
    expect(listed.body.venues.find((v: any) => v.id === publicVenueId)).toMatchObject({ latitude: 40.0176, longitude: -105.2797 })

    const minted = await api(`/api/v1/events/${gathering.slug}/admin/atproto`, { method: 'POST', cookie: owner.cookie, json: { action: 'mint' } })
    expect(minted.status, minted.text).toBe(200)
    const published = await api(`/api/v1/events/${gathering.slug}/admin/atproto/publish`, { method: 'POST', cookie: owner.cookie, json: { what: 'all' } })
    expect(published.status, published.text).toBe(200)
    expect(published.body.results.filter((r: any) => r.error)).toEqual([])

    const rows = await sql<{ id: string; at_uri: string }[]>`select id, at_uri from venues where event_id = ${gathering.id} and at_uri is not null`
    const publicRecord = await getRecord(rows.find((r) => r.id === publicVenueId)!.at_uri)
    expect(publicRecord, 'public venue record on the PDS').toBeTruthy()
    expect(geoLocations(publicRecord!.value)).toEqual([{ $type: 'community.lexicon.location.geo', latitude: '40.0176', longitude: '-105.2797' }])

    const homeRecord = await getRecord(rows.find((r) => r.id === homeVenueId)!.at_uri)
    expect(homeRecord, 'private residence record on the PDS').toBeTruthy()
    expect(geoLocations(homeRecord!.value)).toEqual([])
    expect(JSON.stringify(homeRecord!.value)).not.toContain('Hidden Ct')
    expect(JSON.stringify(homeRecord!.value)).not.toContain('40.03')
    expect((homeRecord!.value.locations as Array<Record<string, unknown>>)[0]).toMatchObject({ $type: 'community.lexicon.location.address', locality: 'Boulder' })
  })

  test('self-hosted session: attendee details see the exact point, others the ≈1 km point, the calendar event carries only the coarse one', async () => {
    const created = await api('/api/v1/sessions', {
      method: 'POST', cookie: attendee.cookie,
      json: {
        event_slug: gathering.slug, title: `Porch talk ${RUN}`, format: 'discussion', duration: 30,
        is_self_hosted: true, custom_location: `77 Secret Lane ${RUN}`, public_place: 'Near Pearl St',
        location_lat: EXACT.lat, location_lng: EXACT.lng,
      },
    })
    expect(created.status, created.text).toBe(201)
    selfHostedId = created.body.id
    const [stored] = await sql<{ location_lat: number; location_lng: number; public_geo: { lat: number; lng: number } }[]>`
      select location_lat::float8 as location_lat, location_lng::float8 as location_lng, public_geo from sessions where id = ${selfHostedId}
    `
    expect(stored).toEqual({ location_lat: EXACT.lat, location_lng: EXACT.lng, public_geo: COARSE })

    const detail = `/api/v1/events/${gathering.slug}/sessions/${selfHostedId}`
    const asHost = await api(detail, { cookie: attendee.cookie })
    expect(asHost.body.session.location_geo).toEqual({ ...EXACT, exact: true })
    const asOrganizer = await api(detail, { cookie: owner.cookie })
    expect(asOrganizer.body.session.location_geo).toEqual({ ...EXACT, exact: true })
    const asStranger = await api(detail, { cookie: stranger.cookie })
    expect(asStranger.status, asStranger.text).toBe(200)
    expect(asStranger.body.session.location_geo).toEqual({ ...COARSE, exact: false })
    expect(asStranger.text).not.toContain('40.041')
    expect(asStranger.text).not.toContain('Secret Lane')
    const anon = await api(detail)
    expect(anon.body.session.location_geo).toEqual({ ...COARSE, exact: false })
    // The list the map reads applies the same tier.
    const list = await api(`/api/v1/events/${gathering.slug}/sessions?status=all`, { cookie: stranger.cookie })
    expect(list.text).not.toContain('40.041')

    // A stranger cannot move the pin; the host can; leaving self-hosting clears it.
    expect((await api(`/api/v1/sessions/${selfHostedId}`, { method: 'PATCH', cookie: stranger.cookie, json: { location_lat: 1, location_lng: 1 } })).status).toBe(403)
    const moved = await api(`/api/v1/sessions/${selfHostedId}`, { method: 'PATCH', cookie: attendee.cookie, json: { location_lat: 40.0555, location_lng: -105.2455 } })
    expect(moved.status, moved.text).toBe(200)
    const [after] = await sql<{ public_geo: { lat: number; lng: number } }[]>`select public_geo from sessions where id = ${selfHostedId}`
    expect(after!.public_geo).toEqual({ lat: 40.06, lng: -105.25 })
    // Put the original point back for the record check below.
    await api(`/api/v1/sessions/${selfHostedId}`, { method: 'PATCH', cookie: attendee.cookie, json: { location_lat: EXACT.lat, location_lng: EXACT.lng } })

    // Scheduled (an organizer gives it a slot) and published: the calendar event has the coarse point only.
    await sql`update sessions set status = 'scheduled', time_slot_id = ${slotId}, venue_id = null where id = ${selfHostedId}`
    const published = await api(`/api/v1/events/${gathering.slug}/admin/atproto/publish`, { method: 'POST', cookie: owner.cookie, json: { what: 'schedule' } })
    expect(published.status, published.text).toBe(200)
    const mine = published.body.results.filter((r: any) => r.id === selfHostedId)
    expect(mine.filter((r: any) => r.error)).toEqual([])
    const [row] = await sql<{ calendar_event_uri: string | null }[]>`select calendar_event_uri from sessions where id = ${selfHostedId}`
    expect(row!.calendar_event_uri).toBeTruthy()
    const calendar = await getRecord(row!.calendar_event_uri!)
    expect(calendar).toBeTruthy()
    expect(geoLocations(calendar!.value)).toEqual([{ $type: 'community.lexicon.location.geo', latitude: '40.04', longitude: '-105.23' }])
    const text = JSON.stringify(calendar!.value)
    expect(text).not.toContain('40.041')
    expect(text).not.toContain('Secret Lane')
  })

  test('published geo never goes stale: a corrected self-hosted pin, a moved venue pin and a private-residence flip rewrite the calendar events', async () => {
    // 1. The host corrects their pin after publication: the record's coarse point follows.
    const corrected = await api(`/api/v1/sessions/${selfHostedId}`, { method: 'PATCH', cookie: attendee.cookie, json: { location_lat: 40.0812, location_lng: -105.1712 } })
    expect(corrected.status, corrected.text).toBe(200)
    expect(corrected.body.network, corrected.text).toMatchObject({ uri: expect.stringContaining('community.lexicon.calendar.event') })
    expect(corrected.body.network.error).toBeUndefined()
    const [selfRow] = await sql<{ calendar_event_uri: string }[]>`select calendar_event_uri from sessions where id = ${selfHostedId}`
    const selfRecord = await getRecord(selfRow!.calendar_event_uri)
    expect(geoLocations(selfRecord!.value)).toEqual([{ $type: 'community.lexicon.location.geo', latitude: '40.08', longitude: '-105.17' }])
    expect(JSON.stringify(selfRecord!.value)).not.toContain('40.0812')

    // 2. A published session in the public room: moving the room's pin rewrites its event.
    const proposed = await api('/api/v1/sessions', {
      method: 'POST', cookie: attendee.cookie,
      json: { event_slug: gathering.slug, title: `Hall talk ${RUN}`, format: 'talk', duration: 30 },
    })
    expect(proposed.status, proposed.text).toBe(201)
    const hallId = proposed.body.id as string
    const [otherSlot] = await sql<{ id: string }[]>`
      select id from time_slots where event_id = ${gathering.id} and venue_id = ${publicVenueId} and coalesce(is_break, false) = false and id <> ${slotId} order by start_time limit 1
    `
    await sql`update sessions set status = 'scheduled', time_slot_id = ${otherSlot!.id}, venue_id = ${publicVenueId} where id = ${hallId}`
    const published = await api(`/api/v1/events/${gathering.slug}/admin/atproto/publish`, { method: 'POST', cookie: owner.cookie, json: { what: 'schedule' } })
    expect(published.status, published.text).toBe(200)
    const [hallRow] = await sql<{ calendar_event_uri: string }[]>`select calendar_event_uri from sessions where id = ${hallId}`
    expect(geoLocations((await getRecord(hallRow!.calendar_event_uri))!.value)).toEqual([{ $type: 'community.lexicon.location.geo', latitude: '40.0176', longitude: '-105.2797' }])

    const moved = await api(`/api/v1/events/${gathering.slug}/admin/venues/${publicVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { latitude: 40.0251, longitude: -105.2913 } })
    expect(moved.status, moved.text).toBe(200)
    expect(moved.body.network.sessions, moved.text).toMatchObject({ attempted: true })
    expect(moved.body.network.sessions.results.filter((r: any) => r.error)).toEqual([])
    expect(moved.body.network.sessions.results.some((r: any) => r.kind === 'session-event' && r.id === hallId)).toBe(true)
    expect(geoLocations((await getRecord(hallRow!.calendar_event_uri))!.value)).toEqual([{ $type: 'community.lexicon.location.geo', latitude: '40.0251', longitude: '-105.2913' }])

    // 3. Flipping the room to a private residence removes the geo from the venue record AND the event.
    const flipped = await api(`/api/v1/events/${gathering.slug}/admin/venues/${publicVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { is_private_residence: true, locality: 'Boulder' } })
    expect(flipped.status, flipped.text).toBe(200)
    expect(flipped.body.network.sessions.results.filter((r: any) => r.error)).toEqual([])
    expect(geoLocations((await getRecord(hallRow!.calendar_event_uri))!.value)).toEqual([])
    const [venueRow] = await sql<{ at_uri: string }[]>`select at_uri from venues where id = ${publicVenueId}`
    expect(geoLocations((await getRecord(venueRow!.at_uri))!.value)).toEqual([])
    // Nothing flagged: the refreshes kept the index in step with the app.
    const status = await api(`/api/v1/events/${gathering.slug}/admin/atproto`, { cookie: owner.cookie })
    expect(status.status, status.text).toBe(200)
    expect(status.body.flagged.filter((f: any) => f.kind === 'location-changed')).toEqual([])
    // Back to a public room for the checks that follow.
    await api(`/api/v1/events/${gathering.slug}/admin/venues/${publicVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { is_private_residence: false } })

    // 4. When a refresh is missed (the app row changes behind the route), the Network page flags it.
    await sql`update sessions set public_geo = ${sql.json({ lat: 40.09, lng: -105.16 })}, updated_at = now() where id = ${selfHostedId}`
    const stale = await api(`/api/v1/events/${gathering.slug}/admin/atproto`, { cookie: owner.cookie })
    expect(stale.body.flagged).toEqual(expect.arrayContaining([expect.objectContaining({ id: selfHostedId, kind: 'location-changed' })]))
    const republished = await api(`/api/v1/events/${gathering.slug}/admin/atproto/sessions/${selfHostedId}`, { method: 'POST', cookie: owner.cookie, json: { action: 'republish' } })
    expect(republished.status, republished.text).toBe(200)
    expect(geoLocations((await getRecord(selfRow!.calendar_event_uri))!.value)).toEqual([{ $type: 'community.lexicon.location.geo', latitude: '40.09', longitude: '-105.16' }])
    const clear = await api(`/api/v1/events/${gathering.slug}/admin/atproto`, { cookie: owner.cookie })
    expect(clear.body.flagged.filter((f: any) => f.kind === 'location-changed')).toEqual([])
  })

  test('map reads follow membership: a private gathering is 404 to strangers, readable to members', async () => {
    const list = `/api/v1/events/${privateGathering.slug}/sessions?status=scheduled&timed=1&sort=time`
    expect((await api(list)).status).toBe(404)
    expect((await api(list, { cookie: stranger.cookie })).status).toBe(404)
    expect((await api(list, { cookie: owner.cookie })).status).toBe(200)
    const strangerPage = await fetch(`${base}/e/${privateGathering.slug}/map`, { headers: { cookie: stranger.cookie } })
    expect(await strangerPage.text()).not.toContain(privateGathering.name)
    const ownerPage = await fetch(`${base}/e/${gathering.slug}/map`, { headers: { cookie: owner.cookie } })
    expect(ownerPage.status).toBe(200)
    // The organizer's map area is app-side: saved through settings, never in a record.
    const view = { center: [-105.25, 40.03], zoom: 12.5 }
    const saved = await api(`/api/events/${gathering.id}/settings`, { method: 'PATCH', cookie: owner.cookie, json: { map: view } })
    expect(saved.status, saved.text).toBe(200)
    const [row] = await sql<{ map: unknown }[]>`select map from events where id = ${gathering.id}`
    expect(row!.map).toEqual(view)
    expect((await api(`/api/events/${gathering.id}/settings`, { method: 'PATCH', cookie: owner.cookie, json: { map: { center: [500, 0], zoom: 3 } } })).status).toBe(400)
    const records = await sql<{ record: unknown }[]>`select record from at_records where did = (select actor_did from events where id = ${gathering.id})`
    expect(JSON.stringify(records)).not.toContain('"zoom"')
  })

  test('the privacy audit passes with this run’s geo data in place', async () => {
    test.setTimeout(240_000)
    const out = execFileSync('npx', ['tsx', 'scripts/atproto-privacy-audit.ts'], { cwd: process.cwd(), encoding: 'utf8', env: process.env, timeout: 200_000 })
    expect(out).toContain('[ ok ] geo')
    expect(out).toMatch(/geo points in gathering records:\s+[1-9]/)
    expect(out.trim().endsWith('PASS')).toBe(true)
  })

  test('screenshots (optional, MAP_SHOTS_DIR)', async () => {
    test.skip(!SHOTS, 'MAP_SHOTS_DIR not set')
    test.setTimeout(540_000)
    mkdirSync(SHOTS, { recursive: true })
    // Playwright's headless shell has no WebGL2 (MapLibre then falls back to the list, which the
    // page handles); SwiftShader gives the real map for pictures.
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
    const [name, value] = owner.cookie.split('=', 2)
    const shot = async (path: string, file: string, width: number, height: number, opts: { ready?: string; scrollTo?: string; click?: string; pre?: string } = {}) => {
      const context = await browser.newContext({ viewport: { width, height } })
      await context.addCookies([{ name: name!, value: value!, domain: 'localhost', path: '/' }])
      const page = await context.newPage()
      // Tiles keep streaming under SwiftShader, so never wait for network idle.
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined)
      await page.waitForTimeout(2_000)
      if (opts.pre) await page.getByRole('button', { name: opts.pre }).first().click({ timeout: 10_000 }).catch(() => undefined)
      if (opts.scrollTo) await page.locator(opts.scrollTo).first().scrollIntoViewIfNeeded().catch(() => undefined)
      if (opts.ready) await page.locator(opts.ready).first().waitFor({ timeout: 20_000 }).catch(() => undefined)
      await page.waitForTimeout(9_000)
      if (opts.click) await page.locator(opts.click).first().click({ timeout: 5_000 }).catch(() => undefined)
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${SHOTS}/${file}`, fullPage: false })
      await context.close()
    }
    try {
      await shot(`/e/${gathering.slug}/map`, 'map-desktop.png', 1280, 860, { ready: '.maplibregl-canvas', click: '.sp-map-pin' })
      await shot(`/e/${gathering.slug}/map`, 'map-mobile.png', 400, 820, { ready: '.maplibregl-canvas', click: '.sp-map-pin' })
      await shot(`/e/${gathering.slug}/admin/setup`, 'setup-map-card.png', 1280, 900, { scrollTo: '#venue-map', ready: '[data-testid="venue-map"] .maplibregl-canvas' })
      await shot(`/e/${gathering.slug}/sessions/${selfHostedId}`, 'session-detail-map.png', 1280, 900, { ready: '.maplibregl-canvas' })
      await shot(`/e/${gathering.slug}/propose`, 'propose-location-picker.png', 1280, 900, { pre: 'Self-hosted', scrollTo: '[data-testid="propose-location-map"]', ready: '.maplibregl-canvas' })
    } finally {
      await browser.close()
    }
  })
})
