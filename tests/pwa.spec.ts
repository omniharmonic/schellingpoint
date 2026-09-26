import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * The app as an app: installable, with an icon, and readable in a basement with no signal.
 *
 * Three groups, and they need different things to run:
 *
 *  · the manifest, its icons and the document's own `<head>` — request level, any server;
 *  · the service worker and the offline fallback — a *production* server, because `ServiceWorker`
 *    deliberately does not register in development (a stale shell in a dev browser is a debugging
 *    trap). Set `PWA_TEST_BASE_URL` to a `next build && next start` server to run them;
 *  · the install offer, on all three surfaces it appears on — the dev server is enough.
 *
 * Headless Chromium never fires `beforeinstallprompt`, so the Chromium branch of the offer cannot
 * be exercised from a test at all; what is asserted instead is the iOS branch (which is the one
 * with copy in it) and, on every engine, that the offer disappears once the app is installed or
 * once the person has said no. That last one is the part with a dark pattern to avoid.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const prodBase = process.env.PWA_TEST_BASE_URL || ''
const databaseUrl = process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

const PHONE = { width: 390, height: 844 }
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

// ── the manifest and the head ────────────────────────────────────────────────────────────────

test.describe('PWA: the manifest, its icons, and the document head', () => {
  interface Manifest {
    id?: string
    name?: string
    short_name?: string
    start_url?: string
    scope?: string
    display?: string
    display_override?: string[]
    theme_color?: string
    background_color?: string
    icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>
    shortcuts?: Array<{ name: string; url: string }>
  }

  test('the manifest is served as a manifest, and says what an installable app has to say', async ({ request }) => {
    const response = await request.get(`${base}/manifest.webmanifest`)
    expect(response.status()).toBe(200)
    // Chrome will parse a manifest served as text/plain but Lighthouse and Safari will not.
    expect(response.headers()['content-type']).toContain('application/manifest+json')

    const manifest = (await response.json()) as Manifest
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.id).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.display_override).toEqual(['standalone'])
    expect(manifest.theme_color).toBeTruthy()
    expect(manifest.background_color).toBeTruthy()

    // `start_url` has to be inside `scope`, or the installed app opens in a browser tab.
    const scope = new URL(manifest.scope!, base)
    const start = new URL(manifest.start_url!, base)
    expect(manifest.start_url).toBe('/')
    expect(start.pathname.startsWith(scope.pathname)).toBe(true)
  })

  test('the manifest offers 192 and 512, both plain and maskable, and every one of them is a real PNG', async ({ request }) => {
    const manifest = (await (await request.get(`${base}/manifest.webmanifest`)).json()) as Manifest
    const icons = manifest.icons || []

    for (const [purpose, size] of [
      ['any', '192x192'],
      ['any', '512x512'],
      ['maskable', '192x192'],
      ['maskable', '512x512'],
    ] as const) {
      const icon = icons.find((i) => i.sizes === size && (i.purpose || 'any').split(' ').includes(purpose))
      expect(icon, `no ${purpose} ${size} icon in the manifest`).toBeTruthy()
      expect(icon!.type).toBe('image/png')

      const response = await request.get(new URL(icon!.src, base).toString())
      expect(response.status(), `${icon!.src} is not served`).toBe(200)
      expect(response.headers()['content-type']).toContain('image/png')
      // The PNG signature, so a renamed SVG or a 200-with-an-error-page cannot pass.
      const body = await response.body()
      expect(Array.from(body.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
  })

  test('every shortcut goes somewhere that exists', async ({ request }) => {
    const manifest = (await (await request.get(`${base}/manifest.webmanifest`)).json()) as Manifest
    for (const shortcut of manifest.shortcuts || []) {
      expect(shortcut.name).toBeTruthy()
      const response = await request.get(new URL(shortcut.url, base).toString())
      expect(response.status(), `${shortcut.url} answers ${response.status()}`).toBeLessThan(400)
    }
  })

  test('the document links the manifest, the iOS icon and the iOS app title', async ({ page }) => {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest\.webmanifest/)
    // iOS reads only `apple-touch-icon`, and only a PNG.
    const apple = page.locator('link[rel="apple-touch-icon"]')
    await expect(apple).toHaveAttribute('href', /\.png/)
    await expect(apple).toHaveAttribute('sizes', '180x180')
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', /\S/)
    // Both spellings: Next emits the modern one, and iOS before 16.4 reads only the Apple one.
    await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', /#/)
  })
})

// ── the service worker and the offline page (production only) ────────────────────────────────

