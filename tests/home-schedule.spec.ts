import { test, expect, type Browser, type Page } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'
import { describeNow, formatCountdown, type NowLineInput } from '../src/components/home/now-line'

/**
 * Wave H of the mobile shell (design 2026-09-26 §3, §4): Home's Now line, and Schedule's two tabs.
 *
 * The Now line's copy is a pure function, so every state is asserted with `now` passed in rather
 * than with a clock. The wiring — that Home reads the round, the schedule and the attendance
 * window and says the right thing — is asserted in the browser against one throwaway gathering
 * whose round and status are moved between navigations.
 *
 * Also pinned here: `/my-schedule` redirects to `/schedule?view=mine`; both tabs are the one
 * `ScheduleView` and the tab lives in the URL; Home carries no vote counts for a member; and
 * announcements come only from the gathering being looked at.
 *
 * Everything is created here and removed in afterAll. The seeded gatherings are never touched.
 */
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

const PHONE = { width: 390, height: 844 }

/* ───────────────────────── 1. the Now line, as copy ───────────────────────── */

const T0 = Date.parse('2026-09-26T12:00:00.000Z')

function input(over: Partial<NowLineInput> = {}): NowLineInput {
  return {
    slug: 'a-gathering',
    name: 'Test Event',
    eventStatus: 'voting_open',
    schedulePublished: false,
    voting: { status: 'none', opensAt: null, closesAt: null, remaining: null },
    attendance: { open: false, live: 0, liveSaved: 0 },
    saved: 0,
    sessions: 12,
    participants: 30,
    feedbackOpen: false,
    ...over,
  }
}

test.describe('the Now line says one thing, for every state the gathering can be in', () => {
  test('voting upcoming counts down to the open', () => {
    const copy = describeNow(
      input({ voting: { status: 'upcoming', opensAt: new Date(T0 + 2 * 3600_000 + 5 * 60_000).toISOString(), closesAt: null, remaining: 40 } }),
      T0,
    )
    expect(copy.state).toBe('voting-upcoming')
    expect(copy.headline).toBe('Voting opens in 2 h 5 min.')
    expect(copy.ticking).toBe(true)
  })

  test('voting open counts down to the close and says how many credits are left', () => {
    const copy = describeNow(
      input({ voting: { status: 'open', opensAt: null, closesAt: new Date(T0 + 3 * 3600_000 + 12 * 60_000).toISOString(), remaining: 4 } }),
      T0,
    )
    expect(copy.state).toBe('voting-open')
    expect(copy.headline).toBe('Voting closes in 3 h 12 min — 4 credits left.')
    expect(copy.action).toEqual({ label: 'Vote', href: '/e/a-gathering/sessions' })
    // A signed-out viewer has no credits to report, and no number is invented for them.
    const out = describeNow(
      input({ voting: { status: 'open', opensAt: null, closesAt: new Date(T0 + 600_000).toISOString(), remaining: null } }),
      T0,
    )
    expect(out.headline).toBe('Voting closes in 10 min 0 s.')
  })

  test('between rounds: the schedule is either not out, or out with a saved count', () => {
    const waiting = describeNow(input({ voting: { status: 'closed', opensAt: null, closesAt: null, remaining: 0 } }), T0)
    expect(waiting.state).toBe('waiting')
    expect(waiting.headline).toBe('Voting has closed. The schedule is not out yet.')

    const out = describeNow(input({ schedulePublished: true, saved: 6, voting: { status: 'closed', opensAt: null, closesAt: null, remaining: 0 } }), T0)
    expect(out.state).toBe('schedule-out')
    expect(out.headline).toBe('The schedule is out. 6 sessions saved.')

    const nothingSaved = describeNow(input({ schedulePublished: true, saved: 0 }), T0)
    expect(nothingSaved.headline).toBe('The schedule is out. Save the sessions you want to be in.')
  })

  test('the attendance round wins over everything and names the sessions you saved', () => {
    const copy = describeNow(
      input({
        eventStatus: 'live',
        schedulePublished: true,
        attendance: { open: true, live: 3, liveSaved: 2 },
        voting: { status: 'open', opensAt: null, closesAt: new Date(T0 + 3600_000).toISOString(), remaining: 9 },
      }),
      T0,
    )
    expect(copy.state).toBe('attendance-open')
    expect(copy.headline).toBe('Happening now: 3 sessions, 2 you saved.')
    expect(copy.action?.href).toBe('/e/a-gathering/schedule?view=mine')
    expect(copy.ticking).toBe(false)
  })

  test('over: thanks, and a Feedback link only while a window is open', () => {
    const closed = describeNow(input({ eventStatus: 'completed', schedulePublished: true }), T0)
    expect(closed.state).toBe('over')
    expect(closed.headline).toBe('Thanks for being part of Test Event.')
    expect(closed.action).toBeNull()

    const open = describeNow(input({ eventStatus: 'completed', schedulePublished: true, feedbackOpen: true }), T0)
    expect(open.action).toEqual({ label: 'Feedback', href: '/e/a-gathering/schedule?view=mine' })
  })

  test('the second line is the two counts, and participants only for members', () => {
    expect(describeNow(input(), T0).second).toBe('12 sessions, 30 people')
    expect(describeNow(input({ participants: null }), T0).second).toBe('12 sessions')
    expect(describeNow(input({ sessions: 1, participants: 1 }), T0).second).toBe('1 session, 1 person')
  })

  test('no state ever mentions a total, a tally or a rank', () => {
    const states: NowLineInput[] = [
      input({ voting: { status: 'upcoming', opensAt: new Date(T0 + 3600_000).toISOString(), closesAt: null, remaining: 10 } }),
      input({ voting: { status: 'open', opensAt: null, closesAt: new Date(T0 + 3600_000).toISOString(), remaining: 10 } }),
      input({ voting: { status: 'closed', opensAt: null, closesAt: null, remaining: 0 } }),
      input({ schedulePublished: true, saved: 3 }),
      input({ eventStatus: 'live', attendance: { open: true, live: 2, liveSaved: 1 } }),
      input({ eventStatus: 'completed', feedbackOpen: true }),
    ]
    for (const state of states) {
      const copy = describeNow(state, T0)
      const text = `${copy.headline} ${copy.second}`.toLowerCase()
      for (const banned of ['total', 'most voted', 'top session', 'leaderboard', 'rank', 'votes for']) {
        expect(text, `${copy.state} must not say "${banned}"`).not.toContain(banned)
      }
    }
  })

  test('the countdown drops to minute precision when motion is reduced', () => {
    expect(formatCountdown(3 * 3600_000 + 12 * 60_000 + 30_000)).toBe('3 h 12 min')
    expect(formatCountdown(12 * 60_000 + 30_000)).toBe('12 min 30 s')
    expect(formatCountdown(12 * 60_000 + 30_000, 'minute')).toBe('12 min')
    expect(formatCountdown(30_000, 'minute')).toBe('under a minute')
    expect(formatCountdown(30_000)).toBe('30 s')
    expect(formatCountdown(2 * 86400_000 + 3 * 3600_000)).toBe('2 days 3 h')
    expect(formatCountdown(0)).toBe('now')
    expect(formatCountdown(-5_000)).toBe('now')
  })
})

