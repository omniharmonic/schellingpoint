import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { signInWithEmail } from './helpers/gathering'
import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  addressFromPublicKey,
  namehash,
  personalMessageHash,
  recoverPersonalSignAddress,
  toHex,
  resolveEnsAddress,
  ensRpcUrls,
} from '../src/app/api/me/ens/ens'
import { normalizeAvatarUrl, normalizeEnsName, normalizeTelegram, validateProfilePatch } from '../src/app/api/me/profile/validate'
import { SORTS, defaultSort, isSortKey, sortParticipants, type SortKey } from '../src/app/e/[slug]/people/sort'
import type { MemberCardData } from '../src/app/e/[slug]/people/shared'

// People, profiles, the members-only directory and the public AppView reads (work package G),
// against the running dev server (:3001, mail disabled) and the local stack (Postgres :55432,
// PDS :2583). Every account and gathering created here is removed afterwards.
loadEnvConfig(process.cwd(), true)

const base = process.env.PEOPLE_TEST_BASE_URL || 'http://localhost:3001'
const origin = new URL(base).origin
const databaseUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(databaseUrl && pdsUrl && pdsAdminPassword && process.env.ATPROTO_SESSION_SECRET)

const run = `${Date.now()}${Math.floor(Math.random() * 1e4)}`
const emailFor = (who: string) => `you+pkgg-${who}-${run}@example.test`

interface Person {
  email: string
  cookie: string
  id: string
  did: string
}

async function signIn(who: string): Promise<Person> {
  const email = emailFor(who)
  const cookie = await signInWithEmail(email, base)
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: cookie! } })).json()
  return { email, cookie: cookie!, id: me.user.id, did: me.user.did }
}

function get(path: string, who?: Person) {
  return fetch(`${base}${path}`, { headers: who ? { cookie: who.cookie } : {} })
}

function send(method: string, path: string, who: Person | undefined, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin, ...(who ? { cookie: who.cookie } : {}), ...headers },
    body: JSON.stringify(body),
  })
}

const fakeDid = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  return `did:plc:${Array.from(randomBytes(24), (b) => alphabet[b % 32]).join('')}`
}

const DID_PATTERN = /did:(?:plc|web):[A-Za-z0-9._:%-]+/g
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// ─────────────────────────────── pure checks (no server) ───────────────────────────────