test.describe('PWA: the service worker and the offline page', () => {
  test.skip(!prodBase, 'set PWA_TEST_BASE_URL to a `next build && next start` server: the worker does not register in development')
  test.describe.configure({ mode: 'serial' })

  /**
   * Resolves once the worker is not merely registered but *controlling* this page. An active
   * registration is not enough: until `clients.claim()` has landed, `fetch` still goes straight to
   * the network, and a test that switches the network off in that window sees a browser error page
   * instead of the worker's offline fallback.
   */
  async function waitForWorker(page: Page) {
    // waitForFunction in our Playwright version treats an async predicate's Promise
    // as truthy before it resolves. Poll the resolved value so offline mode cannot
    // race worker installation or activation.
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return registration?.active?.state === 'activated' && !!navigator.serviceWorker.controller
    }), { timeout: 60_000 }).toBe(true)
  }

  test('sw.js is served as JavaScript and registers on a production build', async ({ page, request }) => {
    const script = await request.get(`${prodBase}/sw.js`)
    expect(script.status()).toBe(200)
    expect(script.headers()['content-type']).toMatch(/javascript/)

    await page.goto(`${prodBase}/`, { waitUntil: 'load' })
    await waitForWorker(page)
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)
    expect(scope).toBe(`${prodBase.replace(/\/$/, '')}/`)
  })

  test('with no network at all, a navigation lands on the offline page', async ({ page, context }) => {
    await page.goto(`${prodBase}/`, { waitUntil: 'load' })
    await waitForWorker(page)
    // The worker precaches `/offline` during install; give that a moment to finish.
    await expect.poll(() => page.evaluate(async () => {
      for (const name of await caches.keys()) {
        if (await (await caches.open(name)).match('/offline')) return true
      }
      return false
    }), { timeout: 30_000 }).toBe(true)

    await context.setOffline(true)
    try {
      await page.goto(`${prodBase}/events`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: /you are offline/i })).toBeVisible()
    } finally {
      await context.setOffline(false)
    }
  })

  test('the worker never keeps an authenticated page or a private API answer', async ({ page }) => {
    await page.goto(`${prodBase}/`, { waitUntil: 'load' })
    await waitForWorker(page)

    // Every dynamic route Next renders for a signed-in reader says `private` or `no-store`, and
    // `storable()` in sw.js drops both. This is the contract the worker's safety rests on.
    const headers = await page.evaluate(async () => {
      const response = await fetch('/api/me/profile', { credentials: 'include' })
      return { status: response.status, control: response.headers.get('cache-control') || '' }
    })
    expect(headers.control.toLowerCase()).toMatch(/private|no-store/)

    // And `/api/me/*` is refused a cache entry outright, whatever it answers.
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys()
      const found: string[] = []
      for (const name of keys) {
        for (const request of await (await caches.open(name)).keys()) {
          const { pathname } = new URL(request.url)
          if (pathname.startsWith('/api/me/') || pathname.startsWith('/api/calendar/')) found.push(pathname)
        }
      }
      return found
    })
    expect(cached).toEqual([])
  })
})

// ── the install offer ────────────────────────────────────────────────────────────────────────

