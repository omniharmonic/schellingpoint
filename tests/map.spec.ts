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
 * Map v2 (design §1) on top of that: `resolveMapView`, outline and custom-map validation as unit
 * tests; the venues route's outline rules (member 403, private residence 409) and the custom-map
 * route's authorization; the multi-candidate address search and its own cache namespace; the
 * geocode-on-save path (a room with an address places itself, nobody presses "Place"); and a
 * browser pass that saves an address, sees the pin appear, draws a three-corner outline and finds
 * it again on the member map.
 *
 * Nominatim is never contacted: every geocode query used here is seeded into `geocode_cache`
 * first. Everything created here is removed.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || process.env.SESSIONS_TEST_BASE_URL || 'http://localhost:3001'
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

/**
 * The cache key `src/lib/geo/geocode.ts` uses: sha256 of the normalized query, prefixed by the
 * namespace (design §1.3 — the multi-candidate search keys its answers apart from single results).
 */
function queryHash(query: string, namespace = ''): string {
  return createHash('sha256').update(`${namespace}${query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400)}`).digest('hex')
}

/** Wait for a condition the server reaches on its own (an `after()` lookup landing). */
async function until<T>(what: string, read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function geoLocations(record: Record<string, unknown>): Array<{ latitude: string; longitude: string }> {
  const locations = Array.isArray(record.locations) ? (record.locations as Array<Record<string, unknown>>) : []
  return locations.filter((l) => l.$type === 'community.lexicon.location.geo') as Array<{ latitude: string; longitude: string }>
}

/* ═══════════════════════ unit: the map area, outlines, custom maps ═══════════════════════ */

import {
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_SINGLE_ZOOM,
  mapViewLabel,
  resolveMapView,
  zoomForBounds,
} from '../src/lib/geo/view'
import { OUTLINE_MAX_VERTICES, OutlineError, outlineRing, parseOutline } from '../src/lib/geo/outline'
import { CustomMapError, coarseSessionPoint, imageOnlyExtent, isImageOnly, parseCustomMap } from '../src/lib/geo/custom-map'
import { roundCoarse } from '../src/lib/geo/coarse'
import { shouldGeocodeOnSave } from '../src/lib/geo/venue-address'

const IMAGE = `/uploads/ab/${'a'.repeat(64)}.png`

test('the map area is the organizer’s override, else the fit of the located rooms', () => {
  const override = { center: [-105.25, 40.03] as [number, number], zoom: 12.5 }
  expect(resolveMapView({ map: override }, [])).toEqual({ view: override, source: 'override', located: 0 })

  // Nothing placed: nothing to open the map on.
  expect(resolveMapView({ map: null }, [{ latitude: null, longitude: null }])).toEqual({ view: null, source: 'none', located: 0 })

  // One room: its own point, at street scale.
  const one = resolveMapView(null, [{ latitude: 40.0176, longitude: -105.2797 }, { latitude: null, longitude: null }])
  expect(one.source).toBe('venues')
  expect(one.located).toBe(1)
  expect(one.view).toEqual({ center: [-105.2797, 40.0176], zoom: MAP_SINGLE_ZOOM })

  // Several rooms: the fitted bounds with a 15% skirt on every side.
  const many = resolveMapView(null, [
    { latitude: 40.0, longitude: -105.3 },
    { latitude: 40.1, longitude: -105.2 },
  ])
  expect(many.located).toBe(2)
  expect(many.view!.bounds).toEqual([
    [-105.315, 39.985],
    [-105.185, 40.115],
  ])
  expect(many.view!.center).toEqual([-105.25, 40.05])
  // A live map applies the bounds; the zoom is for previews that can only take a centre, and is
  // never further out than the floor.
  expect(many.view!.zoom).toBeGreaterThanOrEqual(MAP_MIN_ZOOM)
  // Coordinates as strings (a numeric column read without a cast) are still points.
  expect(resolveMapView(null, [{ latitude: '40.0', longitude: '-105.3' }, { latitude: '40.1', longitude: '-105.2' }]).located).toBe(2)

  // A room geocoded to the wrong continent must not open a centre-and-zoom preview on the whole
  // world: the zoom is floored at 12, while the bounds still tell a live map the truth.
  const stray = resolveMapView(null, [
    { latitude: 40.0176, longitude: -105.2797 },
    { latitude: 48.8584, longitude: 2.2945 },
  ])
  expect(stray.view!.zoom).toBe(MAP_MIN_ZOOM)
  expect(stray.view!.bounds![0][0]).toBeLessThan(-105)
  expect(stray.view!.bounds![1][0]).toBeGreaterThan(2)

  // Rooms at one address get a box, not a point, so the fit cannot divide by zero, and the zoom
  // stops at the ceiling instead of running to 25.
  const same = resolveMapView(null, [
    { latitude: 40.0176, longitude: -105.2797 },
    { latitude: 40.0176, longitude: -105.2797 },
  ])
  expect(same.view!.zoom).toBe(MAP_MAX_ZOOM)
  expect(same.view!.bounds![0][0]).toBeLessThan(-105.2797)
  expect(zoomForBounds([[-105.3, 40.0], [-105.2, 40.1]])).toBeGreaterThan(zoomForBounds([[-106, 39], [-104, 41]]))

  expect(mapViewLabel({ view: null, source: 'venues', located: 3 })).toBe('Auto (fits 3 rooms)')
  expect(mapViewLabel({ view: null, source: 'venues', located: 1 })).toBe('Auto (fits 1 room)')
  expect(mapViewLabel({ view: null, source: 'venues', located: 0 })).toBe('Auto (no rooms placed yet)')
})

test('an outline is a closed ring of at most 64 corners near the room’s pin', () => {
  const pin = { lat: 40.0176, lng: -105.2797 }
  const square = [
    [-105.2800, 40.0180],
    [-105.2790, 40.0180],
    [-105.2790, 40.0172],
    [-105.2800, 40.0172],
    [-105.2800, 40.0180],
  ]
  const ok = parseOutline({ type: 'Polygon', coordinates: [square] }, pin)
  expect(ok).toEqual({ type: 'Polygon', coordinates: [square] })
  expect(outlineRing(ok)).toHaveLength(5)
  expect(parseOutline(null, pin)).toBeNull()

  // An open ring is refused: the last corner has to repeat the first.
  expect(() => parseOutline({ type: 'Polygon', coordinates: [square.slice(0, 4)] }, pin)).toThrow(OutlineError)
  // So is anything that is not a single-ring polygon.
  expect(() => parseOutline({ type: 'LineString', coordinates: [square] }, pin)).toThrow(OutlineError)
  expect(() => parseOutline({ type: 'Polygon', coordinates: [square, square] }, pin)).toThrow(/one ring/)
  expect(() => parseOutline({ type: 'Polygon', coordinates: [[square[0], square[1], square[0]]] }, pin)).toThrow(/at least 3/)

  // More than 64 corners.
  const many: number[][] = []
  for (let i = 0; i < OUTLINE_MAX_VERTICES + 1; i++) {
    const angle = (i / (OUTLINE_MAX_VERTICES + 1)) * Math.PI * 2
    many.push([-105.2797 + Math.cos(angle) * 0.001, 40.0176 + Math.sin(angle) * 0.001])
  }
  many.push(many[0]!)
  expect(() => parseOutline({ type: 'Polygon', coordinates: [many] }, pin)).toThrow(/at most 64/)

  // A bounding box more than 50 km from the pin.
  const faraway = square.map(([lng, lat]) => [lng + 2, lat + 2])
  faraway[faraway.length - 1] = faraway[0]!
  expect(() => parseOutline({ type: 'Polygon', coordinates: [faraway] }, pin)).toThrow(/50 km/)

  // No pin at all: there is nothing to check the shape against.
  expect(() => parseOutline({ type: 'Polygon', coordinates: [square] }, null)).toThrow(/Place the room/)

  // Self-intersection is deliberately NOT checked: a bow-tie draws as a bow-tie and harms nobody.
  const bowtie = [
    [-105.2800, 40.0180],
    [-105.2790, 40.0172],
    [-105.2790, 40.0180],
    [-105.2800, 40.0172],
    [-105.2800, 40.0180],
  ]
  expect(parseOutline({ type: 'Polygon', coordinates: [bowtie] }, pin)).not.toBeNull()

  // A stored value that is not an outline reads as no outline, never as a throw.
  expect(outlineRing({ type: 'Polygon', coordinates: [] })).toBeNull()
  expect(outlineRing(null)).toBeNull()
})

test('a custom map is an app-hosted image, in one of exactly two modes', () => {
  const corners = [
    [-105.281, 40.019],
    [-105.278, 40.019],
    [-105.278, 40.016],
    [-105.281, 40.016],
  ]
  const georeferenced = parseCustomMap({ image: IMAGE, corners, opacity: 0.6, basemap: true })
  expect(georeferenced).toEqual({ image: IMAGE, corners, opacity: 0.6, basemap: true })
  expect(isImageOnly(georeferenced)).toBe(false)

  const imageOnly = parseCustomMap({ image: IMAGE, corners: null, basemap: false })
  expect(imageOnly).toEqual({ image: IMAGE, corners: null, opacity: 0.8, basemap: false })
  expect(isImageOnly(imageOnly)).toBe(true)
  expect(parseCustomMap(null)).toBeNull()

  // Only an image this app stored, and only a raster a map can draw.
  expect(() => parseCustomMap({ image: 'https://example.com/plan.png', corners, basemap: true })).toThrow(CustomMapError)
  expect(() => parseCustomMap({ image: '/uploads/../../etc/passwd', corners, basemap: true })).toThrow(CustomMapError)
  expect(() => parseCustomMap({ image: IMAGE.replace('.png', '.gif'), corners, basemap: true })).toThrow(CustomMapError)
  expect(() => parseCustomMap({ corners, basemap: true })).toThrow(/Upload a floor plan/)
  // The two modes cannot be mixed, and opacity is a fraction.
  expect(() => parseCustomMap({ image: IMAGE, corners: null, basemap: true })).toThrow(/four corners/)
  expect(() => parseCustomMap({ image: IMAGE, corners, basemap: false })).toThrow(/image-only/)
  expect(() => parseCustomMap({ image: IMAGE, corners: corners.slice(0, 3), basemap: true })).toThrow(/four corners/)
  expect(() => parseCustomMap({ image: IMAGE, corners, opacity: 2, basemap: true })).toThrow(/between 0 and 1/)
  expect(() => parseCustomMap({ image: IMAGE, corners: [[0, 0], [0, 0], [0, 0], [0, 0]], basemap: true })).toThrow(/enclose an area/)
})

test('an image-only map never publishes more than the gathering’s own ≈1 km cell', () => {
  const center = { lat: 40.0176, lng: -105.2797 }
  const extent = imageOnlyExtent(center, 2)
  // Four corners in MapLibre's image order (top-left first), on a box under a kilometre across.
  expect(extent.corners).toHaveLength(4)
  expect(extent.corners[0]![1]).toBeGreaterThan(extent.corners[3]![1])
  expect(extent.bounds[1][1] - extent.bounds[0][1]).toBeLessThan(0.01)
  expect(extent.bounds[1][0] - extent.bounds[0][0]).toBeLessThan(0.02)
  const imageOnly = parseCustomMap({ image: IMAGE, corners: null, basemap: false })
  // A pin dropped anywhere on the picture publishes the centre, not the pin.
  expect(coarseSessionPoint({ lat: extent.bounds[1][1], lng: extent.bounds[1][0] }, { customMap: imageOnly, gatheringCenter: center }))
    .toEqual(roundCoarse(center.lat, center.lng))
  // With a basemap the pin is a real place, so its own rounded point is published.
  expect(coarseSessionPoint({ lat: 40.041234, lng: -105.231456 }, { customMap: parseCustomMap({ image: IMAGE, corners: [[-105.281, 40.019], [-105.278, 40.019], [-105.278, 40.016], [-105.281, 40.016]], basemap: true }) }))
    .toEqual({ lat: 40.04, lng: -105.23 })
})

test('a room geocodes itself on save, and a hand-dropped pin is never overwritten', () => {
  const address = { address: '1500 Pearl St', locality: 'Boulder', region: 'CO', postal_code: '80302', country: 'US' }
  // A new room with an address and no pin.
  expect(shouldGeocodeOnSave({ ...address, latitude: null, geocoded_from: null })).toBe(true)
  // The address changed and the pin came from a lookup: look it up again.
  expect(shouldGeocodeOnSave({ ...address, latitude: 40.0176, geocoded_from: 'old address' }, { ...address, locality: 'Denver', latitude: 40.0176, geocoded_from: 'old address' })).toBe(true)
  // Nothing about the address changed: no lookup.
  expect(shouldGeocodeOnSave({ ...address, latitude: 40.0176, geocoded_from: 'x' }, { ...address, latitude: 40.0176, geocoded_from: 'x' })).toBe(false)
  // A pin placed by hand (no geocoded_from) is never replaced, however the address changes.
  expect(shouldGeocodeOnSave({ ...address, latitude: 40.0176, geocoded_from: null }, { ...address, locality: 'Denver', latitude: 40.0176, geocoded_from: null })).toBe(false)
  // No address at all: nothing to look up.
  expect(shouldGeocodeOnSave({ latitude: null, geocoded_from: null })).toBe(false)
})

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
  // Design §1: the address a room places itself from, and the one the editor's search offers
  // candidates for. Both are seeded into the cache, each under its own namespace.
  const SAVE_STREET = `12 Outline Way ${RUN}`
  const SAVE_QUERY = `${SAVE_STREET}, Boulder`
  const SAVE_POINT = { lat: 40.0221, lng: -105.2688 }
  const SEARCH_QUERY = `Chautauqua ${RUN}`
  const UI_STREET = `34 Canvas Ct ${RUN}`
  const UI_QUERY = `${UI_STREET}, Boulder`
  const UI_POINT = { lat: 40.0262, lng: -105.2735 }
  let outlineVenueId = ''

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
    // Geocode-on-save (design §1.1) and the address search (design §1.3) answer from the cache too.
    for (const [query, result] of [
      [SAVE_QUERY, { ...SAVE_POINT, label: `${SAVE_STREET}, Boulder, Colorado` }],
      [UI_QUERY, { ...UI_POINT, label: `${UI_STREET}, Boulder, Colorado` }],
      [SEARCH_QUERY, { lat: 39.9997, lng: -105.2811, label: `Chautauqua Park, Boulder` }],
    ] as const) {
      await sql`
        insert into geocode_cache (query_hash, result, fetched_at)
        values (${queryHash(query)}, ${sql.json(result as never)}, now())
        on conflict (query_hash) do update set result = excluded.result, fetched_at = now()
      `
    }
    // The candidate list lives under its own namespace, so it cannot overwrite the single answer.
    await sql`
      insert into geocode_cache (query_hash, result, fetched_at)
      values (${queryHash(SEARCH_QUERY, 'candidates:5|')}, ${sql.json([
        { lat: 39.9997, lng: -105.2811, label: 'Chautauqua Park, Boulder, Colorado' },
        { lat: 35.2226, lng: -80.8371, label: 'Chautauqua, Charlotte, North Carolina' },
        { lat: 42.2045, lng: -79.4695, label: 'Chautauqua, New York' },
      ] as never)}, now())
      on conflict (query_hash) do update set result = excluded.result, fetched_at = now()
    `
  })

  test.afterAll(async () => {
    if (!sql) return
    try {
      for (const q of [QUERY, SAVE_QUERY, UI_QUERY, SEARCH_QUERY]) await sql`delete from geocode_cache where query_hash = ${queryHash(q)}`
      await sql`delete from geocode_cache where query_hash = ${queryHash(SEARCH_QUERY, 'candidates:5|')}`
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

  test('map v2: a room places itself from its address, and a hand-dropped pin is left alone', async () => {
    const admin = `/api/v1/events/${gathering.slug}/admin/venues`
    // Nobody presses "Place": saving the address is what puts the room on the map (design §1.1).
    const created = await api(admin, {
      method: 'POST', cookie: owner.cookie,
      json: { name: `Outline Hall ${RUN}`, address: SAVE_STREET, locality: 'Boulder' },
    })
    expect(created.status, created.text).toBe(201)
    outlineVenueId = created.body.venue.id
    expect(created.body.venue.geocode_status).toBe('pending')
    expect(created.body.venue.latitude).toBeNull()

    const placed = await until('the background lookup to place the room', async () => {
      const [row] = await sql<{ latitude: number | null; status: string | null; geocoded_from: string | null }[]>`
        select latitude::float8 as latitude, geocode_status as status, geocoded_from from venues where id = ${outlineVenueId}
      `
      return row?.status === 'ok' ? row : null
    })
    expect(placed.latitude).toBeCloseTo(SAVE_POINT.lat, 6)
    expect(placed.geocoded_from).toBe(SAVE_QUERY)
    // The list the editor reads carries the status, so it can say "Located".
    const listed = await api(admin, { cookie: owner.cookie })
    expect(listed.body.venues.find((v: any) => v.id === outlineVenueId)).toMatchObject({ geocode_status: 'ok', outline: null })

    // A pin dropped by hand is `manual` and is never replaced, however the address changes.
    const byHand = await api(`${admin}/${outlineVenueId}`, {
      method: 'PATCH', cookie: owner.cookie, json: { latitude: 40.03, longitude: -105.27, geocoded_from: null },
    })
    expect(byHand.status, byHand.text).toBe(200)
    expect(byHand.body.venue.geocode_status).toBe('manual')
    const renamed = await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { locality: 'Longmont' } })
    expect(renamed.status, renamed.text).toBe(200)
    expect(renamed.body.venue.geocode_status).toBe('manual')
    await new Promise((r) => setTimeout(r, 1_500))
    const [still] = await sql<{ latitude: number; status: string | null }[]>`
      select latitude::float8 as latitude, geocode_status as status from venues where id = ${outlineVenueId}
    `
    expect(still!.latitude).toBe(40.03)
    expect(still!.status).toBe('manual')
    // Put it back where the outline below expects it.
    await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { locality: 'Boulder', latitude: SAVE_POINT.lat, longitude: SAVE_POINT.lng, geocoded_from: SAVE_QUERY } })
  })

  test('map v2: outlines are organizer-only, refused for a private residence, and never published', async () => {
    const admin = `/api/v1/events/${gathering.slug}/admin/venues`
    const ring = (dLng: number, dLat: number) => [
      [SAVE_POINT.lng - dLng, SAVE_POINT.lat + dLat],
      [SAVE_POINT.lng + dLng, SAVE_POINT.lat + dLat],
      [SAVE_POINT.lng + dLng, SAVE_POINT.lat - dLat],
      [SAVE_POINT.lng - dLng, SAVE_POINT.lat - dLat],
      [SAVE_POINT.lng - dLng, SAVE_POINT.lat + dLat],
    ]
    const outline = { type: 'Polygon', coordinates: [ring(0.0006, 0.0004)] }

    const saved = await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { outline } })
    expect(saved.status, saved.text).toBe(200)
    expect(saved.body.venue.outline).toEqual(outline)

    // A member is not an organizer.
    expect((await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: attendee.cookie, json: { outline } })).status).toBe(403)
    expect((await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', json: { outline } })).status).toBe(401)

    // A private residence's footprint is its address: 409, in either direction.
    const home = await api(`${admin}/${homeVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { outline } })
    expect(home.status, home.text).toBe(409)
    expect(home.body.code).toBe('PrivateResidenceOutline')
    const flip = await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { is_private_residence: true } })
    expect(flip.status, flip.text).toBe(409)
    const [homeRow] = await sql<{ outline: unknown }[]>`select outline from venues where id = ${homeVenueId}`
    expect(homeRow!.outline).toBeNull()

    // Whole-or-nothing, like the pin: a shape that breaks a rule changes nothing.
    const open = { type: 'Polygon', coordinates: [ring(0.0006, 0.0004).slice(0, 4)] }
    expect((await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { outline: open } })).status).toBe(400)
    const many: number[][] = []
    for (let i = 0; i < 65; i++) {
      const angle = (i / 65) * Math.PI * 2
      many.push([SAVE_POINT.lng + Math.cos(angle) * 0.0008, SAVE_POINT.lat + Math.sin(angle) * 0.0008])
    }
    many.push(many[0]!)
    expect((await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { outline: { type: 'Polygon', coordinates: [many] } } })).status).toBe(400)
    const far = ring(0.0006, 0.0004).map(([lng, lat]) => [lng + 3, lat + 3])
    far[far.length - 1] = far[0]!
    expect((await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { outline: { type: 'Polygon', coordinates: [far] } } })).status).toBe(400)
    const [unchanged] = await sql<{ outline: { coordinates: number[][][] } }[]>`select outline from venues where id = ${outlineVenueId}`
    expect(unchanged!.outline.coordinates[0]).toHaveLength(5)

    // Members see it on the gathering map; strangers and anonymous readers do not.
    const asOwner = await api(`/api/v1/events/${gathering.slug}/map`, { cookie: owner.cookie })
    expect(asOwner.status, asOwner.text).toBe(200)
    expect(asOwner.body.outlines.map((o: any) => o.venue_id)).toContain(outlineVenueId)
    expect(asOwner.body.view).toBeTruthy()
    const asStranger = await api(`/api/v1/events/${gathering.slug}/map`, { cookie: stranger.cookie })
    expect(asStranger.status).toBe(200)
    expect(asStranger.body.outlines).toEqual([])
    expect((await api(`/api/v1/events/${gathering.slug}/map`)).body.outlines).toEqual([])
    // A private gathering's map is 404 to a stranger, like every other read.
    expect((await api(`/api/v1/events/${privateGathering.slug}/map`, { cookie: stranger.cookie })).status).toBe(404)

    // App-side only: the venue record the gathering just rewrote carries no ring.
    const [venueRow] = await sql<{ at_uri: string | null }[]>`select at_uri from venues where id = ${outlineVenueId}`
    if (venueRow?.at_uri) {
      const record = await getRecord(venueRow.at_uri)
      expect(JSON.stringify(record?.value ?? {})).not.toContain('Polygon')
    }
    const records = await sql<{ record: unknown }[]>`select record from at_records where did = (select actor_did from events where id = ${gathering.id})`
    expect(JSON.stringify(records)).not.toContain('Polygon')
    expect(JSON.stringify(records)).not.toContain(`${SAVE_POINT.lng - 0.0006},${SAVE_POINT.lat + 0.0004}`)

    // Removing the pin removes the shape that was anchored to it.
    const unpinned = await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { latitude: null, longitude: null } })
    expect(unpinned.status, unpinned.text).toBe(200)
    expect(unpinned.body.venue.outline).toBeNull()
    await api(`${admin}/${outlineVenueId}`, { method: 'PATCH', cookie: owner.cookie, json: { latitude: SAVE_POINT.lat, longitude: SAVE_POINT.lng, geocoded_from: SAVE_QUERY, outline } })
  })

  test('map v2: the custom map is owner-only, app-hosted, and refused when every room is a home', async () => {
    const path = `/api/v1/events/${gathering.slug}/admin/custom-map`
    const image = `/uploads/ab/${'a'.repeat(64)}.png`
    // Six decimals, the way the route stores them, so the round trip compares exactly.
    const at = (lng: number, lat: number) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]
    const corners = [
      at(SAVE_POINT.lng - 0.002, SAVE_POINT.lat + 0.002),
      at(SAVE_POINT.lng + 0.002, SAVE_POINT.lat + 0.002),
      at(SAVE_POINT.lng + 0.002, SAVE_POINT.lat - 0.002),
      at(SAVE_POINT.lng - 0.002, SAVE_POINT.lat - 0.002),
    ]
    expect((await api(path)).status).toBe(401)
    expect((await api(path, { cookie: stranger.cookie })).status).toBe(403)
    expect((await api(path, { cookie: attendee.cookie })).status).toBe(403)
    expect((await api(path, { method: 'PUT', cookie: attendee.cookie, json: { custom_map: { image, corners } } })).status).toBe(403)
    const cross = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { cookie: owner.cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: JSON.stringify({ custom_map: { image, corners } }),
    })
    expect(cross.status).toBe(403)

    const empty = await api(path, { cookie: owner.cookie })
    expect(empty.status, empty.text).toBe(200)
    expect(empty.body).toMatchObject({ custom_map: null, can_upload: true, image_max_bytes: 8 * 1024 * 1024 })

    // Only an image this app stored, and only a raster the map can draw.
    expect((await api(path, { method: 'PUT', cookie: owner.cookie, json: { custom_map: { image: 'https://evil.example/plan.png', corners } } })).status).toBe(400)
    expect((await api(path, { method: 'PUT', cookie: owner.cookie, json: { custom_map: { image: image.replace('.png', '.gif'), corners } } })).status).toBe(400)
    expect((await api(path, { method: 'PUT', cookie: owner.cookie, json: { custom_map: { image, corners: null, basemap: true } } })).status).toBe(400)
    expect((await api(path, { method: 'PUT', cookie: owner.cookie, json: { custom_map: { image, corners, opacity: 4 } } })).status).toBe(400)

    const saved = await api(path, { method: 'PUT', cookie: owner.cookie, json: { custom_map: { image, corners, opacity: 0.55, basemap: true } } })
    expect(saved.status, saved.text).toBe(200)
    expect(saved.body.custom_map).toEqual({ image, corners, opacity: 0.55, basemap: true })
    // Members see it on their map; strangers do not, and no record ever carries it.
    expect((await api(`/api/v1/events/${gathering.slug}/map`, { cookie: attendee.cookie })).body.custom_map).toMatchObject({ image })
    expect((await api(`/api/v1/events/${gathering.slug}/map`, { cookie: stranger.cookie })).body.custom_map).toBeNull()
    const records = await sql<{ record: unknown }[]>`select record from at_records where did = (select actor_did from events where id = ${gathering.id})`
    expect(JSON.stringify(records)).not.toContain(image)

    // Image-only mode: no corners, no basemap.
    const imageOnly = await api(path, { method: 'PUT', cookie: owner.cookie, json: { custom_map: { image, corners: null, basemap: false } } })
    expect(imageOnly.status, imageOnly.text).toBe(200)
    expect(imageOnly.body.custom_map).toEqual({ image, corners: null, opacity: 0.8, basemap: false })

    expect((await api(path, { method: 'DELETE', cookie: owner.cookie })).body.custom_map).toBeNull()
    const [row] = await sql<{ custom_map: unknown }[]>`select custom_map from events where id = ${gathering.id}`
    expect(row!.custom_map).toBeNull()

    // A gathering whose every room is a private residence has no map to put a floor plan on.
    await sql`update venues set outline = null, is_private_residence = true where event_id = ${privateGathering.id}`
    const blocked = await api(`/api/v1/events/${privateGathering.slug}/admin/custom-map`, {
      method: 'PUT', cookie: owner.cookie, json: { custom_map: { image, corners, basemap: true } },
    })
    expect(blocked.status, blocked.text).toBe(409)
    expect(blocked.body.code).toBe('PrivateResidencesOnly')
    expect((await api(`/api/v1/events/${privateGathering.slug}/admin/custom-map`, { cookie: owner.cookie })).body.can_upload).toBe(false)
    await sql`update venues set is_private_residence = false where event_id = ${privateGathering.id}`
  })

  test('map v2: the address search answers up to five candidates from its own cache namespace', async () => {
    const path = `/api/v1/events/${gathering.slug}/admin/geocode`
    const many = await api(path, { method: 'POST', cookie: owner.cookie, json: { query: SEARCH_QUERY, limit: 5 } })
    expect(many.status, many.text).toBe(200)
    expect(many.body.cached).toBe(true)
    expect(many.body.results).toHaveLength(3)
    expect(many.body.results[0]).toEqual({ lat: 39.9997, lng: -105.2811, label: 'Chautauqua Park, Boulder, Colorado' })
    expect(many.body.result).toEqual(many.body.results[0])

    // The single-result entry for the same query is untouched: two rows, two shapes.
    const one = await api(path, { method: 'POST', cookie: owner.cookie, json: { query: SEARCH_QUERY } })
    expect(one.status, one.text).toBe(200)
    expect(one.body).toEqual({ result: { lat: 39.9997, lng: -105.2811, label: 'Chautauqua Park, Boulder' }, cached: true })
    const [single] = await sql<{ result: unknown }[]>`select result from geocode_cache where query_hash = ${queryHash(SEARCH_QUERY)}`
    expect(Array.isArray(single!.result)).toBe(false)
    const [list] = await sql<{ result: unknown }[]>`select result from geocode_cache where query_hash = ${queryHash(SEARCH_QUERY, 'candidates:5|')}`
    expect(Array.isArray(list!.result)).toBe(true)

    // A budget and a ceiling, like every other lookup.
    expect((await api(path, { method: 'POST', cookie: owner.cookie, json: { query: SEARCH_QUERY, limit: 6 } })).status).toBe(400)
    expect((await api(path, { method: 'POST', cookie: owner.cookie, json: { query: SEARCH_QUERY, limit: 0 } })).status).toBe(400)
    expect((await api(path, { method: 'POST', cookie: stranger.cookie, json: { query: SEARCH_QUERY, limit: 5 } })).status).toBe(403)
  })

  test('map v2 in the browser: an address places the room by itself, and a drawn outline reaches the member map', async () => {
    test.setTimeout(180_000)
    // Playwright's headless shell has no WebGL2, so MapLibre would fall back to the list and there
    // would be no canvas to draw on; SwiftShader gives the real map (same flags as the screenshots).
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
    const roomName = `Canvas Room ${RUN}`
    try {
      const [name, value] = owner.cookie.split('=', 2)
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
      await context.addCookies([{ name: name!, value: value!, domain: 'localhost', path: '/' }])
      const page = await context.newPage()
      await page.goto(`${base}/e/${gathering.slug}/admin/setup`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const canvas = page.locator('[data-testid="venue-map"] canvas.maplibregl-canvas')
      await page.locator('#venue-map').scrollIntoViewIfNeeded().catch(() => undefined)
      const hasCanvas = await canvas.first().waitFor({ timeout: 30_000 }).then(() => true).catch(() => false)
      test.skip(!hasCanvas, 'this browser has no WebGL, so there is no map canvas to draw on')

      // Add a room with an address. Nobody presses "Place": the save geocodes it.
      await page.getByRole('button', { name: 'Add room' }).first().click()
      await page.locator('#venue-name').fill(roomName)
      await page.locator('#venue-address').fill(UI_STREET)
      await page.locator('#venue-locality').fill('Boulder')
      await page.getByRole('button', { name: 'Add room' }).last().click()

      const row = page.locator('li', { hasText: roomName }).first()
      await expect(row).toBeVisible({ timeout: 20_000 })
      // The card polls while the lookup is in flight: "Locating…" becomes "Located".
      await expect(row).toContainText('Located', { timeout: 60_000 })
      const [placed] = await sql<{ id: string; latitude: number | null }[]>`
        select id, latitude::float8 as latitude from venues where event_id = ${gathering.id} and name = ${roomName}
      `
      expect(placed!.latitude).toBeCloseTo(UI_POINT.lat, 6)
      // A pin for it is on the map without anyone having placed it.
      await expect(page.locator('[data-testid="venue-map"] .sp-map-pin')).not.toHaveCount(0)

      // Draw a three-corner outline on it.
      await row.getByRole('button', { name: 'Show' }).click()
      await page.waitForTimeout(2_000)
      await row.getByRole('button', { name: 'Outline' }).click()
      await expect(page.locator('[data-testid="outline-tool"]')).toBeVisible()
      const box = await canvas.first().boundingBox()
      expect(box).not.toBeNull()
      const cx = box!.x + box!.width / 2
      const cy = box!.y + box!.height / 2
      for (const [dx, dy] of [[-90, -70], [90, -70], [0, 80]]) {
        await page.mouse.click(cx + dx, cy + dy)
        await page.waitForTimeout(250)
      }
      await expect(page.locator('[data-testid="outline-tool"]')).toContainText('3 of at most 64 corners')
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.locator('[data-testid="outline-tool"]')).toHaveCount(0, { timeout: 20_000 })

      const stored = await until('the outline to be stored', async () => {
        const [r] = await sql<{ outline: { coordinates: number[][][] } | null }[]>`
          select outline from venues where id = ${placed!.id}
        `
        return r?.outline ?? null
      })
      // Three corners plus the repeat that closes the ring.
      expect(stored.coordinates[0]).toHaveLength(4)

      // Members see it on the gathering map, named, and clicking it behaves like a pin.
      const memberPage = await context.newPage()
      await memberPage.goto(`${base}/e/${gathering.slug}/map`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await memberPage.locator('[data-testid="gathering-map"] canvas.maplibregl-canvas').first().waitFor({ timeout: 30_000 }).catch(() => undefined)
      await expect(memberPage.locator('.sp-map-shape-label', { hasText: roomName })).toBeVisible({ timeout: 30_000 })
      await context.close()
    } finally {
      await browser.close()
      await sql`delete from venues where event_id = ${gathering.id} and name = ${roomName}`
    }
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
