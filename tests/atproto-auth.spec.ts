import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'

// ATProto OAuth surface: metadata endpoints, the start route's validation,
// the callback's failure path and the unauthenticated `me` shape. A real
// consent round-trip needs a Bluesky account and is exercised by hand.
loadEnvConfig(process.cwd(), true)

const base = 'http://localhost:3001'
const configured = Boolean(process.env.ATPROTO_SESSION_SECRET && process.env.ATPROTO_CUSTODY_KEY)
const loopback = (() => {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_APP_URL || '')
    return u.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname)
  } catch {
    return true
  }
})()

test.describe('ATProto OAuth metadata', () => {
  test.skip(!configured, 'ATPROTO_SESSION_SECRET / ATPROTO_CUSTODY_KEY are not set')

  test('client metadata document names a loopback client with the write scope', async ({ request }) => {
    const res = await request.get(`${base}/oauth/client-metadata.json`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/json')
    expect(res.headers()['cache-control']).toContain('max-age=300')
    const body = await res.json()
    expect(body.scope).toBe('atproto transition:generic')
    expect(Array.isArray(body.redirect_uris)).toBe(true)
    expect(body.redirect_uris[0]).toContain('/oauth/callback')
    if (loopback) {
      expect(body.client_id).toContain('http://localhost')
      expect(body.token_endpoint_auth_method).toBe('none')
    } else {
      expect(body.client_id).toContain('/oauth/client-metadata.json')
      expect(body.token_endpoint_auth_method).toBe('private_key_jwt')
    }
  })

  test('jwks document is a key set (empty in loopback mode)', async ({ request }) => {
    const res = await request.get(`${base}/oauth/jwks.json`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.keys)).toBe(true)
    if (loopback) expect(body.keys).toHaveLength(0)
  })
})

test.describe('ATProto auth start', () => {
  test.skip(!configured, 'ATPROTO_SESSION_SECRET / ATPROTO_CUSTODY_KEY are not set')

  test('rejects a malformed handle', async ({ request }) => {
    const res = await request.get(`${base}/api/atproto/auth/start?handle=not%20a%20handle&purpose=signin`)
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('invalid_handle')
  })

  test('rejects a missing handle', async ({ request }) => {
    const res = await request.get(`${base}/api/atproto/auth/start?purpose=signin`)
    expect(res.status()).toBe(400)
  })

  test('rejects an unknown purpose', async ({ request }) => {
    const res = await request.get(`${base}/api/atproto/auth/start?handle=bsky.app&purpose=steal`)
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('invalid_purpose')
  })

  test('link is refused: one account is one DID, and every account already has one', async ({ request }) => {
    const res = await request.get(`${base}/api/atproto/auth/start?handle=bsky.app&purpose=link`)
    expect(res.status()).toBe(409)
  })

  test('gathering requires a signed-in member', async ({ request }) => {
    const res = await request.get(
      `${base}/api/atproto/auth/start?handle=bsky.app&purpose=gathering&event=00000000-0000-0000-0000-000000000000`,
    )
    expect(res.status()).toBe(401)
  })
})

test.describe('ATProto callback', () => {
  test.skip(!configured, 'ATPROTO_SESSION_SECRET / ATPROTO_CUSTODY_KEY are not set')

  test('garbage sends the browser to the login page with an atproto error', async ({ request }) => {
    const res = await request.get(`${base}/oauth/callback?code=nope&state=garbage&iss=https://example.invalid`, {
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    const location = res.headers()['location'] || ''
    expect(location).toContain('/login?error=atproto')
  })

  test('an empty callback is rejected the same way', async ({ request }) => {
    const res = await request.get(`${base}/oauth/callback`, { maxRedirects: 0 })
    expect(res.status()).toBe(302)
    expect(res.headers()['location'] || '').toContain('/login?error=atproto')
  })
})

test.describe('Login page', () => {
  test.skip(!configured, 'ATPROTO_SESSION_SECRET / ATPROTO_CUSTODY_KEY are not set')

  test('offers Sign in with Bluesky and the consent sentence', async ({ page }) => {
    await page.goto(`${base}/login`)
    const section = page.getByTestId('bluesky-signin')
    // The section appears once the client has asked /api/atproto/me whether ATProto is configured.
    await expect(section).toBeVisible({ timeout: 45_000 })
    await expect(section.getByPlaceholder('you.bsky.social')).toBeVisible()
    await expect(section).toContainText('permanently attached to this identity')
    await expect(section).toContainText('public on the open network')
    // The hard confirmation gates the button: no consent, no redirect.
    await section.getByPlaceholder('you.bsky.social').fill('not a handle')
    const submit = section.getByRole('button', { name: /continue with this account/i })
    await expect(submit).toBeDisabled()
    await section.getByTestId('bluesky-confirm').check()
    await expect(submit).toBeEnabled()
    // A malformed handle is refused before any network round-trip.
    await submit.click()
    await expect(page.locator('#login-error')).toContainText(/handle/i)
  })
})

test.describe('ATProto me', () => {
  test('unauthenticated GET reports configuration without an identity', async ({ request }) => {
    const res = await request.get(`${base}/api/atproto/me`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(configured)
    expect(body.linked).toBe(false)
    expect(body.did).toBeNull()
    expect(['confidential', 'loopback']).toContain(body.oauthMode)
  })

  test('PATCH and DELETE require a bearer token', async ({ request }) => {
    const patch = await request.patch(`${base}/api/atproto/me`, { data: { publish_proposals: true } })
    expect(patch.status()).toBe(401)
    const del = await request.delete(`${base}/api/atproto/me`)
    expect(del.status()).toBe(401)
  })

  test('logout is safe to call without a session', async ({ request }) => {
    const res = await request.post(`${base}/api/atproto/auth/logout`)
    expect(res.status()).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
