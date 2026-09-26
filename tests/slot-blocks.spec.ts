import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, TEST_BASE_URL, type TestAccount, type TestGathering } from './helpers/gathering'
import {
  applyTemplate,
  checkTemplates,
  conflictKeys,
  copyDayRooms,
  countSlots,
  generateSlots,
  newPlan,
  newRoomPattern,
  planToTemplate,
  slotsForRoom,
  syncRooms,
  type DayPlan,
  type RoomPattern,
} from '../src/lib/scheduling/slot-blocks'

/**
 * Bulk session blocks (design 2026-09-25 §4).
 *
 *  - the pure pattern → slots walker: uniform, per-room, closed days, breaks, copy-from-day,
 *    lockstep rows and the template round trip;
 *  - the slot-templates route: same-origin, `manageVenues`, shape and size validation, and the
 *    list filtered by the resolved gathering;
 *  - the editor end to end: 6 slots × 3 rooms × 2 days with one room closed on the second day,
 *    saved in one POST, with no overlapping availability left behind.
 *
 * Everything runs against a gathering and accounts created here and removed in afterAll; no
 * seeded gathering is read or written.
 */
loadEnvConfig(process.cwd(), true)

const base = TEST_BASE_URL
const databaseUrl = process.env.DATABASE_URL || ''
const ownerUrl = process.env.DATABASE_MIGRATION_URL || databaseUrl
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

/* ───────────────────────── the pattern, as pure functions ───────────────────────── */

const room = (venueId: string, over: Partial<RoomPattern> = {}): RoomPattern => ({ ...newRoomPattern(venueId), ...over })

test('one pattern across every room and day is the uniform grid, unchanged', () => {
  const days = ['2026-05-01', '2026-05-02']
  const plan: DayPlan[] = days.map((dayDate) => ({
    dayDate,
    rooms: ['a', 'b', 'c'].map((v, i) => room(v, { end: '15:00', sameAsFirst: i > 0 })),
  }))
  const slots = generateSlots(plan)
  // 09:00–15:00 in hour slots = 6 per room per day.
  expect(countSlots(slots)).toEqual({ sessions: 36, breaks: 0, total: 36 })
  expect(slots.filter((s) => s.venueId === 'a' && s.dayDate === '2026-05-01').map((s) => `${s.startTime}-${s.endTime}`)).toEqual([
    '09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00', '13:00-14:00', '14:00-15:00',
  ])
  // Every room and day carries exactly the same wall-clock pattern.
  const pattern = (venueId: string, dayDate: string) =>
    slots.filter((s) => s.venueId === venueId && s.dayDate === dayDate).map((s) => s.startTime)
  for (const v of ['a', 'b', 'c']) for (const d of days) expect(pattern(v, d)).toEqual(pattern('a', days[0]))
})

test('a room keeps its own hours, and a closed room produces nothing', () => {
  const plan: DayPlan[] = [{
    dayDate: '2026-05-01',
    rooms: [
      room('a', { end: '12:00' }),                                       // 3 hour slots
      room('b', { start: '13:00', end: '16:30', slotMinutes: 90, sameAsFirst: false }), // 2 slots, 15 min spare
      room('c', { closed: true, sameAsFirst: false }),
    ],
  }]
  const slots = generateSlots(plan)
  expect(slots.filter((s) => s.venueId === 'a').length).toBe(3)
  expect(slots.filter((s) => s.venueId === 'b').map((s) => s.startTime)).toEqual(['13:00', '14:30'])
  expect(slots.filter((s) => s.venueId === 'c')).toEqual([])
  // A room whose day ends before it starts is a no-op, not a negative walk.
  expect(slotsForRoom(room('d', { start: '16:00', end: '09:00' }), '2026-05-01')).toEqual([])
})

test('breaks sit between slots and never end the day', () => {
  // 09:00–12:00, 45-minute slots, 15-minute breaks: 45+15+45+15+45 = 2h45, then 15 min spare.
  const slots = slotsForRoom(room('a', { end: '12:00', slotMinutes: 45, breakMinutes: 15 }), '2026-05-01')
  expect(slots.map((s) => `${s.startTime}-${s.endTime}${s.isBreak ? ' break' : ''}`)).toEqual([
    '09:00-09:45', '09:45-10:00 break', '10:00-10:45', '10:45-11:00 break', '11:00-11:45',
  ])
  expect(slots.at(-1)!.isBreak).toBe(false)
  expect(countSlots(slots)).toEqual({ sessions: 3, breaks: 2, total: 5 })
  // No room for a second slot: one slot, no break.
  expect(slotsForRoom(room('a', { end: '10:00', slotMinutes: 45, breakMinutes: 15 }), '2026-05-01').length).toBe(1)
})

