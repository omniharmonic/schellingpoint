import { test, expect, type Browser, type Page } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * Quick actions on a session page (design 2026-09-26 §5.2–5.5).
 *
 * The thing the redesign actually promises is that there is *one* stack of actions, in one order,
 * mounted once — under the header card on a phone, in the sidebar on a desktop — and that the two
 * actions people could not find before (the chat group and directions) are rows in it rather than
 * cards of their own. So these tests read the stack's buttons in DOM order at both breakpoints,
 * count the stack, and check that the address itself opens directions with the same href the
 * stack's button uses.
 *
 * Everything is created here and removed in afterAll; the seeded gatherings are never touched.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

/** The order §5.3 asks for, as a viewer who is neither the host nor a confirmed attendee sees it. */
const ATTENDEE_ORDER = [
  'RSVP',
  'Save to my schedule',
  'Get directions',
  'RSVP to get the chat link',
  'Add to calendar',
  'Share',
  'Share on Bluesky',
  'Report',
]

/** The same order for the host: the chat link resolves, Edit and Withdraw appear, Report does not. */
const HOST_ORDER = [
  'RSVP',
  'Save to my schedule',
  'Get directions',
  'Join the chat group',
  'Add to calendar',
  'Share',
  'Share on Bluesky',
  'Edit session',
  'Withdraw proposal',
]

