import { test, expect, type APIRequestContext } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

// Schedule builder UX for cluster-aware scheduling (release design §9.3): the organizer's
// "pin to room" route, the structured conflicts the live quality check maps onto grid cells,
// and a smoke render of the builder with its audience-clusters panel. Everything runs against
// a gathering, accounts and a closed round created here and removed in afterAll.
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

test.describe('schedule builder: pins, live quality, clusters panel', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let organizer: TestAccount
  let outsider: TestAccount
  let foreign: TestGathering
  const S: Record<'s1' | 's2' | 's3', string> = { s1: '', s2: '', s3: '' }
  const TOKENS = Array.from({ length: 8 }, () => randomBytes(32).toString('hex'))
  let rowA: { main: string; workshop: string }
  let rowB: { main: string }

  const api = (request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, cookie?: string, data?: unknown) =>
    request.fetch(`${base}${url}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: base }) },
      ...(data !== undefined ? { data } : {}),
    })

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'schui', status: 'scheduling', withProgram: true, policyThresholds: { feedbackK: 3 } })
    foreign = await createTestGathering(raw, { tag: 'schuix', status: 'scheduling', withProgram: true })
    organizer = await createTestAccount('schui-org', { sql: raw })
    outsider = await createTestAccount('schui-out', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizer.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`

    for (const key of ['s1', 's2', 's3'] as const) {
      const [row] = await raw<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, host_id, status, is_votable)
        values (${gathering.id}, ${`schui ${key} ${gathering.slug}`}, 'talk', 60, ${organizer.id}, 'approved', true)
        returning id
      `
      S[key] = row.id
    }

    // A finalized round with hand-made tokens: s1 and s2 share every voter, s3 is disjoint.
    const [round] = await raw<{ id: string }[]>`
      insert into vote_rounds (event_id, mechanism, credits, opens_at, closes_at, ballot_key, finalized_at)
      values (${gathering.id}, 'quadratic', 100, now() - interval '3 hours', now() - interval '1 hour', null, now() - interval '1 hour')
      returning id
    `
    for (const t of TOKENS) {
      await raw`insert into vote_ballots (round_id, event_id, token, cast_at) values (${round.id}, ${gathering.id}, decode(${t}, 'hex'), now() - interval '1 hour')`
    }
    const entries: Array<[string, string[]]> = [
      [S.s1, TOKENS.slice(0, 5)],
      [S.s2, TOKENS.slice(0, 5)],
      [S.s3, TOKENS.slice(5, 8)],
    ]
    for (const [sessionId, ts] of entries) {
      for (const t of ts) {
        await raw`insert into vote_entries (round_id, event_id, session_id, votes, credits, day, ballot_token)
                  values (${round.id}, ${gathering.id}, ${sessionId}, 1, 1, current_date, decode(${t}, 'hex'))`
      }
    }

    const slots = await raw<{ id: string; venue_id: string; start_time: string }[]>`
      select id, venue_id, start_time::text as start_time from time_slots where event_id = ${gathering.id} and not is_break order by start_time, venue_id
    `
    const [mainId, workshopId] = gathering.venueIds
    const starts = [...new Set(slots.map((s) => s.start_time))]
    const at = (start: string, venue: string) => slots.find((s) => s.start_time === start && s.venue_id === venue)!.id
    rowA = { main: at(starts[0], mainId), workshop: at(starts[0], workshopId) }
    rowB = { main: at(starts[1], mainId) }
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await foreign?.cleanup()
    await organizer?.cleanup()
    await outsider?.cleanup()
    await raw?.end({ timeout: 5 })
  })

  test('PATCH …/admin/sessions/[id] pins a session to a room of this gathering only', async ({ request }) => {
    const url = `/api/v1/events/${gathering.slug}/admin/sessions/${S.s1}`
    const [mainId] = gathering.venueIds

    const pinned = await api(request, 'PATCH', url, organizer.cookie, { pinned_venue_id: mainId })
    expect(pinned.status()).toBe(200)
    const body = await pinned.json()
    expect(body.session).toMatchObject({ id: S.s1, pinned_venue_id: mainId })

    // The admin list carries the pin, so the builder can draw the icon.
    const list = await api(request, 'GET', `/api/v1/events/${gathering.slug}/admin/sessions`, organizer.cookie)
    expect(list.status()).toBe(200)
    const listed = (await list.json()).sessions.find((s: { id: string }) => s.id === S.s1)
    expect(listed.pinned_venue_id).toBe(mainId)

    // A room from another gathering is refused; the pin is unchanged.
    const cross = await api(request, 'PATCH', url, organizer.cookie, { pinned_venue_id: foreign.venueIds[0] })
    expect(cross.status()).toBe(400)
    expect((await cross.json()).field).toBe('pinned_venue_id')
    expect((await raw`select pinned_venue_id from sessions where id = ${S.s1}`)[0].pinned_venue_id).toBe(mainId)

    // Junk and missing fields.
    expect((await api(request, 'PATCH', url, organizer.cookie, { pinned_venue_id: 'nope' })).status()).toBe(400)
    expect((await api(request, 'PATCH', url, organizer.cookie, { title: 'x' })).status()).toBe(400)
    expect((await api(request, 'PATCH', `/api/v1/events/${gathering.slug}/admin/sessions/00000000-0000-4000-8000-000000000000`, organizer.cookie, { pinned_venue_id: null })).status()).toBe(404)

    // null clears the pin.
    const cleared = await api(request, 'PATCH', url, organizer.cookie, { pinned_venue_id: null })
    expect(cleared.status()).toBe(200)
    expect((await cleared.json()).session.pinned_venue_id).toBeNull()
  })

  test('only organizers may pin, same-origin only; the host-facing PATCH never accepts a pin', async ({ request }) => {
    const url = `/api/v1/events/${gathering.slug}/admin/sessions/${S.s1}`
    const [mainId] = gathering.venueIds
    expect((await api(request, 'PATCH', url, outsider.cookie, { pinned_venue_id: mainId })).status()).toBe(403)
    expect((await api(request, 'PATCH', url, undefined, { pinned_venue_id: mainId })).status()).toBe(401)
    const cross = await request.fetch(`${base}${url}`, {
      method: 'PATCH',
      headers: { cookie: organizer.cookie, origin: 'https://evil.example' },
      data: { pinned_venue_id: mainId },
    })
    expect(cross.status()).toBe(403)

    // The organizer is also the host of s1: the host route ignores the organizer-only field.
    const host = await api(request, 'PATCH', `/api/v1/sessions/${S.s1}`, organizer.cookie, { pinned_venue_id: mainId })
    expect([200, 400]).toContain(host.status())
    expect((await raw`select pinned_venue_id from sessions where id = ${S.s1}`)[0].pinned_venue_id).toBeNull()
  })

  test('schedule-quality names the concurrent keep-apart pair by session id and honors a pin', async ({ request }) => {
    const url = `/api/v1/events/${gathering.slug}/admin/schedule-quality`
    const [mainId, workshopId] = gathering.venueIds

    const together = await api(request, 'POST', url, organizer.cookie, {
      assignments: [{ sessionId: S.s1, slotId: rowA.main }, { sessionId: S.s2, slotId: rowA.workshop }],
    })
    expect(together.status()).toBe(200)
    const q1 = (await together.json()).quality
    expect(q1.checks.noKeepApartConflicts).toBe(false)
    expect(q1.conflicts).toEqual([{ a: S.s1 < S.s2 ? S.s1 : S.s2, b: S.s1 < S.s2 ? S.s2 : S.s1, overlapPercent: 100, kind: 'keepApart' }])
    for (const t of TOKENS) expect(JSON.stringify(q1)).not.toContain(t)

    const apart = await api(request, 'POST', url, organizer.cookie, {
      assignments: [{ sessionId: S.s1, slotId: rowA.main }, { sessionId: S.s2, slotId: rowB.main }],
    })
    const q2 = (await apart.json()).quality
    expect(q2.conflicts).toEqual([])
    expect(q2.checks.noKeepApartConflicts).toBe(true)
    expect(q2.score).toBeGreaterThan(q1.score)

    // Pinned to the main room, placed in the workshop room: a constraint violation.
    await api(request, 'PATCH', `/api/v1/events/${gathering.slug}/admin/sessions/${S.s3}`, organizer.cookie, { pinned_venue_id: mainId })
    const wrongRoom = await api(request, 'POST', url, organizer.cookie, { assignments: [{ sessionId: S.s3, slotId: rowA.workshop, venueId: workshopId }] })
    const q3 = (await wrongRoom.json()).quality
    expect(q3.checks.constraintsMet).toBe(false)
    expect(q3.violations.some((v: string) => /pinned/i.test(v))).toBe(true)
    const rightRoom = await api(request, 'POST', url, organizer.cookie, { assignments: [{ sessionId: S.s3, slotId: rowA.main, venueId: mainId }] })
    expect((await rightRoom.json()).quality.checks.constraintsMet).toBe(true)
    await api(request, 'PATCH', `/api/v1/events/${gathering.slug}/admin/sessions/${S.s3}`, organizer.cookie, { pinned_venue_id: null })
  })

  test('the builder renders the clusters panel, the run stages and the live quality chip', async ({ browser }) => {
    const [name, ...rest] = organizer.cookie.split('=')
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } })
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    try {
      // Put the keep-apart pair side by side so the live check has something to flag.
      const [mainId] = gathering.venueIds
      await raw`update sessions set status = 'scheduled', time_slot_id = ${rowA.main}, venue_id = ${mainId} where id = ${S.s1}`
      await raw`update sessions set status = 'scheduled', time_slot_id = ${rowA.workshop}, venue_id = ${gathering.venueIds[1]} where id = ${S.s2}`

      await page.goto(`/e/${gathering.slug}/admin/schedule`)
      await expect(page.getByRole('heading', { name: 'Schedule builder' })).toBeVisible()

      // Audience clusters: keep-apart pair with a percentage, never a voter.
      const clusters = page.getByTestId('audience-clusters')
      await expect(clusters).toContainText('1 keep-apart pair')
      await clusters.getByRole('button', { name: /Audience clusters/ }).click()
      await expect(clusters).toContainText('100%')
      await expect(clusters).toContainText('Put these in different time slots')
      for (const t of TOKENS) await expect(clusters).not.toContainText(t)

      // Live quality: chip in the toolbar and a red warning on both concurrent cells.
      const chip = page.getByTestId('quality-chip')
      await expect(chip).toBeVisible()
      await expect(chip).toContainText(/\d+/)
      await expect(page.locator('[data-testid="scheduled-cell"][data-keep-apart="true"]')).toHaveCount(2)
      await expect(page.locator(`[data-session-id="${S.s1}"]`)).toContainText('Keep apart')
      // Optional visual capture (SHOTS_DIR=…): the builder with a live conflict, then the run dialog, at two widths.
      const shots = process.env.SHOTS_DIR
      if (shots) await page.screenshot({ path: `${shots}/desktop-1280-live.png` })

      // Run dialog: five stages, big score, both checks, improvement line.
      await page.getByRole('button', { name: /Auto-schedule|Run without ballots/ }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('scheduler-stages')).toContainText('Final validation')
      await expect(dialog.getByTestId('schedule-quality')).toBeVisible()
      await expect(dialog.getByTestId('improvement-summary')).toContainText(/Hill-climb|Nothing to improve/)
      await expect(dialog).toContainText(/keep-apart conflict|No keep-apart conflicts/)
      await expect(dialog).toContainText(/constraint/)
      if (shots) {
        await page.screenshot({ path: `${shots}/desktop-1280-run.png` })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${shots}/mobile-390-run.png` })
      }
      await page.keyboard.press('Escape')
      if (shots) {
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        await page.screenshot({ path: `${shots}/mobile-390-live.png` })
        await page.setViewportSize({ width: 1280, height: 900 })
      }

      // Pin menu is present on the scheduled cell and in the tray.
      await expect(page.locator(`[data-session-id="${S.s1}"]`).getByTestId('pin-menu-trigger')).toBeVisible()
    } finally {
      await raw`update sessions set status = 'approved', time_slot_id = null, venue_id = null where id in ${raw([S.s1, S.s2])}`
      await context.close()
    }
  })
})