test('"same as first room" pulls a row back into lockstep, but never its closed flag', () => {
  const rows = syncRooms([
    room('a', { start: '08:00', end: '12:00', slotMinutes: 30, breakMinutes: 10 }),
    room('b', { start: '13:00', end: '14:00', slotMinutes: 120, sameAsFirst: true, closed: true }),
    room('c', { start: '13:00', end: '14:00', slotMinutes: 120, sameAsFirst: false }),
  ])
  expect(rows[1]).toMatchObject({ start: '08:00', end: '12:00', slotMinutes: 30, breakMinutes: 10, closed: true })
  expect(rows[2]).toMatchObject({ start: '13:00', end: '14:00', slotMinutes: 120 })
})

test('copy from another day carries its hours and its closures, room by room', () => {
  const from = [room('a', { end: '13:00' }), room('b', { closed: true, sameAsFirst: false })]
  const to = newPlan(['2026-05-02'], ['a', 'b'])[0].rooms
  const copied = copyDayRooms(from, to)
  expect(copied[0]).toMatchObject({ venueId: 'a', end: '13:00', closed: false })
  expect(copied[1]).toMatchObject({ venueId: 'b', closed: true })
  // The room a day has and the template does not repeats the last pattern rather than vanishing.
  expect(copyDayRooms(from, newPlan(['2026-05-02'], ['a', 'b', 'c'])[0].rooms)[2]).toMatchObject({ venueId: 'c', closed: true })
})

test('conflicts are the generated slots that overlap availability already in the grid', () => {
  const slots = generateSlots([{ dayDate: '2026-05-01', rooms: [room('a', { end: '12:00' })] }])
  const clashes = conflictKeys(slots, [{ venueId: 'a', dayDate: '2026-05-01', startTime: '10:30', endTime: '10:45' }])
  expect([...clashes]).toEqual(['a|2026-05-01|10:00'])
  // Another room, another day, or a slot that merely touches the edge is not a conflict.
  expect(conflictKeys(slots, [{ venueId: 'b', dayDate: '2026-05-01', startTime: '10:30', endTime: '10:45' }]).size).toBe(0)
  expect(conflictKeys(slots, [{ venueId: 'a', dayDate: '2026-05-02', startTime: '10:30', endTime: '10:45' }]).size).toBe(0)
  expect(conflictKeys(slots, [{ venueId: 'a', dayDate: '2026-05-01', startTime: '12:00', endTime: '13:00' }]).size).toBe(0)
})

