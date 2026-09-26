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
 *   · the logo upload — one binary upload path for every image, and a server that says which of the
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

  for (const filename of ['logo.png', 'Gathering – café 🌱.png']) test(`a full-sized PNG named ${filename} uploads and renders`, async ({ browser }) => {
    const { page, errors, close } = await signedInPage(browser)
    try {
      // Each filename is its own run over the same gathering, and this one sets both images.
      // Clear them first, or the second run opens on a card that already says Replace twice.
      await raw`update events set logo_url = null, banner_url = null where id = ${gathering.id}`
      await page.goto(`/e/${gathering.slug}/admin/settings`)
      const input = page.locator('#event-logo')
      await input.waitFor({ state: 'attached' })
      await input.setInputFiles({ name: filename, mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) })

      // Saved the moment it uploads: the card swaps "Upload" for "Replace" and shows the image.
      const images = page.locator('#images')
      await expect(images.getByRole('button', { name: 'Replace' })).toBeVisible()
      const src = await images.locator('img').first().getAttribute('src')
      expect(src).toMatch(/^\/uploads\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)

      await expect(page.locator('[data-testid=event-brand-logo]').filter({ visible: true })).toHaveAttribute('src', src!)

      // And it is really served, so the preview is not just an object URL.
      const served = await page.request.get(`${base}${src}`)
      expect(served.status()).toBe(200)
      expect(served.headers()['content-type']).toBe('image/png')

      await page.locator('#event-banner').setInputFiles({ name: filename, mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(1024 * 1024, 1)]) })
      await expect(images.getByRole('button', { name: 'Replace' })).toHaveCount(2)
      const [banner] = await raw`select banner_url from events where id = ${gathering.id}`
      expect((await page.request.get(`${base}${banner.banner_url}`)).status()).toBe(200)

      const [row] = await raw<{ logo_url: string | null }[]>`select logo_url from events where id = ${gathering.id}`
      expect(row?.logo_url).toBe(src)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/e/${gathering.slug}/dashboard`)
      await expect(page.locator('[data-testid=event-brand-logo]').filter({ visible: true })).toHaveAttribute('src', src!)
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

      // My schedule is a tab of Schedule (mobile shell design §4); `/my-schedule` redirects to it,
      // and that redirect is pinned in tests/home-schedule.spec.ts. Here we want the two pages
      // themselves, and history between them, so navigate straight at the tab: a server redirect
      // in the middle of the history stack is not what this regression is about.
      for (const url of [
        `/e/${gathering.slug}/schedule?view=mine`,
        `/e/${gathering.slug}/sessions?filter=mine`,
        `/e/${gathering.slug}/schedule?view=mine`,
      ]) {
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

      await page.goto(`/e/${gathering.slug}/schedule?view=mine`)
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
      await expect.poll(() => page.workers().some(w => w.url().includes('/maplibre/maplibre-gl-worker.mjs')), {
        timeout: 15_000, message: 'the map worker must start after its canvas mounts',
      }).toBe(true)

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

/**
 * Profiles (design §3): on `main` the session host card had a "View full profile" link and the
 * `atproto` popover had no way out (fact-finding, Profiles). The link is back, and it leads to a
 * real page at `/e/[slug]/people/[did]` whose interests lead back to a filtered People page.
 */
test.describe('a host name leads to their profile', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let sql: postgres.Sql
  let gathering: TestGathering
  let host: TestAccount
  let viewer: TestAccount
  let sessionId = ''
  const interest = 'Soil carbon'

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    sql = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    // Created with proposals open so the session insert passes the proposal-window trigger, then
    // moved to live, which is the state the session page is read in.
    gathering = await createTestGathering(sql, { tag: 'profilelink', status: 'proposals_open', withProgram: true })
    ;[host, viewer] = await Promise.all([
      createTestAccount('profile-host', { sql }),
      createTestAccount('profile-viewer', { sql }),
    ])
    await sql`insert into event_members (event_id, user_id, role) values
                (${gathering.id}, ${host.id}, 'attendee'), (${gathering.id}, ${viewer.id}, 'owner')`
    await sql`update profiles set display_name = 'Robin Hostwell', onboarding_completed = true,
                affiliation = 'Soil Commons', looking_for = 'People running compost sites',
                interests = ${sql.array([interest, 'Water'])}
              where id = ${host.id}`
    await sql`update profiles set display_name = 'Viewing Organizer', onboarding_completed = true where id = ${viewer.id}`
    const [slot] = await sql<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and is_break = false order by start_time limit 1
    `
    const [session] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id, status, time_slot_id, venue_id)
      values (${gathering.id}, 'Compost at scale', 'workshop', 60, ${host.id}, 'scheduled', ${slot.id}, ${slot.venue_id})
      returning id
    `
    sessionId = session.id
    await sql`update events set status = 'live' where id = ${gathering.id}`
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await Promise.all([host, viewer].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end({ timeout: 5 })
  })

  /** A page signed in as `who`, failing the test on any uncaught client error. */
  async function pageAs(browser: import('@playwright/test').Browser, who: TestAccount) {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } })
    const [name, ...rest] = who.cookie.split('=')
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    return { page, errors, close: () => context.close() }
  }

  test('host popover → View profile → the profile page, whose interests filter People', async ({ browser }) => {
    const { page, errors, close: closeContext } = await pageAs(browser, viewer)
    const context = { close: closeContext }
    try {
      await page.goto(`/e/${gathering.slug}/sessions/${sessionId}`)
      await page.getByRole('button', { name: /Hosted by Robin Hostwell/ }).click()
      const viewProfile = page.getByRole('link', { name: 'View profile' })
      await expect(viewProfile).toBeVisible()
      await viewProfile.click()

      await expect(page).toHaveURL(new RegExp(`/e/${gathering.slug}/people/`))
      const profile = page.getByTestId('member-profile')
      await expect(profile.getByRole('heading', { name: 'Robin Hostwell', level: 1 })).toBeVisible()
      await expect(profile.getByText('Soil Commons')).toBeVisible()
      await expect(profile.getByText('People running compost sites')).toBeVisible()
      // The session they host here is listed, and leads back to it.
      await expect(profile.getByRole('link', { name: 'Compost at scale' })).toBeVisible()

      // Each interest is a link to People filtered by it.
      await page.getByTestId('profile-interests').getByRole('link', { name: interest }).click()
      await expect(page).toHaveURL(/\/participants\?interest=/)
      expect(new URL(page.url()).searchParams.get('interest')).toBe(interest)
      await expect(page.getByRole('button', { name: interest, pressed: true })).toBeVisible()
      // Robin lists it; the organizer does not, so the chip really narrowed the list.
      await expect(page.getByRole('link', { name: 'Robin Hostwell' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Viewing Organizer' })).toHaveCount(0)

      // The sort control writes itself into the URL, so a sorted view is a link.
      await page.getByLabel('Sort people').selectOption('joined')
      await expect(page).toHaveURL(/sort=joined/)
      expect(new URL(page.url()).searchParams.get('interest')).toBe(interest)

      // `?highlight=` still opens the quick-look dialog it always did.
      await page.goto(`/e/${gathering.slug}/participants?highlight=${host.id}`)
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('link', { name: 'Robin Hostwell' })).toBeVisible()
      await expect(dialog.getByRole('link', { name: 'View full profile' })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  })

  test('Account shows the three per-gathering sharing switches, and saving one sticks', async ({ browser }) => {
    const { page, errors, close } = await pageAs(browser, host)
    try {
      // `?settings=1` opens the Account modal with this gathering in context.
      await page.goto(`/e/${gathering.slug}/participants?settings=1`)
      const sharing = page.getByTestId('gathering-sharing')
      await expect(sharing).toBeVisible()
      await expect(sharing.getByText(/What you share at/)).toBeVisible()
      const email = sharing.getByRole('switch', { name: 'Show my email address' })
      await expect(email).toHaveAttribute('aria-checked', 'false')
      await email.click()
      await expect(email).toHaveAttribute('aria-checked', 'true')

      // The switch is optimistic; the row is the truth, so poll for it.
      const membership = async () => {
        const [row] = await sql<{ share_email: boolean; share_contact: boolean }[]>`
          select share_email, share_contact from event_members
          where event_id = ${gathering.id} and user_id = ${host.id}
        `
        return row
      }
      await expect.poll(membership, { timeout: 10_000 }).toEqual({ share_email: true, share_contact: true })

      // And a fellow member now sees the address on the profile page.
      const seen = await page.request.get(
        `${base}/api/v1/events/${gathering.slug}/participants/${encodeURIComponent(host.did)}`,
        { headers: { cookie: viewer.cookie } },
      )
      expect((await seen.json()).member.email).toBe(host.email)
      expect(errors).toEqual([])
    } finally {
      await close()
    }
  })

  test('?sort=shared falls back for a viewer with no interests of their own', async ({ browser }) => {
    // The organizer lists no interests, so "Shares most interests with you" is disabled and a
    // link carrying it must not select a dead option.
    const { page, errors, close } = await pageAs(browser, viewer)
    try {
      await page.goto(`/e/${gathering.slug}/participants?sort=shared`)
      const sort = page.getByLabel('Sort people')
      await expect(sort).toHaveValue('name')
      await expect(page.getByRole('option', { name: 'Shares most interests with you' })).toBeDisabled()
      expect(errors).toEqual([])

      // Robin does list interests, so for Robin it is both enabled and the default.
      await close()
      const asHost = await pageAs(browser, host)
      try {
        await asHost.page.goto(`/e/${gathering.slug}/participants`)
        await expect(asHost.page.getByLabel('Sort people')).toHaveValue('shared')
        expect(asHost.errors).toEqual([])
      } finally {
        await asHost.close()
      }
    } finally {
      await close().catch(() => {})
    }
  })

  test('onboarding keeps the modal open when the sharing switches cannot be saved', async ({ browser }) => {
    const newcomer = await createTestAccount('profile-fail', { sql })
    try {
      await sql`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${newcomer.id}, 'attendee')`
      await sql`update profiles set onboarding_completed = false where id = ${newcomer.id}`
      const { page, close } = await pageAs(browser, newcomer)
      try {
        // Let the GET through (the switches must render) and break only the PATCH.
        await page.route('**/participants/me', async (route) => {
          if (route.request().method() === 'PATCH') {
            await route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'the membership store is down' }),
            })
          } else {
            await route.continue()
          }
        })
        await page.goto(`/e/${gathering.slug}/participants`)
        await page.getByRole('button', { name: 'Skip to your profile' }).click()
        await page.getByLabel('Display name').fill('Will Not Save')
        await page.getByRole('button', { name: 'Continue' }).click()
        await page.getByRole('button', { name: 'Continue' }).click()
        await page.getByRole('switch', { name: 'Show my messaging handle' }).click()
        await page.getByRole('button', { name: 'Save profile' }).click()

        // The failure is shown, the modal stays open, and onboarding is NOT marked done — so the
        // person is never told their choice was saved when it was not.
        await expect(page.getByRole('alert')).toContainText(/Could not save what you share here/)
        await expect(page.getByText('Connecting with people here')).toBeVisible()
        const [profile] = await sql<{ onboarding_completed: boolean; display_name: string | null }[]>`
          select onboarding_completed, display_name from profiles where id = ${newcomer.id}
        `
        expect(profile.onboarding_completed).toBe(false)
        expect(profile.display_name).not.toBe('Will Not Save')
        const [membership] = await sql<{ share_contact: boolean }[]>`
          select share_contact from event_members where event_id = ${gathering.id} and user_id = ${newcomer.id}
        `
        expect(membership.share_contact).toBe(true)

        // With the route working again, the same button finishes the job.
        await page.unroute('**/participants/me')
        await page.getByRole('button', { name: 'Save profile' }).click()
        await expect(page.getByText('Connecting with people here')).toBeHidden()
        await expect
          .poll(async () => {
            const [row] = await sql<{ share_contact: boolean }[]>`
              select share_contact from event_members where event_id = ${gathering.id} and user_id = ${newcomer.id}
            `
            return row.share_contact
          }, { timeout: 10_000 })
          .toBe(false)
      } finally {
        await close()
      }
    } finally {
      await newcomer.cleanup()
    }
  })

  test('a visitor who has not joined a public gathering is offered no sharing switches', async ({ browser }) => {
    const visitor = await createTestAccount('profile-visitor', { sql })
    try {
      // Signed in, onboarding pending, and NOT a member: `share_contact` defaults on, so offering
      // a switch here would let them turn sharing off and believe it.
      await sql`update profiles set onboarding_completed = false where id = ${visitor.id}`
      const { page, errors, close } = await pageAs(browser, visitor)
      try {
        // The gathering's landing page has no workspace shell; the schedule is public and does.
        await page.goto(`/e/${gathering.slug}/schedule`)
        await page.getByRole('button', { name: 'Skip to your profile' }).click()
        await page.getByLabel('Display name').fill('Just Looking')
        await page.getByRole('button', { name: 'Continue' }).click()
        await page.getByRole('button', { name: 'Continue' }).click()
        await expect(page.getByText('Connecting with people here')).toBeVisible()
        await expect(page.getByText('What fellow members here can see')).toHaveCount(0)
        await expect(page.getByRole('switch', { name: 'Show my messaging handle' })).toHaveCount(0)

        // The profile still saves; there was simply no membership to write switches to.
        await page.getByRole('button', { name: 'Save profile' }).click()
        await expect(page.getByText('Connecting with people here')).toBeHidden()
        expect(errors).toEqual([])
      } finally {
        await close()
      }
    } finally {
      await visitor.cleanup()
    }
  })

  test('the gathering onboarding asks for interests, looking-for, handle and the switches, and can be skipped', async ({ browser }) => {
    const newcomer = await createTestAccount('profile-new', { sql })
    try {
      await sql`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${newcomer.id}, 'attendee')`
      await sql`update profiles set onboarding_completed = false where id = ${newcomer.id}`
      const { page, errors, close } = await pageAs(browser, newcomer)
      try {
        await page.goto(`/e/${gathering.slug}/participants`)
        await page.getByRole('button', { name: 'Skip to your profile' }).click()
        await page.getByLabel('Display name').fill('Newly Arrived')
        await page.getByRole('button', { name: 'Continue' }).click()
        await page.getByRole('button', { name: 'Continue' }).click()

        // One step: interests, looking-for, the messaging handle and both sharing switches.
        await expect(page.getByText('Connecting with people here')).toBeVisible()
        await page.getByLabel('Add your own topic').fill('Worm bins')
        await page.getByRole('button', { name: 'Add topic' }).click()
        await page.getByLabel(/What are you looking for/).fill('A compost mentor')
        await page.getByLabel(/Messaging handle/).fill('newly_arrived')
        await page.getByRole('switch', { name: 'Show my email address' }).click()
        await page.getByRole('button', { name: 'Save profile' }).click()

        await expect(page.getByText('Connecting with people here')).toBeHidden()
        const [profile] = await sql<{ interests: string[]; looking_for: string; telegram: string }[]>`
          select interests, looking_for, telegram from profiles where id = ${newcomer.id}
        `
        expect(profile).toEqual({ interests: ['Worm bins'], looking_for: 'A compost mentor', telegram: 'newly_arrived' })
        await expect
          .poll(
            async () => {
              const [row] = await sql<{ share_email: boolean; share_contact: boolean }[]>`
                select share_email, share_contact from event_members
                where event_id = ${gathering.id} and user_id = ${newcomer.id}
              `
              return row
            },
            { timeout: 10_000 },
          )
          .toEqual({ share_email: true, share_contact: true })
        expect(errors).toEqual([])
      } finally {
        await close()
      }
    } finally {
      await newcomer.cleanup()
    }
  })
})