test.describe('people primitives', () => {
  test('ENS namehash matches the EIP-137 vectors', () => {
    expect(toHex(namehash(''))).toBe('0'.repeat(64))
    expect(toHex(namehash('eth'))).toBe('93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae')
    expect(toHex(namehash('foo.eth'))).toBe('de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f')
  })

  test('personal_sign recovery returns the signer and rejects malformed signatures', () => {
    const key = secp256k1.utils.randomPrivateKey()
    const address = addressFromPublicKey(secp256k1.getPublicKey(key, false))
    const message = 'localhost asks you to verify an ENS name.\nNonce: 0123'
    const sig = secp256k1.sign(personalMessageHash(message), key)
    const hex = `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}`
    expect(recoverPersonalSignAddress(message, hex)).toBe(address)
    // Same signature over a different message recovers someone else.
    expect(recoverPersonalSignAddress(`${message}!`, hex)).not.toBe(address)
    expect(recoverPersonalSignAddress(message, '0x1234')).toBeNull()
    expect(recoverPersonalSignAddress(message, `${hex.slice(0, -2)}05`)).toBeNull()
  })

  test('profile validation normalizes and bounds input', () => {
    expect(normalizeTelegram('https://t.me/Some_User')).toEqual({ ok: true, value: 'Some_User' })
    expect(normalizeTelegram('@ab').ok).toBe(false)
    expect(normalizeEnsName(' Alice.ETH ')).toEqual({ ok: true, value: 'alice.eth' })
    expect(normalizeEnsName('ålice.eth').ok).toBe(false)
    expect(normalizeAvatarUrl('data:image/png;base64,AAA', { appOrigin: origin, current: null }).ok).toBe(false)
    expect(normalizeAvatarUrl('https://tracker.example/pixel.png', { appOrigin: origin, current: null }).ok).toBe(false)
    expect(normalizeAvatarUrl('/uploads/avatars/a.png', { appOrigin: origin, current: null }).ok).toBe(true)
    expect(normalizeAvatarUrl('/uploads/../etc/passwd', { appOrigin: origin, current: null }).ok).toBe(false)
    const unknown = validateProfilePatch({ is_admin: true }, { appOrigin: origin, currentAvatarUrl: null })
    expect(unknown).toMatchObject({ ok: false, field: 'is_admin' })
  })

  test('interests cap is 15: fifteen pass, sixteen are refused', () => {
    const topics = (n: number) => Array.from({ length: n }, (_, i) => `Topic ${i + 1}`)
    const ok = validateProfilePatch({ interests: topics(15) }, { appOrigin: origin, currentAvatarUrl: null })
    expect(ok).toMatchObject({ ok: true })
    expect((ok as { ok: true; value: { interests: string[] } }).value.interests).toHaveLength(15)

    const refused = validateProfilePatch({ interests: topics(16) }, { appOrigin: origin, currentAvatarUrl: null })
    expect(refused).toMatchObject({ ok: false, field: 'interests' })
    expect((refused as { ok: false; error: string }).error).toContain('15')
  })

  test('the People sort orders by overlap, name, join date and role', () => {
    const person = (over: Partial<MemberCardData> & { id: string }): MemberCardData => ({
      did: `did:plc:${over.id}`,
      handle: null,
      display_name: null,
      avatar_url: null,
      affiliation: null,
      bio: null,
      building: null,
      interests: null,
      telegram: null,
      ens: null,
      role: 'attendee',
      is_self: false,
      ...over,
    })
    const zoe = person({ id: 'z', display_name: 'Zoe', role: 'attendee', joined_at: '2026-09-01T00:00:00Z' })
    const abe = person({ id: 'a', display_name: 'Abe', role: 'owner', joined_at: '2026-09-03T00:00:00Z' })
    const mia = person({ id: 'm', display_name: 'Mia', role: 'volunteer', joined_at: '2026-09-02T00:00:00Z' })
    const list = [zoe, abe, mia]
    const overlap = new Map([['m', 3], ['z', 1]])

    const ids = (sort: SortKey) => sortParticipants(list, sort, overlap).map((p) => p.id)
    expect(ids('name')).toEqual(['a', 'm', 'z'])
    expect(ids('joined')).toEqual(['a', 'm', 'z'])
    expect(ids('role')).toEqual(['a', 'm', 'z'])
    // Mia shares three of the viewer's interests, Zoe one, Abe none; ties fall back to name.
    expect(ids('shared')).toEqual(['m', 'z', 'a'])
    // Sorting never mutates the list it was handed.
    expect(list.map((p) => p.id)).toEqual(['z', 'a', 'm'])
    // Overlap is the default only when the viewer has interests of their own to match on.
    expect(defaultSort(true)).toBe('shared')
    expect(defaultSort(false)).toBe('name')
    expect(isSortKey('joined')).toBe(true)
    expect(isSortKey('votes')).toBe(false)
    expect(Object.keys(SORTS)).toEqual(['shared', 'name', 'joined', 'role'])
  })
})

// ─────────────────────────────── against the dev server ───────────────────────────────