/* ──────────────────── 2. Home and Schedule, in a browser ──────────────────── */

test.describe('Home and Schedule against a real gathering', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let sql: postgres.Sql
  let gathering: TestGathering
  let other: TestGathering
  let member: TestAccount
  let roomId = ''
  const S = { now: '', later: '', proposed: '' }
  const slots = { now: '', later: '' }

  /** A phone-sized signed-in page that fails the test on any uncaught client error. */
  async function phone(browser: Browser, who: TestAccount): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
    const context = await browser.newContext({ baseURL: base, viewport: PHONE })
    const [name, ...rest] = who.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    return { page, errors, close: () => context.close() }
  }

  const nowLine = (page: Page) => page.getByTestId('now-line')

  /** Opens Home and waits for the Now line to settle on a state (the client reads the round). */
  async function openHome(page: Page, state: string) {
    await page.goto(`/e/${gathering.slug}/dashboard`)
    await expect(nowLine(page)).toHaveAttribute('data-now-state', state, { timeout: 30_000 })
  }

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    sql = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'home', status: 'voting_open', startInDays: 0, voting: { credits: 20 } })
    other = await createTestGathering(sql, { tag: 'homex', status: 'voting_open', startInDays: 0 })
    member = await createTestAccount('home-member', { sql })
    await sql`insert into event_members (event_id, user_id, role) values
                (${gathering.id}, ${member.id}, 'owner'), (${other.id}, ${member.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`
    // Past onboarding, which otherwise covers every page in a modal.
    await sql`insert into profiles (id, email, display_name, onboarding_completed)
              values (${member.id}, ${member.email}, 'Home Wave', true)
              on conflict (id) do update set onboarding_completed = true`

    // A room with a real address, so "Next for you" has a directions target.
    const [room] = await sql<{ id: string }[]>`
      insert into venues (event_id, name, slug, capacity, address, locality, region, postal_code, country)
      values (${gathering.id}, 'Room A', 'room-a', 40, '1500 Pearl St', 'Boulder', 'CO', '80302', 'US')
      returning id
    `
    roomId = room!.id
    const rows = await sql<{ id: string }[]>`
      insert into time_slots (event_id, venue_id, start_time, end_time, day_date, slot_type)
      values (${gathering.id}, ${roomId}, now() - interval '10 minutes', now() + interval '40 minutes', current_date, 'session'),
             (${gathering.id}, ${roomId}, now() + interval '3 hours', now() + interval '4 hours', current_date, 'session')
      returning id
    `
    slots.now = rows[0]!.id
    slots.later = rows[1]!.id

    const session = async (title: string, status: string, slot: string | null) => {
      const [row] = await sql<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, host_id, status, is_votable, venue_id, time_slot_id)
        values (${gathering.id}, ${title}, 'talk', 30, ${member.id}, ${status}, true, ${slot ? roomId : null}, ${slot})
        returning id
      `
      return row!.id
    }
    S.now = await session(`Home now ${gathering.slug}`, 'scheduled', slots.now)
    S.later = await session(`Home later ${gathering.slug}`, 'scheduled', slots.later)
    S.proposed = await session(`Home proposed ${gathering.slug}`, 'approved', null)
    // One saved session, so the saved count and "Next for you" have something to say.
    await sql`insert into favorites (event_id, user_id, session_id) values (${gathering.id}, ${member.id}, ${S.later})
              on conflict do nothing`
  })

  test.afterAll(async () => {
    await member?.cleanup().catch(() => undefined)
    await gathering?.cleanup().catch(() => undefined)
    await other?.cleanup().catch(() => undefined)
    await sql?.end({ timeout: 5 })
  })

  test('Home leads with a ticking Now line while voting is open, and no stat tiles', async ({ browser }) => {
    await sql`
      insert into vote_rounds (event_id, phase, mechanism, credits, opens_at, closes_at)
      values (${gathering.id}, 'pre-event', 'quadratic', 20, now() - interval '1 hour', now() + interval '3 hours 12 minutes')
    `
    const { page, errors, close } = await phone(browser, member)
    try {
      await openHome(page, 'voting-open')
      const line = nowLine(page)
      await expect(line).toContainText(/Voting closes in 3 h \d+ min — \d+ credits left\./)
      await expect(line).toContainText('3 sessions, 1 person')
      await expect(line.getByRole('link', { name: 'Vote' })).toBeVisible()

      // The stat tiles are gone (design §3: "the header stat tiles are dropped").
      await expect(page.locator('.dashboard-stats')).toHaveCount(0)
      await expect(page.locator('.stats-card')).toHaveCount(0)
      // No leaderboard, ever.
      await expect(page.getByText(/top sessions/i)).toHaveCount(0)

      // The organizer banner carries the placed count while the schedule is unpublished (§3.7).
      const banner = page.getByTestId('organizer-banner')
      await expect(banner).toBeVisible()
      await expect(banner).toContainText(/(\d+ of \d+ sessions placed|all \d+ sessions? placed)/)

      await page.screenshot({
        path: `${process.env.HOME_SCREENSHOT_DIR || '.'}/home-voting-open-390.png`,
        fullPage: true,
      })

      // The countdown is the only motion on the page. Above an hour it is minutes only, so move
      // the close inside the hour, where the seconds tick, and watch the sentence change itself.
      await sql`update vote_rounds set closes_at = now() + interval '4 minutes' where event_id = ${gathering.id} and phase = 'pre-event' and finalized_at is null`
      await page.reload()
      await expect(line).toContainText(/Voting closes in [0-3] min \d+ s/, { timeout: 30_000 })
      const first = await line.locator('p').first().innerText()
      await expect.poll(() => line.locator('p').first().innerText(), { timeout: 15_000 }).not.toBe(first)
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('the attendance round takes over the Now line while a session is on', async ({ browser }) => {
    // Leaving the voting phase seals the pre-event round; going live opens the attendance one.
    await sql`update events set status = 'live', attendance_voting_enabled = true, attendance_credits = 10 where id = ${gathering.id}`
    await sql`
      insert into vote_rounds (event_id, phase, mechanism, credits, opens_at, closes_at)
      values (${gathering.id}, 'attendance', 'quadratic', 10, now() - interval '30 minutes', now() + interval '6 hours')
    `
    const { page, errors, close } = await phone(browser, member)
    try {
      await openHome(page, 'attendance-open')
      await expect(nowLine(page)).toContainText('Happening now: 1 session.')
      await expect(nowLine(page).getByRole('link', { name: 'My schedule' })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('once the schedule is out the Now line counts what you saved and Next for you appears', async ({ browser }) => {
    await sql`update events set status = 'scheduling', schedule_published_at = now() where id = ${gathering.id}`
    const { page, errors, close } = await phone(browser, member)
    try {
      await openHome(page, 'schedule-out')
      await expect(nowLine(page)).toContainText('The schedule is out. 1 session saved.')

      const next = page.getByTestId('next-for-you')
      await expect(next).toBeVisible()
      await expect(next).toContainText(`Home later ${gathering.slug}`)
      await expect(next).toContainText('From your saved sessions')
      await expect(next).toContainText('Room A')
      // The directions link is built from the written address, never from a bare pin.
      const directions = next.getByRole('link', { name: 'Get directions' })
      await expect(directions).toBeVisible()
      expect(await directions.getAttribute('href')).toContain('Pearl')
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('when it is over Home says thanks, and offers Feedback only while a window is open', async ({ browser }) => {
    await sql`update events set status = 'completed' where id = ${gathering.id}`
    const first = await phone(browser, member)
    try {
      await openHome(first.page, 'over')
      await expect(nowLine(first.page)).toContainText(`Thanks for being part of ${gathering.name}.`)
      await expect(nowLine(first.page).getByRole('link', { name: 'Feedback' })).toHaveCount(0)
    } finally {
      await first.close()
    }

    await sql`
      insert into feedback_windows (session_id, event_id, opens_at, closes_at)
      values (${S.now}, ${gathering.id}, now() - interval '1 hour', now() + interval '48 hours')
      on conflict (session_id) do update set opens_at = excluded.opens_at, closes_at = excluded.closes_at
    `
    const second = await phone(browser, member)
    try {
      await openHome(second.page, 'over')
      await expect(nowLine(second.page).getByRole('link', { name: 'Feedback' })).toBeVisible()
      expect(second.errors).toEqual([])
    } finally {
      await second.close()
    }
  })

  test('Home carries no vote counts for a member, and no leaderboard', async () => {
    const res = await fetch(`${base}/e/${gathering.slug}/dashboard`, { headers: { cookie: member.cookie } })
    expect(res.status).toBe(200)
    const html = await res.text()
    for (const forbidden of ['total_votes', 'voter_count', 'total_credits', 'Top sessions', 'Most voted', 'Total votes']) {
      expect(html, forbidden).not.toContain(forbidden)
    }
  })

  /* ───────────────────────── announcements ───────────────────────── */

  test('"From the organizers" carries only this gathering’s announcements', async () => {
    const announce = async (eventId: string, title: string) => {
      await sql`
        select public.emit_notifications(
          ${eventId}::uuid, ${[member.id]}::uuid[], 'admin_announcement'::text,
          ${title}::text, 'Read this before you arrive.'::text, null::text, '{}'::jsonb
        )
      `
    }
    await announce(gathering.id, `Doors open at nine ${gathering.slug}`)
    await announce(other.id, `A different gathering ${other.slug}`)

    const res = await fetch(`${base}/api/v1/events/${gathering.slug}/announcements?limit=3`, {
      headers: { cookie: member.cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { announcements: Array<{ title: string }> }
    expect(body.announcements.map((a) => a.title)).toEqual([`Doors open at nine ${gathering.slug}`])
    expect(JSON.stringify(body)).not.toContain(other.slug)

    // At most three, newest first, and never someone else's feed.
    for (const n of [1, 2, 3, 4]) await announce(gathering.id, `Notice ${n} ${gathering.slug}`)
    const three = await (
      await fetch(`${base}/api/v1/events/${gathering.slug}/announcements`, { headers: { cookie: member.cookie } })
    ).json()
    expect((three as { announcements: unknown[] }).announcements).toHaveLength(3)
    expect((await fetch(`${base}/api/v1/events/${gathering.slug}/announcements`)).status).toBe(401)
  })

  test('Home shows the last three announcements and links to all notifications', async ({ browser }) => {
    const { page, errors, close } = await phone(browser, member)
    try {
      await openHome(page, 'over')
      const card = page.getByTestId('from-the-organizers')
      await expect(card).toBeVisible()
      await expect(card).toContainText(`Notice 4 ${gathering.slug}`)
      await expect(card).not.toContainText(other.slug)
      await expect(card.getByRole('link', { name: /All notifications/ })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  /* ───────────────────────── the schedule tabs ───────────────────────── */

  test('/my-schedule redirects to the My schedule tab', async ({ browser }) => {
    const { page, close } = await phone(browser, member)
    try {
      await page.goto(`/e/${gathering.slug}/my-schedule`)
      await expect(page).toHaveURL(new RegExp(`/e/${gathering.slug}/schedule\\?view=mine$`))
      await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible()
      await expect(page.getByTestId('schedule-view')).toHaveAttribute('data-view', 'mine')
    } finally {
      await close()
    }
  })

  test('both tabs are the one ScheduleView, and the tab is in the URL', async ({ browser }) => {
    const { page, errors, close } = await phone(browser, member)
    try {
      await page.goto(`/e/${gathering.slug}/schedule`)
      const view = page.getByTestId('schedule-view')
      await expect(view).toHaveAttribute('data-view', 'program', { timeout: 30_000 })
      await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()
      // Program only: search. My schedule only: the day/venue controls are shared.
      await expect(page.getByLabel('Search the schedule')).toBeVisible()
      await expect(view).toContainText(`Home now ${gathering.slug}`)

      await page.getByRole('radio', { name: 'My schedule' }).click()
      await expect(page).toHaveURL(/view=mine/)
      await expect(view).toHaveAttribute('data-view', 'mine')
      await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible()
      await expect(page.getByLabel('Search the schedule')).toHaveCount(0)
      // The saved tab is the favourites, so only the saved session is in it.
      await expect(view).toContainText(`Home later ${gathering.slug}`)
      await expect(view).not.toContainText(`Home now ${gathering.slug}`)

      // Deep-linking and reloading keep the tab.
      await page.reload()
      await expect(page.getByTestId('schedule-view')).toHaveAttribute('data-view', 'mine', { timeout: 30_000 })

      await page.getByRole('radio', { name: 'Program' }).click()
      await expect(page).not.toHaveURL(/view=mine/)
      await expect(page.getByTestId('schedule-view')).toHaveAttribute('data-view', 'program')
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('Undo after an un-save saves it again, and the API agrees', async ({ browser }) => {
    const { page, errors, close } = await phone(browser, member)
    try {
      await page.goto(`/e/${gathering.slug}/schedule?view=mine`)
      const view = page.getByTestId('schedule-view')
      await expect(view).toHaveAttribute('data-view', 'mine', { timeout: 30_000 })
      const title = `Home later ${gathering.slug}`
      await expect(view).toContainText(title)

      // Un-saving takes the row out of the saved tab and offers Undo.
      await view.getByRole('button', { name: `Remove ${title} from my schedule` }).click()
      await expect(view).not.toContainText(title)
      const note = page.getByRole('region', { name: 'Notifications' }).getByRole('status')
      await expect(note).toContainText('Removed from my schedule')

      // Undo means "save it again", not "toggle whatever the button last saw".
      await note.getByRole('button', { name: 'Undo' }).click()
      await expect(view).toContainText(title)
      await expect(view.getByRole('button', { name: `Remove ${title} from my schedule` })).toHaveCount(1)

      const saved = await page.request.get(`/api/v1/events/${gathering.slug}/sessions?favorites=1`)
      expect(saved.status()).toBe(200)
      const body = (await saved.json()) as { sessions: Array<{ id: string; is_favorite: boolean }> }
      expect(body.sessions.map((s) => s.id)).toContain(S.later)
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('a signed-out viewer gets the sign-in prompt where the saved list would be', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: base, viewport: PHONE })
    try {
      const page = await context.newPage()
      await page.goto(`/e/${gathering.slug}/schedule?view=mine`)
      const view = page.getByTestId('schedule-view')
      await expect(view).toHaveAttribute('data-view', 'mine', { timeout: 30_000 })
      await expect(view.getByRole('heading', { name: 'Sign in to keep a schedule' })).toBeVisible()
      await expect(view.getByRole('link', { name: 'Sign in' })).toBeVisible()
      // The program tab is public and still lists sessions.
      await page.goto(`/e/${gathering.slug}/schedule`)
      await expect(page.getByTestId('schedule-view')).toContainText(`Home now ${gathering.slug}`, { timeout: 30_000 })
    } finally {
      await context.close()
    }
  })
})
