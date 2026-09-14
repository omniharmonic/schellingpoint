import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'

// Member role management + invitation use limits. Mirrors creation-database.spec.ts:
// the service-key half only runs against a local Supabase instance.
loadEnvConfig(process.cwd(), true)

const base = 'http://127.0.0.1:3001'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.TEST_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const local = supabaseUrl
  ? ['127.0.0.1', 'localhost'].includes(new URL(supabaseUrl).hostname)
  : false

const EVENT_SLUG = 'ethboulder-2026'
const FAKE_USER = '00000000-0000-0000-0000-000000000000'

test('member role and removal endpoints reject unsigned requests', async ({ request }) => {
  const patch = await request.patch(`${base}/api/v1/events/${EVENT_SLUG}/members/${FAKE_USER}`, {
    data: { role: 'admin' },
  })
  expect(patch.status()).toBe(401)

  const del = await request.delete(`${base}/api/v1/events/${EVENT_SLUG}/members/${FAKE_USER}`)
  expect(del.status()).toBe(401)
})

test.describe('invitation use limits', () => {
  test.skip(!local, 'Invitation limit tests only run against local Supabase')

  const restHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }

  test('public preview reports exhausted once use_count reaches max_uses', async ({ request }) => {
    expect(serviceKey, 'TEST_SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required').not.toBe('')

    // Resolve the seeded event and one of its owners to satisfy created_by.
    const eventRes = await request.get(
      `${supabaseUrl}/rest/v1/events?slug=eq.${EVENT_SLUG}&select=id`,
      { headers: restHeaders }
    )
    expect(eventRes.ok()).toBe(true)
    const [event] = await eventRes.json()
    expect(event?.id).toBeTruthy()

    const ownerRes = await request.get(
      `${supabaseUrl}/rest/v1/event_members?event_id=eq.${event.id}&role=eq.owner&select=user_id&limit=1`,
      { headers: restHeaders }
    )
    expect(ownerRes.ok()).toBe(true)
    const [owner] = await ownerRes.json()
    expect(owner?.user_id).toBeTruthy()

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const createRes = await request.post(`${supabaseUrl}/rest/v1/event_invitations`, {
      headers: restHeaders,
      data: {
        event_id: event.id,
        email: null,
        role: 'attendee',
        expires_at: expiresAt,
        created_by: owner.user_id,
        max_uses: 1,
      },
    })
    expect(createRes.status(), await createRes.text()).toBe(201)
    const [invite] = await createRes.json()
    expect(invite?.id).toBeTruthy()
    expect(invite?.token).toBeTruthy()

    try {
      const fresh = await request.get(`${base}/api/v1/invitations/${invite.token}`)
      expect(fresh.ok()).toBe(true)
      const freshBody = await fresh.json()
      expect(freshBody.exhausted).toBe(false)
      expect(freshBody.max_uses).toBe(1)
      expect(freshBody.use_count).toBe(0)
      expect(freshBody.is_used).toBe(false)

      const bump = await request.patch(
        `${supabaseUrl}/rest/v1/event_invitations?id=eq.${invite.id}`,
        { headers: restHeaders, data: { use_count: 1 } }
      )
      expect(bump.ok(), await bump.text()).toBe(true)

      const spent = await request.get(`${base}/api/v1/invitations/${invite.token}`)
      expect(spent.ok()).toBe(true)
      const spentBody = await spent.json()
      expect(spentBody.exhausted).toBe(true)
      expect(spentBody.use_count).toBe(1)

      // Accepting an exhausted link must be refused before any auth-specific work
      // is reached; unsigned callers still get 401 (auth runs first).
      const accept = await request.post(`${base}/api/v1/invitations/${invite.token}/accept`)
      expect(accept.status()).toBe(401)
    } finally {
      const cleanup = await request.delete(
        `${supabaseUrl}/rest/v1/event_invitations?id=eq.${invite.id}`,
        { headers: restHeaders }
      )
      expect(cleanup.ok()).toBe(true)
    }
  })
})