test.describe('people API', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })
  test.skip(!configured, 'DATABASE_URL / PDS_URL / PDS_ADMIN_PASSWORD / ATPROTO_SESSION_SECRET are not set')

  let sql: postgres.Sql
  let alice: Person // member of both gatherings
  let bob: Person // member of the private gathering; host of the published session
  let stranger: Person // member of nothing
  const privateSlug = `people-private-${run}`
  const publicSlug = `people-public-${run}`
  let privateEventId = ''
  let publicEventId = ''
  const gatheringDid = fakeDid()
  const cohostDid = fakeDid()

  test.beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 2, onnotice: () => {} })
    ;[alice, bob, stranger] = await Promise.all([signIn('alice'), signIn('bob'), signIn('stranger')])

    const [priv] = await sql<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, created_by)
      values (${privateSlug}, 'People private', current_date, current_date + 1, 'proposals_open', 'private', ${alice.id})
      returning id
    `
    const [pub] = await sql<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, created_by, actor_did, gathering_uri)
      values (${publicSlug}, 'People public', current_date, current_date + 1, 'live', 'public', ${alice.id},
              ${gatheringDid}, ${`at://${gatheringDid}/schellingpoint.draft.gathering/self`})
      returning id
    `
    privateEventId = priv.id
    publicEventId = pub.id
    await sql`
      insert into event_members (event_id, user_id, role) values
        (${privateEventId}, ${alice.id}, 'owner'),
        (${privateEventId}, ${bob.id}, 'attendee'),
        (${publicEventId}, ${alice.id}, 'owner')
    `
  })

  test.afterAll(async () => {
    if (!sql) return
    await sql`delete from events where slug in ${sql([privateSlug, publicSlug])}`
    const people = [alice, bob, stranger].filter(Boolean)
    for (const p of people) {
      const res = await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`,
        },
        body: JSON.stringify({ did: p.did }),
      })
      expect(res.ok, `PDS deleteAccount ${p.did}`).toBe(true)
    }
    await sql`delete from accounts where email like ${`you+pkgg-%-${run}@example.test`}`
    await sql`delete from auth_email_tokens where email like ${`you+pkgg-%-${run}@example.test`}`
    await sql.end()
  })

  test('profile update round trip', async () => {
    const patch = await send('PATCH', '/api/me/profile', alice, {
      display_name: '  Alice Example ',
      bio: 'Line one\nLine two',
      affiliation: 'Commons Lab',
      building: 'A shared calendar',
      telegram: '@alice_example',
      interests: ['Governance', 'governance', ' Open  Source '],
      onboarding_completed: true,
    })
    const patched = await patch.json()
    expect(patch.status, JSON.stringify(patched)).toBe(200)
    expect(patched.profile).toMatchObject({
      display_name: 'Alice Example',
      bio: 'Line one\nLine two',
      affiliation: 'Commons Lab',
      building: 'A shared calendar',
      telegram: 'alice_example',
      interests: ['Governance', 'Open Source'],
      onboarding_completed: true,
      did: alice.did,
    })

    const read = await (await get('/api/me/profile', alice)).json()
    expect(read.profile).toEqual(patched.profile)

    // A partial update leaves every other field alone.
    const partial = await (await send('PATCH', '/api/me/profile', alice, { affiliation: null })).json()
    expect(partial.profile.affiliation).toBeNull()
    expect(partial.profile.telegram).toBe('alice_example')

    const tooLong = await send('PATCH', '/api/me/profile', alice, { display_name: 'x'.repeat(81) })
    expect(tooLong.status).toBe(400)
    expect((await tooLong.json()).field).toBe('display_name')
    const readOnly = await send('PATCH', '/api/me/profile', alice, { email: 'x@example.com' })
    expect(readOnly.status).toBe(400)
    const dataUrl = await send('PATCH', '/api/me/profile', alice, { avatar_url: 'data:image/png;base64,AAAA' })
    expect(dataUrl.status).toBe(400)

    expect((await get('/api/me/profile')).status).toBe(401)
  })

  test('cross-origin PATCH is refused and changes nothing', async () => {
    const res = await send('PATCH', '/api/me/profile', alice, { display_name: 'Mallory' }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    const fetchSite = await send('PATCH', '/api/me/profile', alice, { display_name: 'Mallory' }, { 'sec-fetch-site': 'cross-site' })
    expect(fetchSite.status).toBe(403)
    const [row] = await sql<{ display_name: string }[]>`select display_name from profiles where id = ${alice.id}`
    expect(row.display_name).toBe('Alice Example')
  })

  test('the private directory is 404 to strangers and signed-out visitors', async () => {
    expect((await get(`/api/v1/events/${privateSlug}/participants`, stranger)).status).toBe(404)
    expect((await get(`/api/v1/events/${privateSlug}/participants`)).status).toBe(404)
    expect((await get(`/api/v1/events/${privateSlug}/participants/me`, stranger)).status).toBe(404)
  })

  test('a public gathering still keeps its roster members-only', async () => {
    expect((await get(`/api/v1/events/${publicSlug}/participants`)).status).toBe(401)
    expect((await get(`/api/v1/events/${publicSlug}/participants`, stranger)).status).toBe(403)
    expect((await get(`/api/v1/events/${publicSlug}/participants`, alice)).status).toBe(200)
  })

  test('members see fellow members with Telegram, never email, ENS only verified and opted in', async () => {
    await send('PATCH', '/api/me/profile', bob, { display_name: 'Bob Builder', telegram: 'bob_builder' })
    await sql`update profiles set ens = 'bob.eth', ens_verified_at = null, show_ens = true where id = ${bob.id}`

    const res = await get(`/api/v1/events/${privateSlug}/participants`, alice)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.me).toMatchObject({ role: 'owner', directory_listing: true, public_role: false })
    const bobCard = body.participants.find((p: { did: string }) => p.did === bob.did)
    expect(bobCard).toMatchObject({ display_name: 'Bob Builder', telegram: 'bob_builder', ens: null, role: 'attendee', is_self: false })
    // `email` is a key, but null until its holder shares it in this gathering (design §3.3): the
    // address itself never appears in the payload.
    expect(bobCard.email).toBeNull()
    expect(text.match(EMAIL_PATTERN)).toBeNull()
    expect(text).not.toContain('bob.eth') // unverified

    await sql`update profiles set ens_verified_at = now(), show_ens = false where id = ${bob.id}`
    expect(await (await get(`/api/v1/events/${privateSlug}/participants`, alice)).text()).not.toContain('bob.eth') // not opted in

    await sql`update profiles set show_ens = true where id = ${bob.id}`
    const shown = await (await get(`/api/v1/events/${privateSlug}/participants`, alice)).json()
    expect(shown.participants.find((p: { did: string }) => p.did === bob.did).ens).toBe('bob.eth')

    // Changing the name clears its verification.
    await send('PATCH', '/api/me/profile', bob, { ens: 'robert.eth' })
    const [row] = await sql<{ ens: string; ens_verified_at: string | null }[]>`select ens, ens_verified_at from profiles where id = ${bob.id}`
    expect(row).toEqual({ ens: 'robert.eth', ens_verified_at: null })
  })

  test('GET /api/v1/members/<did>: 404 to a stranger, 200 with Telegram to a co-member', async () => {
    const strangerView = await get(`/api/v1/members/${bob.did}`, stranger)
    expect(strangerView.status).toBe(404)
    expect(await strangerView.text()).not.toContain('bob_builder')
    expect((await get(`/api/v1/members/${bob.did}`)).status).toBe(401)
    expect((await get(`/api/v1/members/${fakeDid()}`, alice)).status).toBe(404)
    expect((await get(`/api/v1/members/not-a-did`, alice)).status).toBe(404)

    const coMember = await get(`/api/v1/members/${bob.did}`, alice)
    expect(coMember.status).toBe(200)
    const body = await coMember.json()
    expect(body.member).toMatchObject({ did: bob.did, telegram: 'bob_builder' })
    // `email` is present but null: bob has not shared it in the gathering they have in common.
    expect(body.member.email).toBeNull()
    // Only gatherings both belong to: not alice's public gathering, which bob is not in.
    expect(body.gatherings.map((g: { slug: string }) => g.slug)).toEqual([privateSlug])

    const self = await get(`/api/v1/members/${stranger.did}`, stranger)
    expect(self.status).toBe(200)
  })

  test('email reaches fellow members only with share_email, and only in that gathering', async () => {
    // Default off: bob's address is nowhere in the directory, and `email` is explicitly null so the
    // UI can tell "not shared" from "an older server that never sends it".
    const before = await get(`/api/v1/events/${privateSlug}/participants`, alice)
    const beforeText = await before.text()
    expect(beforeText).not.toContain(bob.email)
    const beforeCard = JSON.parse(beforeText).participants.find((p: { did: string }) => p.did === bob.did)
    expect(beforeCard.email).toBeNull()

    const on = await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { share_email: true })
    const onBody = await on.json()
    expect(on.status, JSON.stringify(onBody)).toBe(200)
    expect(onBody).toMatchObject({ share_email: true, share_contact: true, has_email: true })

    const shared = await (await get(`/api/v1/events/${privateSlug}/participants`, alice)).json()
    expect(shared.participants.find((p: { did: string }) => p.did === bob.did).email).toBe(bob.email)
    expect(shared.me).toMatchObject({ share_email: false, share_contact: true })

    // The per-gathering card the profile page reads agrees, and carries only this gathering's
    // sessions plus the switches of THIS gathering.
    const card = await get(`/api/v1/events/${privateSlug}/participants/${bob.did}`, alice)
    const cardBody = await card.json()
    expect(card.status, JSON.stringify(cardBody)).toBe(200)
    expect(cardBody.member).toMatchObject({ did: bob.did, email: bob.email, telegram: 'bob_builder', bluesky: false })
    expect(Array.isArray(cardBody.sessions)).toBe(true)

    // A stranger — not a member of this gathering — gets 404, and no trace of the address.
    const outsider = await get(`/api/v1/events/${privateSlug}/participants/${bob.did}`, stranger)
    expect(outsider.status).toBe(404)
    expect(await outsider.text()).not.toContain(bob.email)
    expect((await get(`/api/v1/events/${privateSlug}/participants/${bob.did}`)).status).toBe(404)

    // Alice is a member of the public gathering; bob is not. Nothing of his is reachable there.
    const elsewhere = await get(`/api/v1/events/${publicSlug}/participants/${bob.did}`, alice)
    expect(elsewhere.status).toBe(404)
    expect(await elsewhere.text()).not.toContain(bob.email)

    // Turning the switch off hides it again on the next read.
    await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { share_email: false })
    expect(await (await get(`/api/v1/events/${privateSlug}/participants`, alice)).text()).not.toContain(bob.email)

    // And the messaging handle has its own switch, on by default.
    await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { share_contact: false })
    const hidden = await (await get(`/api/v1/events/${privateSlug}/participants`, alice)).json()
    expect(hidden.participants.find((p: { did: string }) => p.did === bob.did).telegram).toBeNull()
    // His own card obeys the same switches: the page tells him what members here see, so with
    // sharing off it shows him nothing either.
    const own = await (await get(`/api/v1/events/${privateSlug}/participants/${bob.did}`, bob)).json()
    expect(own.member).toMatchObject({ telegram: null, email: null, is_self: true })
    await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { share_contact: true })
    const shown = await (await get(`/api/v1/events/${privateSlug}/participants/${bob.did}`, bob)).json()
    expect(shown.member).toMatchObject({ telegram: 'bob_builder', email: null })

    // The switches are the member's own: `role` is still refused, and so is a cross-site PATCH.
    expect((await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { share_email: 'yes' })).status).toBe(400)
    expect(
      (await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { share_email: true }, { origin: 'https://evil.example' })).status,
    ).toBe(403)
  })

  test('the profile route answers 404 to a non-member of a private gathering', async () => {
    // The page itself is a client component: the members-only answer is the API's, and the HTML a
    // non-member is served must carry nothing about the person.
    const api = await get(`/api/v1/events/${privateSlug}/participants/${bob.did}`, stranger)
    expect(api.status).toBe(404)
    const page = await get(`/e/${privateSlug}/people/${encodeURIComponent(bob.did)}`, stranger)
    const html = await page.text()
    for (const secret of ['Bob Builder', 'bob_builder', bob.email, bob.id]) {
      expect(html, `the profile page leaks ${secret} to a non-member`).not.toContain(secret)
    }
    // A DID that is not a member here, and one that is not a DID at all, answer the same way.
    expect((await get(`/api/v1/events/${privateSlug}/participants/${fakeDid()}`, alice)).status).toBe(404)
    expect((await get(`/api/v1/events/${privateSlug}/participants/not-a-did`, alice)).status).toBe(404)
    // `…/participants/me` is a sibling of `[did]` and still its own route.
    expect((await get(`/api/v1/events/${privateSlug}/participants/me`, alice)).status).toBe(200)
  })

  test('directory opt-out hides a member from the list and their card', async () => {
    const hide = await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { directory_listing: false })
    expect(hide.status).toBe(200)
    expect((await hide.json()).directory_listing).toBe(false)

    const list = await (await get(`/api/v1/events/${privateSlug}/participants`, alice)).json()
    expect(list.participants.map((p: { did: string }) => p.did)).not.toContain(bob.did)
    expect((await get(`/api/v1/members/${bob.did}`, alice)).status).toBe(404)
    const own = await (await get(`/api/v1/events/${privateSlug}/participants`, bob)).json()
    expect(own.participants.map((p: { did: string }) => p.did)).toContain(bob.did)

    const bad = await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { role: 'owner' })
    expect(bad.status).toBe(400)
    const crossSite = await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { directory_listing: true }, { origin: 'https://evil.example' })
    expect(crossSite.status).toBe(403)

    const on = await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { directory_listing: true, public_role: true })
    const onBody = await on.json()
    expect(on.status, JSON.stringify(onBody)).toBe(200)
    expect(onBody).toMatchObject({ directory_listing: true, public_role: true })
    // The private test gathering is not on the network and its policy keeps role publishing off:
    // the opt-in is stored, nothing is published.
    expect(['policy-off', 'not-linked', 'role-too-low']).toContain(onBody.role_claim?.status)
    const [stored] = await sql<{ public_role: boolean }[]>`select public_role from event_members where event_id = ${privateEventId} and user_id = ${bob.id}`
    expect(stored.public_role).toBe(true)
    const [claims] = await sql<{ n: number }[]>`select count(*)::int as n from role_claims where event_id = ${privateEventId}`
    expect(claims.n).toBe(0)

    const off = await (await send('PATCH', `/api/v1/events/${privateSlug}/participants/me`, bob, { public_role: false })).json()
    expect(off).toMatchObject({ public_role: false })
  })

  test('interest suggestions come from gatherings the viewer belongs to', async () => {
    await sql`update events set suggested_topics = ${sql.array(['Mutual Aid', 'Soil'])} where id = ${privateEventId}`
    const mine = await (await get(`/api/me/profile/interests?event=${privateSlug}`, bob)).json()
    expect(mine.suggested).toEqual(['Mutual Aid', 'Soil'])
    expect(mine.existing).toEqual(expect.arrayContaining(['Governance', 'Open Source']))

    const outsider = await (await get(`/api/me/profile/interests?event=${privateSlug}`, stranger)).json()
    expect(outsider).toEqual({ suggested: [], existing: [] })
  })

  test('the shared-key profiles endpoints are gone', async () => {
    for (const path of ['/api/v1/profiles', `/api/v1/profiles?event=${publicSlug}`, `/api/v1/profiles/${alice.id}`]) {
      // The header is meaningless now: no route reads a key at all (spec §2).
      const res = await fetch(`${base}${path}`, { headers: { 'x-api-key': 'anything' } })
      expect(res.status, path).toBe(410)
      const text = await res.text()
      expect(text).not.toContain('alice_example')
    }
  })

  test('public schedule serves only published records and names only their authors', async () => {
    const venueUri = `at://${gatheringDid}/schellingpoint.draft.venue/v1`
    await sql.begin(async (t) => {
      // Fixtures as if package F had published them; skip app triggers (notifications, proposal rules).
      await t`set local session_replication_role = replica`
      const [venue] = await t<{ id: string }[]>`
        insert into venues (event_id, name, slug, capacity, address, notes, at_uri, at_cid, locality)
        values (${publicEventId}, 'Main Hall', 'main-hall', 80, '12 Private Lane', 'Door code 4321', ${venueUri}, 'cid-v', 'Boulder')
        returning id
      `
      await t`insert into venues (event_id, name, slug) values (${publicEventId}, 'Unpublished Room', 'unpublished-room')`
      const [track] = await t<{ id: string }[]>`
        insert into tracks (event_id, name, slug, lead_name, lead_email, at_uri, at_cid)
        values (${publicEventId}, 'Commons', 'commons', 'Lead Person', 'lead@example.com', ${`at://${gatheringDid}/schellingpoint.draft.track/t1`}, 'cid-t')
        returning id
      `
      const [slot] = await t<{ id: string }[]>`
        insert into time_slots (event_id, venue_id, day_date, start_time, end_time, label)
        values (${publicEventId}, ${venue.id}, current_date, now(), now() + interval '1 hour', 'Morning')
        returning id
      `
      await t`
        insert into at_slot_grids (event_id, venue_id, day_date, uri, cid)
        values (${publicEventId}, ${venue.id}, current_date, ${`at://${gatheringDid}/schellingpoint.draft.slotGrid/g1`}, 'cid-g')
      `
      const [published] = await t<{ id: string }[]>`
        insert into sessions (event_id, title, description, format, duration, host_id, host_did, host_name, status,
                              time_slot_id, venue_id, track_id, telegram_group_url, custom_location,
                              proposal_uri, calendar_event_uri, slot_uri)
        values (${publicEventId}, 'Published Session', 'About commons', 'talk', 60, ${bob.id}, ${bob.did}, 'Secret Host Name', 'scheduled',
                ${slot.id}, ${venue.id}, ${track.id}, 'https://t.me/+secretgroup', 'Back room behind the bar',
                ${`at://${bob.did}/schellingpoint.draft.proposal/p1`},
                ${`at://${gatheringDid}/community.lexicon.calendar.event/e1`},
                ${`at://${gatheringDid}/schellingpoint.draft.slot/s1`})
        returning id
      `
      await t`insert into session_cohosts (session_id, user_id, event_id, cohost_uri) values (${published.id}, ${alice.id}, ${publicEventId}, ${`at://${cohostDid}/schellingpoint.draft.cohost/c1`})`
      await t`
        insert into sessions (event_id, title, format, duration, host_id, host_did, status, time_slot_id)
        values (${publicEventId}, 'Unpublished Session', 'talk', 30, ${alice.id}, ${alice.did}, 'scheduled', ${slot.id})
      `
    })

    const res = await fetch(`${base}/api/v1/schedule?event=${publicSlug}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const text = await res.text()
    const body = JSON.parse(text)

    expect(body.data.gathering).toMatchObject({ slug: publicSlug, did: gatheringDid })
    const sessions = body.data.days.flatMap((d: { slots: { sessions: unknown[] }[] }) => d.slots.flatMap((s) => s.sessions))
    expect(sessions.map((s: { title: string }) => s.title)).toEqual(['Published Session'])
    expect(sessions[0].host).toEqual({ did: bob.did, handle: expect.any(String) })
    expect(sessions[0].track).toMatchObject({ name: 'Commons' })
    expect(sessions[0].venue).toMatchObject({ name: 'Main Hall' })

    const dids = new Set(text.match(DID_PATTERN) ?? [])
    for (const did of dids) expect([gatheringDid, bob.did], `unexpected DID ${did}`).toContain(did)
    expect(text.match(EMAIL_PATTERN)).toBeNull()
    for (const secret of ['bob_builder', 'alice_example', 'telegram', 't.me', 'Secret Host Name', 'Back room', 'Lead Person',
      '12 Private Lane', 'Door code', 'Unpublished', alice.id, bob.id, 'total_votes', 'robert.eth']) {
      expect(text, `schedule leaks ${secret}`).not.toContain(secret)
    }

    // The collection reads follow the same rule.
    const venues = await (await fetch(`${base}/api/v1/venues?event=${publicSlug}`)).json()
    expect(venues.data.map((v: { name: string }) => v.name)).toEqual(['Main Hall'])
    expect(JSON.stringify(venues)).not.toContain('Private Lane')
    const tracks = await fetch(`${base}/api/v1/tracks?event=${publicSlug}`)
    const tracksText = await tracks.text()
    expect(tracks.headers.get('cache-control')).toBe('public, max-age=60')
    expect(tracksText).toContain('Commons')
    expect(tracksText).not.toContain('Lead Person')
    expect(tracksText).not.toContain('lead@example.com')
    const slots = await (await fetch(`${base}/api/v1/timeslots?event=${publicSlug}&include=venue`)).json()
    expect(slots.count).toBe(1)

    // Private gatherings, and a missing event parameter, are not served.
    expect((await fetch(`${base}/api/v1/schedule?event=${privateSlug}`)).status).toBe(404)
    expect((await fetch(`${base}/api/v1/schedule`)).status).toBe(400)
  })

  test('ENS verification rejects bad signatures', async () => {
    const noChallenge = await send('POST', '/api/me/ens/verify', alice, { name: 'vitalik.eth', signature: `0x${'11'.repeat(65)}` })
    expect(noChallenge.status).toBe(400)

    expect((await send('POST', '/api/me/ens/challenge', alice, { name: 'not a name' })).status).toBe(400)
    const crossSite = await send('POST', '/api/me/ens/challenge', alice, { name: 'vitalik.eth' }, { origin: 'https://evil.example' })
    expect(crossSite.status).toBe(403)

    const challengeRes = await send('POST', '/api/me/ens/challenge', alice, { name: 'Vitalik.eth' })
    const challenge = await challengeRes.json()
    expect(challengeRes.status, JSON.stringify(challenge)).toBe(200)
    expect(challenge.name).toBe('vitalik.eth')
    expect(challenge.message).toContain(alice.did)
    expect(challenge.message).toContain(challenge.nonce)

    const malformed = await send('POST', '/api/me/ens/verify', alice, { name: 'vitalik.eth', signature: '0xdeadbeef' })
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('bad_signature')

    const wrongName = await send('POST', '/api/me/ens/verify', alice, { name: 'other.eth', signature: `0x${'11'.repeat(65)}` })
    expect(wrongName.status).toBe(400)

    // A well-formed signature over the challenge by a key that does not own the name.
    const key = secp256k1.utils.randomPrivateKey()
    const sig = secp256k1.sign(personalMessageHash(challenge.message), key)
    const signature = `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}`
    const wrongSigner = await send('POST', '/api/me/ens/verify', alice, { name: 'vitalik.eth', signature })
    const verdict = await wrongSigner.json()
    if (wrongSigner.status === 503) {
      test.info().annotations.push({ type: 'skip-network', description: 'Ethereum RPC unreachable; signer check not exercised' })
    } else {
      expect(wrongSigner.status, JSON.stringify(verdict)).toBe(400)
      expect(verdict.code).toBe('signer_mismatch')
    }

    const [row] = await sql<{ ens: string | null; ens_verified_at: string | null }[]>`select ens, ens_verified_at from profiles where id = ${alice.id}`
    expect(row.ens_verified_at).toBeNull()
    expect(row.ens).not.toBe('vitalik.eth')
  })

  test('ENS resolution reads the registry over JSON-RPC', async () => {
    let address: string
    try {
      address = await resolveEnsAddress('vitalik.eth', { rpcUrls: ensRpcUrls() })
    } catch (e) {
      test.skip(true, `Ethereum RPC unreachable: ${e instanceof Error ? e.message : e}`)
      return
    }
    expect(address).toBe('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
  })
})