test('a template saves the shape and applies it to another gathering rooms and days', () => {
  const plan: DayPlan[] = [
    { dayDate: '2026-05-01', rooms: syncRooms([room('v1', { end: '13:00' }), room('v2', { closed: true, sameAsFirst: true })]) },
    { dayDate: '2026-05-02', rooms: syncRooms([room('v1', { end: '17:00' }), room('v2', { sameAsFirst: true })]) },
  ]
  const names: Record<string, string> = { v1: 'Main Hall', v2: 'Garden' }
  const template = planToTemplate('  Weekday shape  ', plan, (id) => names[id] ?? null)
  expect(template.name).toBe('Weekday shape')
  expect(template.days).toHaveLength(2)
  expect(template.days[0].rooms[1]).toMatchObject({ room: 'Garden', end: '13:00', closed: true })

  // A different gathering: different ids, a room in between, one day more than the template.
  const applied = applyTemplate(template, ['2026-09-01', '2026-09-02', '2026-09-03'], [
    { id: 'n1', name: 'Main Hall' }, { id: 'n9', name: 'Annex' }, { id: 'n2', name: 'Garden' },
  ])
  expect(applied.map((d) => d.dayDate)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
  expect(applied[0].rooms[0]).toMatchObject({ venueId: 'n1', end: '13:00', closed: false })
  // The Garden is matched by name wherever it now sits; the room the template never saw takes
  // the pattern at its own position rather than nothing at all.
  expect(applied[0].rooms[2]).toMatchObject({ venueId: 'n2', end: '13:00', closed: true })
  expect(applied[0].rooms[1]).toMatchObject({ venueId: 'n9', end: '13:00' })
  // A day past the template repeats its last day.
  expect(applied[2].rooms[0].end).toBe('17:00')
  // Lockstep is derived from the hours, so the editor opens with the rows it had.
  expect(applied[0].rooms.map((r) => r.sameAsFirst)).toEqual([false, true, true])
  expect(generateSlots([applied[0]]).filter((s) => s.venueId === 'n2')).toEqual([])
})

test('the templates validator keeps anything that is not a named list of days out', () => {
  const good = [{ name: 'Shape', days: [{ rooms: [{ room: 'Main Hall', start: '09:00', end: '17:00', slotMinutes: 60, breakMinutes: 15, closed: false }] }] }]
  const checked = checkTemplates(good)
  expect(checked.ok && checked.templates[0].name).toBe('Shape')
  // Unknown keys are dropped rather than stored.
  const extra = checkTemplates([{ name: 'Shape', note: 'hi', days: [{ rooms: [{ start: '09:00', end: '17:00', slotMinutes: 60, sneak: 1 }] }] }])
  expect(extra.ok && Object.keys(extra.templates[0])).toEqual(['name', 'days'])
  expect(extra.ok && Object.keys(extra.templates[0].days[0].rooms[0]).sort()).toEqual(['breakMinutes', 'closed', 'end', 'room', 'slotMinutes', 'start'])

  for (const bad of [
    'nope',
    {},
    [{ days: [{ rooms: [] }] }],                                              // no name
    [{ name: '   ', days: [{ rooms: [] }] }],
    [{ name: 'x'.repeat(61), days: [{ rooms: [] }] }],
    [{ name: 'a', days: [] }],                                                // no days
    [{ name: 'a', days: [{ rooms: [{ start: '9:00', end: '17:00', slotMinutes: 60 }] }] }],   // not HH:MM
    [{ name: 'a', days: [{ rooms: [{ start: '09:00', end: '17:00', slotMinutes: 0 }] }] }],   // too short
    [{ name: 'a', days: [{ rooms: [{ start: '09:00', end: '17:00', slotMinutes: 60, breakMinutes: 999 }] }] }],
    [{ name: 'a', days: [{ rooms: [{ start: '09:00', end: '17:00', slotMinutes: 60 }] }] }, { name: 'A', days: [{ rooms: [] }] }], // same name twice
    Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, days: [{ rooms: [] }] })),
  ]) {
    expect(checkTemplates(bad).ok, JSON.stringify(bad).slice(0, 60)).toBe(false)
  }
})

/* ───────────────────────── the route and the editor ───────────────────────── */