test.describe('PWA: the offer to install, and the one dismissal that sticks', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let member: TestAccount
  let newcomer: TestAccount

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'pwa', status: 'proposals_open' })
    member = await createTestAccount('pwa-member', { sql: raw })
    newcomer = await createTestAccount('pwa-new', { sql: raw })
    for (const account of [member, newcomer]) {
      await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${account.id}, 'attendee')
                on conflict (event_id, user_id) do nothing`
    }
    // `member` is past onboarding; `newcomer` is not, so the onboarding modal opens for them.
    await raw`insert into profiles (id, email, display_name, onboarding_completed)
              values (${member.id}, ${member.email}, 'Install Member', true)
              on conflict (id) do update set onboarding_completed = true, display_name = 'Install Member'`
  })

  test.afterAll(async () => {
    await gathering?.cleanup().catch(() => undefined)
    await member?.cleanup().catch(() => undefined)
    await newcomer?.cleanup().catch(() => undefined)
    await raw?.end({ timeout: 5 })
  })

  /** Opens the More sheet, once the shell it lives in has actually drawn itself. */
  async function openMoreSheet(page: Page) {
    const bar = page.getByTestId('mobile-tab-bar').first()
    await expect(bar).toBeVisible({ timeout: 60_000 })
    await bar.locator('button').click()
    await expect(page.getByTestId('more-sheet').first()).toBeVisible()
  }

  /**
   * An iPhone, where the offer is an instruction. `standalone` makes the page believe it is
   * already an installed app: `page.emulateMedia` has no `display-mode`, so the media query is
   * replaced before any of our own script runs.
   */
  async function iphone(browser: Browser, account: TestAccount, { standalone = false } = {}) {
    const context = await browser.newContext({
      baseURL: base,
      viewport: PHONE,
      userAgent: IPHONE_UA,
      hasTouch: true,
      isMobile: true,
    })
    const [name, ...rest] = account.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    if (standalone) await emulateStandalone(context)
    return { page: await context.newPage(), context, close: () => context.close() }
  }

  async function emulateStandalone(context: BrowserContext) {
    await context.addInitScript(() => {
      const real = window.matchMedia.bind(window)
      window.matchMedia = ((query: string) =>
        /display-mode:\s*standalone/.test(query)
          ? { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }
          : real(query)) as typeof window.matchMedia
    })
  }

  // ── the More sheet ──────────────────────────────────────────────────────────────────────

  test('the More sheet offers the app, and says where the iOS button is rather than pretending to install', async ({ browser }) => {
    const { page, close } = await iphone(browser, member)
    try {
      await page.goto(`/e/${gathering.slug}/sessions`, { waitUntil: 'domcontentloaded' })
      await openMoreSheet(page)
      const sheet = page.getByTestId('more-sheet').first()

      const row = sheet.getByTestId('install-row')
      await expect(row).toBeVisible()
      await expect(row).toHaveText('Install the app')
      // It is not in the nav: installing is not a destination in this gathering.
      await expect(sheet.locator('nav').getByTestId('install-row')).toHaveCount(0)

      // On iOS the row opens the instruction. There is no button that claims to install.
      await expect(sheet.getByTestId('install-ios-steps')).toHaveCount(0)
      await row.click()
      const steps = sheet.getByTestId('install-ios-steps')
      await expect(steps).toBeVisible()
      await expect(steps).toContainText('Tap Share, then Add to Home Screen')
      await expect(sheet.getByTestId('install-button')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('an app already on the home screen is never asked to install itself', async ({ browser }) => {
    const { page, close } = await iphone(browser, member, { standalone: true })
    try {
      await page.goto(`/e/${gathering.slug}/sessions`, { waitUntil: 'domcontentloaded' })
      // The override is in place before anything of ours ran.
      expect(await page.evaluate(() => window.matchMedia('(display-mode: standalone)').matches)).toBe(true)

      await openMoreSheet(page)
      const sheet = page.getByTestId('more-sheet').first()
      await expect(sheet.getByRole('heading', { name: 'More' })).toBeVisible()
      await expect(sheet.getByTestId('install-row')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  // ── Account ─────────────────────────────────────────────────────────────────────────────

  test('Account offers it too, as one row on the Profile tab', async ({ browser }) => {
    const { page, close } = await iphone(browser, member)
    try {
      await page.goto(`/e/${gathering.slug}/sessions`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Account, / }).click()

      const account = page.getByRole('dialog')
      await expect(account.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true')
      await expect(account.getByTestId('install-row')).toHaveCount(1)
    } finally {
      await close()
    }
  })

  // ── onboarding ──────────────────────────────────────────────────────────────────────────

  /** Walks the onboarding modal to its last step, which is where the card lives. */
  async function reachLastOnboardingStep(page: Page) {
    await page.goto(`/e/${gathering.slug}/dashboard`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Skip to your profile' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Skip to your profile' }).click()
    // Step 1 of the profile needs a name before it will let anyone past.
    await page.getByLabel(/display name|your name/i).first().fill('Install Newcomer')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()
  }

  test('the last onboarding step offers the app, and one dismissal keeps it gone', async ({ browser }) => {
    test.setTimeout(240_000)
    const { page, close } = await iphone(browser, newcomer)
    try {
      await reachLastOnboardingStep(page)

      const card = page.getByTestId('install-card')
      await expect(card).toBeVisible()
      await expect(card).toContainText('Add to your home screen')
      await expect(card.getByTestId('install-ios-steps')).toContainText('Tap Share, then Add to Home Screen')

      // One dismiss, and it is remembered.
      await card.getByTestId('install-dismiss').click()
      await expect(card).toHaveCount(0)
      expect(await page.evaluate(() => window.localStorage.getItem('pwa-install-dismissed'))).toMatch(/^\d+$/)

      // It does not come back on the next page, on the next surface, or on a reload.
      await reachLastOnboardingStep(page)
      await expect(page.getByTestId('install-card')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('a dismissal from more than thirty days ago is allowed to lapse', async ({ browser }) => {
    const { page, close } = await iphone(browser, member)
    try {
      await page.goto(`/e/${gathering.slug}/sessions`, { waitUntil: 'domcontentloaded' })

      // A fresh "no" silences every surface.
      await page.evaluate(() => window.localStorage.setItem('pwa-install-dismissed', String(Date.now())))
      await page.reload({ waitUntil: 'load' })
      await openMoreSheet(page)
      await expect(page.getByTestId('install-row')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('more-sheet')).toHaveCount(0)

      // Thirty-one days later it may ask once more.
      await page.evaluate(() => {
        const thirtyOneDays = 31 * 24 * 60 * 60 * 1000
        window.localStorage.setItem('pwa-install-dismissed', String(Date.now() - thirtyOneDays))
      })
      await page.reload({ waitUntil: 'load' })
      await openMoreSheet(page)
      await expect(page.getByTestId('install-row')).toBeVisible()
    } finally {
      await close()
    }
  })

  test('a browser with nothing to offer draws nothing — no empty card, no dead button', async ({ browser }) => {
    // Desktop Chromium: no `beforeinstallprompt` in headless, and no iOS share sheet either.
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 800 } })
    const [name, ...rest] = member.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    try {
      // `/account` renders the same panel as the modal, without a menu to open first.
      await page.goto('/account', { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('install-row')).toHaveCount(0)
      await expect(page.getByTestId('install-card')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
