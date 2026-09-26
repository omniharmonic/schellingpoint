import { test, expect, type Browser, type Page } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * No side-to-side movement on a phone, on any gathering surface.
 *
 * The assertion that matters is not `scrollWidth <= innerWidth`: iOS Safari and Chrome answer a
 * horizontally overflowing page by *widening the layout viewport* and zooming out, so `innerWidth`
 * grows to match `scrollWidth` and the naive check passes on exactly the pages that are broken.
 * (Before the fix, Home reported `innerWidth` 528 at a 390px viewport, and the session page 602.)
 * So each surface is asked three things:
 *
 *   1. the layout viewport is still the width of the device — nothing made the browser zoom out;
 *   2. the document does not scroll sideways;
 *   3. no single element sticks out past the right edge (1px of rounding allowed).
 *
 * The fixture's session carries a long unbreakable title and a long unbreakable URL on purpose:
 * a handle, a DID or a pasted link does the same thing in production, and an `auto` grid track
 * sizes itself to the widest one of them unless it is capped.
 *
 * The gathering, the account and the session are this suite's own and go away in afterAll.
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

/** An iPhone, because the layout-viewport widening is what this suite is about. */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const VIEWPORTS = [
  { width: 390, height: 844 }, // iPhone 14/15/16
  { width: 375, height: 667 }, // iPhone SE, the narrowest still in use
]

interface Overflow {
  innerWidth: number
  scrollWidth: number
  offenders: string[]
}

test.describe('mobile: nothing moves sideways', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let organizer: TestAccount
  let sessionId = ''

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'ovflw', status: 'voting_open', withProgram: true })
    organizer = await createTestAccount('ovflw-org', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizer.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`
    await raw`insert into profiles (id, email, display_name, onboarding_completed)
              values (${organizer.id}, ${organizer.email}, 'Averylongunbrokendisplaynamewithnospaces', true)
              on conflict (id) do update set onboarding_completed = true,
                                            display_name = 'Averylongunbrokendisplaynamewithnospaces'`
    const [row] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, is_votable)
      values (${gathering.id},
              ${`Averyveryverylongunbrokenwordtitlethatcannotwrapanywhere-${gathering.slug}`},
              'https://example.com/a/very/long/url/that/cannot/break/anywhere/at/all/really/truly/not-even-once',
              'talk', 60, ${organizer.id}, 'approved', true)
      returning id
    `
    sessionId = row!.id
  })

  test.afterAll(async () => {
    await gathering?.cleanup().catch(() => undefined)
    await organizer?.cleanup().catch(() => undefined)
    await raw?.end({ timeout: 5 })
  })

  async function phone(browser: Browser, viewport: { width: number; height: number }) {
    const context = await browser.newContext({
      baseURL: base,
      viewport,
      userAgent: IPHONE_UA,
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    })
    const [name, ...rest] = organizer.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    return { page: await context.newPage(), close: () => context.close() }
  }

  /** Every element whose right edge is past `want`, named well enough to find in the source. */
  async function overflow(page: Page, want: number): Promise<Overflow> {
    return page.evaluate((want) => {
      const offenders: string[] = []
      const walk = (el: Element) => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.right > want + 1) {
          const id = el.id ? `#${el.id}` : ''
          const tid = el.getAttribute('data-testid')
          offenders.push(
            `${el.tagName.toLowerCase()}${id}${tid ? `[data-testid=${tid}]` : ''} right=${r.right.toFixed(0)} w=${r.width.toFixed(0)} class="${(el.getAttribute('class') || '').slice(0, 100)}"`,
          )
        }
        for (const child of Array.from(el.children)) walk(child)
      }
      walk(document.documentElement)
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: offenders.slice(0, 12),
      }
    }, want)
  }

  function assertNoSidewaysMovement(where: string, want: number, result: Overflow) {
    const detail = `${where}: innerWidth=${result.innerWidth} scrollWidth=${result.scrollWidth}\n${result.offenders.join('\n')}`
    // 1. The browser did not widen the layout viewport to fit an overflow (and so did not zoom out).
    expect(result.innerWidth, detail).toBe(want)
    // 2. The document does not scroll sideways.
    expect(result.scrollWidth, detail).toBeLessThanOrEqual(want + 1)
    // 3. Nothing sticks out past the right edge.
    expect(result.offenders, detail).toEqual([])
  }

  for (const viewport of VIEWPORTS) {
    test(`no horizontal overflow on any gathering surface at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
      test.setTimeout(600_000)
      const { page, close } = await phone(browser, viewport)
      try {
        const slug = gathering.slug
        const surfaces: Array<[string, string]> = [
          ['Home', `/e/${slug}/dashboard`],
          ['Sessions', `/e/${slug}/sessions`],
          ['Schedule', `/e/${slug}/schedule`],
          ['Map', `/e/${slug}/map`],
          ['a session page', `/e/${slug}/sessions/${sessionId}`],
          ['People', `/e/${slug}/participants`],
        ]

        for (const [label, path] of surfaces) {
          await page.goto(path, { waitUntil: 'load' })
          // The shell draws client-side; the floating bar is the signal that it has. `.first()`
          // because a streamed page briefly holds the server copy and the client copy at once.
          await expect(page.getByTestId('mobile-tab-bar').first()).toBeVisible({ timeout: 60_000 })
          await page.waitForLoadState('networkidle').catch(() => undefined)
          assertNoSidewaysMovement(label, viewport.width, await overflow(page, viewport.width))
        }

        // And the seventh surface: the More sheet, open over Home.
        await page.goto(`/e/${slug}/dashboard`, { waitUntil: 'load' })
        const bar = page.getByTestId('mobile-tab-bar').first()
        await expect(bar).toBeVisible({ timeout: 60_000 })
        await bar.locator('button').click()
        await expect(page.getByTestId('more-sheet').first()).toBeVisible()
        // The sheet fades in; a rectangle read mid-slide is a rectangle nobody ever sees.
        await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
        assertNoSidewaysMovement('the More sheet, open', viewport.width, await overflow(page, viewport.width))
      } finally {
        await close()
      }
    })
  }
})