test.describe('session page: one stack of quick actions', () => {
  test.skip(
    !isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD,
    'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD',
  )
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let host: TestAccount
  let attendee: TestAccount
  let sessionId = ''
  let addressLine = ''

  /** A signed-in page at one viewport that fails the test on any uncaught client error. */
  async function pageFor(
    browser: Browser,
    who: TestAccount,
    viewport: { width: number; height: number },
  ): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
    const context = await browser.newContext({ baseURL: base, viewport })
    const [name, ...rest] = who.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    return { page, errors, close: () => context.close() }
  }

  /** The stack, once the client render has settled on this viewport's mount point. */
  async function openSession(page: Page) {
    await page.goto(`/e/${gathering.slug}/sessions/${sessionId}`)
    const stack = page.getByTestId('quick-actions')
    await expect(stack).toBeVisible()
    return stack
  }

  /** Accessible names of the stack's controls, in DOM order. */
  async function actionOrder(page: Page): Promise<string[]> {
    return page
      .getByTestId('quick-actions')
      .locator('button, a')
      .evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    // Created open so the proposals trigger lets the session in, then moved on: a session page in
    // its finished shape is what the stack is designed for.
    gathering = await createTestGathering(raw, { tag: 'sessact', status: 'proposals_open', withProgram: true, startInDays: 0 })
    host = await createTestAccount('sessact-host', { sql: raw })
    attendee = await createTestAccount('sessact-att', { sql: raw })
    // The host is an organizer here for one reason: `enforce_event_proposal_rules` rewrites a
    // participant's status to 'approved' on insert, and the stack's RSVP, calendar and chat rows
    // all hang off 'scheduled'. An organizing host sees the same rows a plain host does.
    for (const [who, role] of [
      [host, 'admin'],
      [attendee, 'attendee'],
    ] as const) {
      await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${who.id}, ${role})
                on conflict (event_id, user_id) do update set role = ${role}`
      // Past onboarding, which otherwise covers every page in a modal.
      await raw`insert into profiles (id, email, display_name, onboarding_completed)
                values (${who.id}, ${who.email}, ${`Session actions ${role}`}, true)
                on conflict (id) do update set onboarding_completed = true`
    }

    // A room with a real address and a pin, so "Get directions" is offered and the address it
    // links to is the one the location card shows.
    await raw`update venues set address = '1500 Pearl St', locality = 'Boulder', region = 'CO',
                postal_code = '80302', country = 'US', latitude = 40.0176, longitude = -105.2797,
                geocoded_from = '1500 Pearl St, Boulder, CO, 80302, US', geocoded_at = now()
              where id = ${gathering.venueIds[0]!}`
    addressLine = '1500 Pearl St, Boulder, CO, 80302, US'

    const [slot] = await raw<{ id: string }[]>`
      select id from time_slots
      where event_id = ${gathering.id} and venue_id = ${gathering.venueIds[0]!} and not is_break
      order by start_time limit 1
    `
    // Scheduled, in that room, with a chat group: the stack's RSVP, directions, calendar and chat
    // rows all depend on one of those three facts.
    const [row] = await raw<{ id: string }[]>`
      insert into sessions (event_id, host_id, title, description, format, duration, status, session_type,
                            venue_id, time_slot_id, telegram_group_url)
      values (${gathering.id}, ${host.id}, 'Quick actions under test', 'One stack, one order.', 'talk', 30,
              'scheduled', 'proposed', ${gathering.venueIds[0]!}, ${slot!.id}, 'https://t.me/+quickactions')
      returning id
    `
    sessionId = row!.id
    await raw`update events set status = 'live' where id = ${gathering.id}`
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await host?.cleanup()
    await attendee?.cleanup()
    await raw?.end({ timeout: 5 })
  })

  for (const [label, viewport] of [
    ['a phone (390×844)', PHONE],
    ['a desktop (1280×800)', DESKTOP],
  ] as const) {
    test(`the actions run in the designed order on ${label}`, async ({ browser }) => {
      const { page, errors, close } = await pageFor(browser, attendee, viewport)
      try {
        await openSession(page)
        expect(await actionOrder(page)).toEqual(ATTENDEE_ORDER)
        expect(errors).toEqual([])
      } finally {
        await close()
      }
    })

    test(`the stack is mounted exactly once on ${label}`, async ({ browser }) => {
      const { page, close } = await pageFor(browser, attendee, viewport)
      try {
        await openSession(page)
        await expect(page.getByTestId('quick-actions')).toHaveCount(1)
        // And it really is in the right column: under the header card on a phone, beside it on a
        // desktop. The header card holds the title, so compare their vertical positions.
        const title = (await page.getByRole('heading', { name: 'Quick actions under test' }).boundingBox())!
        const stack = (await page.getByTestId('quick-actions').boundingBox())!
        expect(title && stack).toBeTruthy()
        if (viewport === PHONE) {
          // Under the header card, in the same single column, nearly the full width of the phone.
          expect(stack.y).toBeGreaterThan(title.y + title.height)
          expect(stack.width).toBeGreaterThan(viewport.width * 0.8)
        } else {
          // Beside it: the sidebar column starts after the title's own column ends.
          expect(stack.x).toBeGreaterThan(title.x + title.width)
        }
      } finally {
        await close()
      }
    })
  }

  test('the host sees the chat link in the stack, and there is no chat card', async ({ browser }) => {
    const { page, errors, close } = await pageFor(browser, host, PHONE)
    try {
      const stack = await openSession(page)
      expect(await actionOrder(page)).toEqual(HOST_ORDER)

      const join = page.getByRole('link', { name: /Join the chat group/ })
      await expect(join).toHaveCount(1)
      await expect(join).toHaveAttribute('href', 'https://t.me/+quickactions')
      await expect(stack.getByRole('link', { name: /Join the chat group/ })).toHaveCount(1)

      // The card that used to carry it is gone, with its sentence.
      await expect(page.getByText('This session has a chat group for confirmed attendees.')).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('a member who has not RSVP’d gets the RSVP variant, which focuses RSVP', async ({ browser }) => {
    const { page, close } = await pageFor(browser, attendee, PHONE)
    try {
      const stack = await openSession(page)
      // No link to the group for somebody who is not confirmed, only the way to earn one.
      await expect(page.getByRole('link', { name: /Join the chat group/ })).toHaveCount(0)
      const ask = stack.getByRole('button', { name: 'RSVP to get the chat link' })
      await expect(ask).toHaveCount(1)

      await ask.click()
      await expect(stack.getByRole('button', { name: 'RSVP', exact: true })).toBeFocused()
    } finally {
      await close()
    }
  })

  test('the address opens directions with the same href as the stack', async ({ browser }) => {
    const { page, close } = await pageFor(browser, attendee, PHONE)
    try {
      const stack = await openSession(page)
      const link = page.getByTestId('session-address-link')
      await expect(link).toHaveCount(1)
      await expect(link).toHaveText(addressLine)

      // Chromium is neither iOS nor Android, so the generic Google Maps directions URL applies.
      const expected = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressLine)}`
      await expect(link).toHaveAttribute('href', expected)
      await expect(stack.getByRole('link', { name: 'Get directions' })).toHaveAttribute('href', expected)

      // The location card no longer carries a button of its own: one "Get directions", in the stack.
      await expect(page.getByRole('link', { name: 'Get directions' })).toHaveCount(1)
    } finally {
      await close()
    }
  })

  test('edit, save and share have left the header card', async ({ browser }) => {
    const { page, close } = await pageFor(browser, host, DESKTOP)
    try {
      const stack = await openSession(page)
      // The icon trio in the header card was the only place these lived outside the stack
      // (facts, "Session page"); its share icon was labelled "Share session" and is gone.
      await expect(page.getByRole('button', { name: 'Share session', exact: true })).toHaveCount(0)
      for (const name of ['Edit session', 'Save to my schedule']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
        await expect(stack.getByRole('button', { name, exact: true })).toHaveCount(1)
      }
    } finally {
      await close()
    }
  })
})
