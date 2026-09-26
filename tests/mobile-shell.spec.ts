import { test, expect, type Browser, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * The mobile-first gathering shell (mobile shell design §2, §5.1).
 *
 * What is actually asserted here is the shape of the shell at the two sizes the design is drawn
 * for: a floating bar with five items and no hamburger on a phone, no bar and a two-group sidebar
 * on a laptop, a More sheet that behaves like a dialog should, a header avatar that lands on the
 * Profile tab of Account, one context row that says either where back goes or where you are, and
 * enough room under the content that the bar never covers the last thing on the page.
 *
 * The gathering, the account and the session are this suite's own and are removed in afterAll;
 * no seeded row is read or written.
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
const LAPTOP = { width: 1280, height: 800 }

test.describe('mobile shell: floating bar, More sheet, context row', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let organizer: TestAccount
  let sessionId = ''

  /** A signed-in page at one viewport, failing the test on any uncaught client error. */
  async function shell(browser: Browser, viewport: { width: number; height: number }) {
    const context = await browser.newContext({ baseURL: base, viewport })
    const [name, ...rest] = organizer.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    return { page, errors, close: () => context.close() }
  }

  /** Waiting for the client shell to have hydrated and drawn itself. */
  async function openWorkspace(page: Page, path: string) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('workspace-context')).toBeVisible()
  }

  const bar = (page: Page) => page.getByTestId('mobile-tab-bar')
  /** The bar's only button. Located by CSS, not by role: an open sheet hides the rest of the
      document from the accessibility tree, which is exactly what it should do. */
  const moreButton = (page: Page) => bar(page).locator('button')

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'shell', status: 'proposals_open', withProgram: true })
    organizer = await createTestAccount('shell-org', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizer.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`
    // Past onboarding, which otherwise covers every page in a modal.
    await raw`insert into profiles (id, email, display_name, onboarding_completed)
              values (${organizer.id}, ${organizer.email}, 'Mobile Shell', true)
              on conflict (id) do update set onboarding_completed = true, display_name = 'Mobile Shell'`
    const [row] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, is_votable)
      values (${gathering.id}, ${`Shell session ${gathering.slug}`}, 'A session to open from the list.', 'talk', 60,
              ${organizer.id}, 'approved', true)
      returning id
    `
    sessionId = row!.id
  })

  test.afterAll(async () => {
    await gathering?.cleanup().catch(() => undefined)
    await organizer?.cleanup().catch(() => undefined)
    await raw?.end({ timeout: 5 })
  })


  // ── the bar, at both sizes ────────────────────────────────────────────────────────────────

  test('a phone gets a five-item floating bar and no hamburger', async ({ browser }) => {
    const { page, errors, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions`)

      await expect(bar(page)).toBeVisible()
      const items = bar(page).locator('a, button')
      await expect(items).toHaveCount(5)
      expect((await items.allInnerTexts()).map((t) => t.trim())).toEqual(['Home', 'Sessions', 'Schedule', 'Map', 'More'])

      // Sessions is the page we are on, and says so.
      await expect(bar(page).getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page')
      await expect(bar(page).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page')

      // The drawer and its hamburger are gone: the avatar and the More sheet replaced them.
      await expect(page.getByRole('button', { name: /event navigation/i })).toHaveCount(0)

      // Every target in the bar is at least 44px tall.
      const heights = await items.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44)

      // The bar floats: inset from both edges, never full-bleed.
      const box = await bar(page).boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(8)
      expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width - 8)

      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('Schedule is one tab, lit for the program and for my schedule alike', async ({ browser }) => {
    const { page, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/schedule`)
      const tab = bar(page).getByRole('link', { name: 'Schedule' })
      await expect(tab).toHaveAttribute('href', `/e/${gathering.slug}/schedule`)
      await expect(tab).toHaveAttribute('aria-current', 'page')

      await openWorkspace(page, `/e/${gathering.slug}/my-schedule`)
      await expect(bar(page).getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page')
    } finally {
      await close()
    }
  })

  test('a laptop gets no bar, and a sidebar in two groups', async ({ browser }) => {
    const { page, errors, close } = await shell(browser, LAPTOP)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions`)

      await expect(bar(page)).toBeHidden()

      const nav = page.locator('nav[aria-label="Event navigation"]')
      await expect(nav).toBeVisible()
      const labels = (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim())
      expect(labels).toEqual([
        'Home',
        'Sessions',
        'Schedule',
        'Map',
        'People',
        'My votes',
        'Ask',
        'Propose a session',
        'Organizer workspace',
      ])

      // The four destinations first, then a rule, then the ones a tap deeper (design §1).
      const groups = nav.locator(':scope > div')
      await expect(groups).toHaveCount(4) // two nav groups, the Propose button, Organizer workspace
      await expect(groups.nth(1)).toHaveClass(/border-t/)

      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  // ── the More sheet ────────────────────────────────────────────────────────────────────────

  test('the More sheet holds what the bar does not, traps focus, and closes on Escape', async ({ browser }) => {
    const { page, errors, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions`)
      const more = moreButton(page)
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      await more.click()

      const sheet = page.getByTestId('more-sheet')
      await expect(sheet).toBeVisible()
      await expect(sheet.getByRole('heading', { name: 'More' })).toBeVisible()
      await expect(more).toHaveAttribute('aria-expanded', 'true')

      // Proposals are open, the viewer is an owner and can read this gathering's transcripts,
      // so the full set is here.
      const rows = sheet.locator('nav a, nav button')
      expect((await rows.allInnerTexts()).map((t) => t.trim())).toEqual([
        'People',
        'My votes',
        'Ask',
        'Propose a session',
        'Organizer workspace',
        'Notification preferences',
        'Account',
        'Sign out',
      ])

      // Focus is trapped: tabbing never leaves the sheet.
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab')
        expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      }

      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('the More sheet closes on a route change', async ({ browser }) => {
    const { page, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions`)
      await moreButton(page).click()
      const sheet = page.getByTestId('more-sheet')
      await expect(sheet).toBeVisible()

      await sheet.getByRole('link', { name: 'My votes' }).click()
      await expect(page).toHaveURL(new RegExp(`/e/${gathering.slug}/my-votes`))
      await expect(sheet).toBeHidden()

      // And on a route change the sheet itself did not start: going back closes it too.
      await moreButton(page).click()
      await expect(page.getByTestId('more-sheet')).toBeVisible()
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/e/${gathering.slug}/sessions`))
      await expect(page.getByTestId('more-sheet')).toBeHidden()
    } finally {
      await close()
    }
  })

  test('a backdrop click closes the More sheet', async ({ browser }) => {
    const { page, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions`)
      await moreButton(page).click()
      const sheet = page.getByTestId('more-sheet')
      await expect(sheet).toBeVisible()
      await page.mouse.click(PHONE.width / 2, 40)
      await expect(sheet).toBeHidden()
    } finally {
      await close()
    }
  })

  // ── the header avatar ─────────────────────────────────────────────────────────────────────

  test('the header avatar opens Account on its Profile tab', async ({ browser }) => {
    const { page, errors, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions`)
      const avatar = page.getByRole('button', { name: /^Account, / })
      await expect(avatar).toBeVisible()
      expect((await avatar.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await avatar.click()

      const account = page.getByRole('dialog')
      await expect(account.getByRole('heading', { name: 'Account' })).toBeVisible()
      await expect(account.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true')
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  // ── the context row ───────────────────────────────────────────────────────────────────────

  test('the context row says where back goes on a session page, and where you are elsewhere', async ({ browser }) => {
    const { page, close } = await shell(browser, PHONE)
    try {
      await openWorkspace(page, `/e/${gathering.slug}/sessions/${sessionId}`)
      const row = page.getByTestId('workspace-context')
      const back = row.getByRole('link', { name: 'Sessions' })
      await expect(back).toBeVisible()
      await expect(back).toHaveAttribute('href', `/e/${gathering.slug}/sessions`)
      await expect(row.getByRole('link', { name: /Gathering page/ })).toBeVisible()
      // One line, not two: the in-content "Back to sessions" button is gone.
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(48)
      await expect(page.getByRole('link', { name: 'Back to sessions' })).toHaveCount(0)

      await openWorkspace(page, `/e/${gathering.slug}/my-votes`)
      await expect(page.getByTestId('workspace-context')).toContainText('My votes')
      await expect(page.getByTestId('workspace-context').getByRole('link', { name: 'Sessions' })).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('content keeps clear of the floating bar on a phone, and gives the room back on a laptop', async ({ browser }) => {
    const phone = await shell(browser, PHONE)
    try {
      await openWorkspace(phone.page, `/e/${gathering.slug}/sessions`)
      const padding = await phone.page.locator('#workspace-main').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
      expect(padding).toBeGreaterThanOrEqual(88)
    } finally {
      await phone.close()
    }

    const laptop = await shell(browser, LAPTOP)
    try {
      await openWorkspace(laptop.page, `/e/${gathering.slug}/sessions`)
      const padding = await laptop.page.locator('#workspace-main').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
      expect(padding).toBe(0)
    } finally {
      await laptop.close()
    }
  })

  // ── accessibility ─────────────────────────────────────────────────────────────────────────

  test('the shell has no serious or critical accessibility violations', async ({ browser }) => {
    test.setTimeout(180_000)
    const failures: string[] = []

    for (const [label, viewport] of [['phone', PHONE], ['laptop', LAPTOP]] as const) {
      const { page, close } = await shell(browser, viewport)
      try {
        for (const path of [`/e/${gathering.slug}/sessions`, `/e/${gathering.slug}/sessions/${sessionId}`]) {
          await openWorkspace(page, path)
          await page.waitForLoadState('networkidle').catch(() => undefined)
          failures.push(...(await violations(page, `${label} ${path}`)))
        }
        // And with the More sheet open, which is the one surface the shell adds.
        if (label === 'phone') {
          await moreButton(page).click()
          await expect(page.getByTestId('more-sheet')).toBeVisible()
          failures.push(...(await violations(page, 'phone, More sheet open')))
        }
      } finally {
        await close()
      }
    }

    expect(failures, failures.join('\n')).toEqual([])
  })

  /**
   * Serious and critical only: the threshold `tests/a11y.spec.ts` set, for the same reason.
   * The sheet fades in over its backdrop, and a contrast reading taken mid-fade measures a
   * colour nobody ever sees, so every animation is let finish first.
   */
  async function violations(page: Page, where: string): Promise<string[]> {
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    return results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${where}: ${v.id} [${v.impact}] — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  }
})
