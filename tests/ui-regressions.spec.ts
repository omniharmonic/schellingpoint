import { test, expect, type Page } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * Regressions from the first production run of unconference.events (September 2026), each pinned
 * to the thing that actually broke:
 *
 *   · the logo upload — one multipart path for every image, and a server that says which of the
 *     two body failures happened instead of blaming the uploader for both;
 *   · "My sessions" going blank after saving a session — a list read that trusted the payload's
 *     shape and threw inside render when a 200 carried something else;
 *   · the map showing a world outline that would not zoom — MapLibre 6 starts its worker from a
 *     separate script, and without a URL it can fetch, vector tiles and glyphs never load.
 *
 * Everything is created here and removed in afterAll; the seeded gatherings are never touched.
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

/** A real 1×1 PNG: the upload route identifies images by their magic bytes, not their name. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** MapLibre needs WebGL2; headless Chromium only has it through SwiftShader. */
test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } })

test.describe('production regressions: uploads, session navigation, map tiles', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let organizer: TestAccount

  /** A signed-in page that fails the test on any uncaught client error. */
  async function signedInPage(browser: import('@playwright/test').Browser): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } })
    const [name, ...rest] = organizer.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    return { page, errors, close: () => context.close() }
  }

  /** The `/e/[slug]` error boundary, which is what a crash during render looks like to a person. */
  const crashed = (page: Page) => page.getByText('We couldn’t load this page.')

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'uireg', status: 'proposals_open', withProgram: true })
    organizer = await createTestAccount('uireg-org', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizer.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`
    // Past onboarding, which otherwise covers every page in a modal.
    await raw`insert into profiles (id, email, display_name, onboarding_completed)
              values (${organizer.id}, ${organizer.email}, 'UI Regressions', true)
              on conflict (id) do update set onboarding_completed = true`
    // A room with a real address and a pin, so the map opens over somewhere with tiles and the
    // editor's "seed the view from the gathering's address" lookup never reaches Nominatim.
    await raw`update venues set address = '1500 Pearl St', locality = 'Boulder', region = 'CO',
                postal_code = '80302', country = 'US', latitude = 40.0176, longitude = -105.2797,
                geocoded_from = '1500 Pearl St, Boulder, CO, 80302, US', geocoded_at = now()
              where id = ${gathering.venueIds[0]!}`
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await organizer?.cleanup()
    await raw?.end({ timeout: 5 })
  })

  // ── the logo upload ────────────────────────────────────────────────────────────────────────

  test('a PNG chosen in the gathering settings uploads and renders', async ({ browser }) => {
    const { page, errors, close } = await signedInPage(browser)
    try {
      await page.goto(`/e/${gathering.slug}/admin/settings`)
      const input = page.locator('#event-logo')
      await input.waitFor({ state: 'attached' })
      await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG })

      // Saved the moment it uploads: the card swaps "Upload" for "Replace" and shows the image.
      const images = page.locator('#images')
      await expect(images.getByRole('button', { name: 'Replace' })).toBeVisible()
      const src = await images.locator('img').first().getAttribute('src')
      expect(src).toMatch(/^\/uploads\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)

      // And it is really served, so the preview is not just an object URL.
      const served = await page.request.get(`${base}${src}`)
      expect(served.status()).toBe(200)
      expect(served.headers()['content-type']).toBe('image/png')

      const [row] = await raw<{ logo_url: string | null }[]>`select logo_url from events where id = ${gathering.id}`
      expect(row?.logo_url).toBe(src)
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('the upload route tells a non-multipart body apart from one that arrived short', async ({ browser }) => {
    const { page, close } = await signedInPage(browser)
    try {
      await page.goto(`/e/${gathering.slug}/admin/settings`)
      // JSON where multipart belongs: the message that names multipart belongs to this case only.
      const json = await page.request.post(`${base}/api/uploads`, {
        headers: { origin: base, 'content-type': 'application/json' },
        data: { file: 'data:image/png;base64,…' },
      })
      expect(json.status()).toBe(415)
      expect((await json.json()).code).toBe('InvalidBody')

      // A multipart body that is cut off mid-part: a different failure, and a different message.
      const boundary = '----unconferenceTruncated'
      const truncated = await page.request.post(`${base}/api/uploads`, {
        headers: { origin: base, 'content-type': `multipart/form-data; boundary=${boundary}` },
        data: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n`),
      })
      expect(truncated.status()).toBe(400)
      expect((await truncated.json()).code).toBe('IncompleteUpload')
    } finally {
      await close()
    }
  })

  // ── saving a session, then moving between My schedule and My sessions ──────────────────────

  test('proposing a session, then My schedule and My sessions, never blanks the page', async ({ browser }) => {
    const { page, errors, close } = await signedInPage(browser)
    try {
      await page.goto(`/e/${gathering.slug}/propose`)
      await page.waitForSelector('#propose-title')
      await page.fill('#propose-title', `Regression session ${gathering.slug}`)
      await page.fill('#propose-description', 'Proposed by the regression suite, then navigated away from and back to.')
      const submit = page.locator('form').getByRole('button', { name: 'Propose a session', exact: true })
      await expect(submit).toBeEnabled()
      await submit.scrollIntoViewIfNeeded()
      await submit.click()
      await expect(page.getByText('Your session is proposed')).toBeVisible()

      // Save it to the schedule so both pages have something to render.
      await page.goto(`/e/${gathering.slug}/sessions?filter=mine`)
      await expect(page.getByText(`Regression session ${gathering.slug}`)).toBeVisible()
      await page.getByRole('button', { name: /^Save .* to my schedule$/ }).first().click()

      for (const url of [`/e/${gathering.slug}/my-schedule`, `/e/${gathering.slug}/sessions?filter=mine`, `/e/${gathering.slug}/my-schedule`]) {
        await page.goto(url)
        await expect(crashed(page)).toHaveCount(0)
      }
      // Including through history, which re-runs the effects against a restored scroll position.
      await page.goBack()
      await expect(crashed(page)).toHaveCount(0)
      await page.goBack()
      await expect(crashed(page)).toHaveCount(0)
      await page.goForward()
      await expect(crashed(page)).toHaveCount(0)

      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('a list read that is not the shape we asked for is a load error, not a blank page', async ({ browser }) => {
    const { page, close } = await signedInPage(browser)
    try {
      // What a restarting server, or a proxy substituting a page for JSON, looks like: a 200 whose
      // body has no list in it. Both these pages read `tracks` straight off the payload and then
      // render `tracks.length`, so before the fix this threw inside render and blanked the page.
      await page.route(/\/api\/v1\/events\/[^/]+\/(tracks|sessions)(\?|$)/, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
      )

      await page.goto(`/e/${gathering.slug}/sessions?filter=mine`)
      await page.getByRole('button', { name: 'Filters' }).click() // where the track chips live
      await expect(crashed(page)).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible()

      await page.goto(`/e/${gathering.slug}/my-schedule`)
      await expect(crashed(page)).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible()
    } finally {
      await close()
    }
  })

  // ── the map ────────────────────────────────────────────────────────────────────────────────

  test('MapLibre’s worker is served from our own origin as JavaScript', async ({ request }) => {
    // Copied out of node_modules by `npm run maplibre:worker` (predev/prebuild). Without it
    // MapLibre falls back to `new Worker('')`, loads the page as its worker, and never fetches
    // a vector tile again.
    for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
      const res = await request.get(`${base}/maplibre/${name}`)
      expect(res.status(), `${name} must be served`).toBe(200)
      expect(res.headers()['content-type']).toMatch(/javascript/)
    }
    // The worker imports the shared chunk by relative path, so they must stay side by side.
    const worker = await (await request.get(`${base}/maplibre/maplibre-gl-worker.mjs`)).text()
    expect(worker).toContain('./maplibre-gl-shared.mjs')
    const onDisk = await readFile(path.join(process.cwd(), 'public', 'maplibre', 'maplibre-gl-worker.mjs'), 'utf8')
    expect(worker.length).toBe(onDisk.length)
  })

  test('nothing in the app’s response headers forbids the map’s hosts', async ({ request }) => {
    // The app sends no page Content-Security-Policy today. If one is ever added it has to let the
    // tile host through for style JSON, tiles, glyphs and sprites (connect-src and img-src), and
    // allow the worker (worker-src), or the map goes back to being a world outline.
    const res = await request.get(`${base}/e/${gathering.slug}/map`)
    const csp = res.headers()['content-security-policy'] ?? res.headers()['content-security-policy-report-only']
    if (!csp) return
    const tileHost = new URL(process.env.NEXT_PUBLIC_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty').origin
    const directive = (name: string) => {
      const found = csp.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name} `))
      return found ?? csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('default-src ')) ?? ''
    }
    expect(directive('connect-src'), 'connect-src must allow the tile host').toContain(tileHost)
    expect(directive('img-src'), 'img-src must allow the tile host').toContain(tileHost)
    expect(directive('img-src'), 'img-src must allow data: sprites').toContain('data:')
    expect(directive('worker-src'), 'worker-src must allow our own worker script').toMatch(/'self'|blob:/)
  })

  test('the organizer’s map loads vector tiles and keeps loading them as it zooms in', async ({ browser }) => {
    test.setTimeout(120_000)
    const { page, close } = await signedInPage(browser)
    const tiles: string[] = []
    page.on('request', (r) => {
      if (/\/\d+\/\d+\/\d+\.pbf(\?|$)/.test(r.url())) tiles.push(r.url())
    })
    try {
      await page.goto(`/e/${gathering.slug}/admin/setup`)
      const canvas = page.locator('[data-testid=venue-map] canvas')
      await canvas.waitFor({ timeout: 60_000 })

      // The worker is what fetches vector tiles, so its URL is the thing under test.
      const workerUrls = page.workers().map((w) => w.url())
      expect(workerUrls.some((u) => u.includes('/maplibre/maplibre-gl-worker.mjs')), `workers: ${workerUrls.join(', ')}`).toBe(true)

      await expect.poll(() => tiles.length, { timeout: 45_000, message: 'no vector tile was ever requested' }).toBeGreaterThan(0)

      const zoomsBefore = new Set(tiles.map((u) => u.match(/\/(\d+)\/\d+\/\d+\.pbf/)?.[1]))
      const before = tiles.length
      await page.locator('[data-testid=venue-map] .maplibregl-ctrl-zoom-in').click()
      await page.locator('[data-testid=venue-map] .maplibregl-ctrl-zoom-in').click()
      await expect.poll(() => tiles.length, { timeout: 30_000, message: 'zooming in requested no new tiles' }).toBeGreaterThan(before)
      expect(zoomsBefore.size).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })
})