test.describe('slot templates and the bulk block editor', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let owner: TestAccount
  let moderator: TestAccount
  let outsider: TestAccount
  let venueIds: string[] = []

  const url = (slug: string) => `/api/v1/events/${slug}/admin/slot-templates`
  const TEMPLATE = {
    name: 'Weekday shape',
    days: [{ rooms: [{ room: 'Main Hall', start: '09:00', end: '15:00', slotMinutes: 60, breakMinutes: 0, closed: false }] }],
  }

  async function api(path: string, init: { method?: string; cookie?: string; json?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = {}
    if (init.origin !== null) headers.origin = init.origin ?? base
    if (init.cookie) headers.cookie = init.cookie
    if (init.json !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    })
    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: res.status, body: (body ?? {}) as Record<string, unknown> }
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    raw = postgres(ownerUrl, { max: 4, onnotice: () => {} })
    // Rooms but no availability: the editor's whole job is the empty grid.
    gathering = await createTestGathering(raw, { tag: 'blocks', status: 'scheduling' })
    const venues = await raw<{ id: string }[]>`
      insert into venues (event_id, name, slug, capacity, is_primary)
      values (${gathering.id}, 'Main Hall', 'main-hall', 120, true),
             (${gathering.id}, 'Workshop Room', 'workshop-room', 30, false),
             (${gathering.id}, 'Garden', 'garden', 40, false)
      returning id
    `
    venueIds = venues.map((v) => v.id)
    owner = await createTestAccount('blocks-owner', { sql: raw })
    moderator = await createTestAccount('blocks-mod', { sql: raw })
    outsider = await createTestAccount('blocks-out', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${owner.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${moderator.id}, 'moderator')
              on conflict (event_id, user_id) do update set role = 'moderator'`
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await owner?.cleanup()
    await moderator?.cleanup()
    await outsider?.cleanup()
    await raw?.end({ timeout: 5 })
  })

  test('slot-templates answers only an organizer who manages rooms, and only same-origin', async () => {
    expect((await api(url(gathering.slug))).status).toBe(401)
    // A member without `manageVenues` (moderator) is refused; a non-member never learns the slug exists.
    expect((await api(url(gathering.slug), { cookie: moderator.cookie })).status).toBe(403)
    expect((await api(url(gathering.slug), { cookie: outsider.cookie })).status).toBe(403)
    expect((await api(url('no-such-gathering-xyz'), { cookie: owner.cookie })).status).toBe(404)

    const empty = await api(url(gathering.slug), { cookie: owner.cookie })
    expect(empty.status).toBe(200)
    expect(empty.body.templates).toEqual([])

    // Cross-origin writes are refused before the role is even consulted.
    const cross = await api(url(gathering.slug), { method: 'PUT', cookie: owner.cookie, origin: 'https://evil.example', json: { templates: [TEMPLATE] } })
    expect(cross.status).toBe(403)
    const noRole = await api(url(gathering.slug), { method: 'PUT', cookie: moderator.cookie, json: { templates: [TEMPLATE] } })
    expect(noRole.status).toBe(403)
    expect((await api(url(gathering.slug), { cookie: owner.cookie })).body.templates).toEqual([])
  })

  test('PUT validates the shape and the size, then replaces the whole list', async () => {
    for (const templates of [
      'nope',
      [{ days: [{ rooms: [] }] }],
      [{ name: 'x'.repeat(61), days: [{ rooms: [] }] }],
      [{ name: 'a', days: [] }],
      [{ name: 'a', days: [{ rooms: [{ start: '9am', end: '5pm', slotMinutes: 60 }] }] }],
      [{ name: 'a', days: [{ rooms: [{ start: '09:00', end: '17:00', slotMinutes: 1000 }] }] }],
      Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, days: [{ rooms: [] }] })),
    ]) {
      const res = await api(url(gathering.slug), { method: 'PUT', cookie: owner.cookie, json: { templates } })
      expect(res.status, JSON.stringify(templates).slice(0, 50)).toBe(400)
      expect(res.body.field).toBe('templates')
    }

    const saved = await api(url(gathering.slug), { method: 'PUT', cookie: owner.cookie, json: { templates: [TEMPLATE, { ...TEMPLATE, name: 'Weekend shape' }] } })
    expect(saved.status).toBe(200)
    expect((saved.body.templates as { name: string }[]).map((t) => t.name)).toEqual(['Weekday shape', 'Weekend shape'])
    // Stored on this gathering only, and read back as it was written.
    const [row] = await raw<{ slot_templates: unknown[] }[]>`select slot_templates from events where id = ${gathering.id}`
    expect(row.slot_templates).toHaveLength(2)

    // PUT is the whole list: one entry replaces both.
    const replaced = await api(url(gathering.slug), { method: 'PUT', cookie: owner.cookie, json: { templates: [TEMPLATE] } })
    expect((replaced.body.templates as { name: string }[]).map((t) => t.name)).toEqual(['Weekday shape'])
  })

  test('a clone of the gathering carries its templates', async () => {
    const cloneSlug = `t-blk-${Math.random().toString(36).slice(2, 8)}`
    const res = await api(`/api/v1/events/${gathering.slug}/admin/clone`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { name: 'Cloned blocks', slug: cloneSlug, startDate: '2027-04-05' },
    })
    expect(res.status).toBe(201)
    try {
      const [row] = await raw<{ slot_templates: { name: string }[] }[]>`select slot_templates from events where slug = ${cloneSlug}`
      expect(row.slot_templates.map((t) => t.name)).toEqual(['Weekday shape'])
    } finally {
      const [clone] = await raw<{ id: string }[]>`select id from events where slug = ${cloneSlug}`
      if (clone) await raw`delete from events where id = ${clone.id}`
    }
  })

  test('the editor generates 6 slots × 3 rooms × 2 days, one room closed on the second day', async ({ browser }) => {
    const [name, ...rest] = owner.cookie.split('=')
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1400, height: 1000 } })
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    try {
      await page.goto(`/e/${gathering.slug}/admin/setup`)
      await page.getByRole('button', { name: 'Generate slots' }).first().click()
      const editor = page.getByTestId('slot-block-editor')
      await expect(editor).toBeVisible()

      // One pattern, every room in lockstep, both days: 09:00–15:00 in hour slots.
      const rows = editor.getByTestId('slot-room-row')
      await expect(rows).toHaveCount(3)
      await rows.nth(0).getByLabel('End').fill('15:00')
      await expect(editor.getByTestId('slot-total')).toContainText('36 slots in total')

      // Then the second day on its own, with one room shut.
      await editor.getByRole('switch', { name: 'Same times every day' }).click()
      await editor.getByTestId('slot-day-tab').nth(1).click()
      const closedRow = editor.getByTestId('slot-room-row').nth(2)
      const closedVenueId = await closedRow.getAttribute('data-venue-id')
      await closedRow.getByRole('switch').click()
      await expect(closedRow).toContainText('Closed')
      await expect(editor.getByTestId('slot-total')).toContainText('30 slots in total')

      await page.getByRole('button', { name: 'Add 30 slots' }).click()
      await expect(page.getByTestId('slot-block-editor')).toBeHidden()

      // What landed: 30 slots, none overlapping, and the closed room short by a day.
      const [counted] = await raw<{ n: number }[]>`select count(*)::int as n from time_slots where event_id = ${gathering.id}`
      expect(counted.n).toBe(30)
      const [overlaps] = await raw<{ n: number }[]>`
        select count(*)::int as n
        from time_slots a join time_slots b
          on a.event_id = b.event_id and a.venue_id = b.venue_id and a.id <> b.id
         and a.start_time < b.end_time and b.start_time < a.end_time
        where a.event_id = ${gathering.id}
      `
      expect(overlaps.n).toBe(0)
      const byVenue = await raw<{ venue_id: string; n: number }[]>`
        select venue_id, count(*)::int as n from time_slots where event_id = ${gathering.id} group by venue_id
      `
      expect(byVenue.find((r) => r.venue_id === closedVenueId)!.n).toBe(6)
      for (const r of byVenue.filter((r) => r.venue_id !== closedVenueId)) expect(r.n).toBe(12)
      expect(venueIds).toContain(closedVenueId)
      const days = await raw<{ day_date: string; n: number }[]>`
        select day_date::text as day_date, count(*)::int as n from time_slots where event_id = ${gathering.id} group by day_date order by day_date
      `
      expect(days.map((d) => d.n)).toEqual([18, 12])

      // Re-opened over a full grid, every proposed slot conflicts and saving is blocked.
      await page.getByRole('button', { name: 'Generate slots' }).first().click()
      const again = page.getByTestId('slot-block-editor')
      await expect(again).toContainText(/overlap availability this gathering already has/)
      await expect(again.getByRole('button', { name: /^Add \d+ slots$/ })).toBeDisabled()
    } finally {
      await raw`delete from time_slots where event_id = ${gathering.id}`
      await context.close()
    }
  })

  test('the schedule builder adds a row of slots at a time across every room', async ({ browser }) => {
    const [name, ...rest] = owner.cookie.split('=')
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1400, height: 1000 } })
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    try {
      await page.goto(`/e/${gathering.slug}/admin/schedule`)
      await expect(page.getByRole('heading', { name: 'Schedule builder' })).toBeVisible()
      await page.getByRole('button', { name: 'More actions' }).click()
      await page.getByRole('menuitem', { name: /Add a row of slots/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Start').fill('16:00')
      await dialog.getByRole('button', { name: /^Add 3 slots$/ }).click()
      await expect(dialog).toBeHidden()

      const rows = await raw<{ venue_id: string }[]>`select venue_id from time_slots where event_id = ${gathering.id}`
      expect(rows).toHaveLength(3)
      expect(new Set(rows.map((r) => r.venue_id))).toEqual(new Set(venueIds))
    } finally {
      await raw`delete from time_slots where event_id = ${gathering.id}`
      await context.close()
    }
  })
})
