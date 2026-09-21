import { test, expect } from '@playwright/test'
import postgres from 'postgres'
import { createTestAccount, TEST_BASE_URL, withServerOnlyShim } from './helpers/gathering'

const local = process.env.DATABASE_MIGRATION_URL
if (!local || !['localhost', '127.0.0.1'].includes(new URL(local).hostname)) throw new Error('Profile tests require the isolated local stack')

type ProfileModule = typeof import('../src/lib/atproto/bsky-profile')
const loadModule = () => withServerOnlyShim(() => require('../src/lib/atproto/bsky-profile') as ProfileModule)

async function patchProfile(cookie: string, body: Record<string, unknown>) {
  return fetch(`${TEST_BASE_URL}/api/me/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie, origin: TEST_BASE_URL },
    body: JSON.stringify(body),
  })
}

test('Bluesky import fills missing profile fields, preserves edits, and rejects another DID', async () => {
  const db = postgres(local, { max: 2, onnotice: () => {} })
  const account = await createTestAccount('profile-import', { sql: db })
  try {
    const { applyBskyProfile } = await loadModule()
    const [identity] = await db`select did from accounts where id = ${account.id}`
    await db`update profiles set display_name = 'placeholder', bio = null, interests = array['community gardens'] where id = ${account.id}`
    const remote = { did: identity.did, handle: 'local.example.test', displayName: 'Garden Host', description: 'Growing things together.', avatar: null }
    const first = await applyBskyProfile(account.id, remote, { placeholderName: 'placeholder' })
    expect(first).toMatchObject({ fetched: true, updated: ['display_name', 'bio'], synced: ['display_name', 'bio'] })
    let [profile] = await db`select display_name, bio, interests, synced_fields, profile_synced_at from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Garden Host', bio: 'Growing things together.', interests: ['community gardens'], synced_fields: ['display_name', 'bio'] })
    expect(profile.profile_synced_at).not.toBeNull()

    // An edit made in the app (through PATCH) makes those fields local: the next refresh leaves them alone.
    const patched = await patchProfile(account.cookie, { display_name: 'My chosen name', bio: 'My edited bio' })
    expect(patched.status).toBe(200)
    ;[profile] = await db`select synced_fields from profiles where id = ${account.id}`
    expect(profile.synced_fields).toEqual([])
    const second = await applyBskyProfile(account.id, { ...remote, displayName: 'Different remote name', description: 'Different remote bio' })
    expect(second.updated).toEqual([])
    ;[profile] = await db`select display_name, bio, synced_fields from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'My chosen name', bio: 'My edited bio', synced_fields: [] })

    // A blank field is network-owned again.
    await db`update profiles set bio = null where id = ${account.id}`
    const third = await applyBskyProfile(account.id, { ...remote, description: 'Filled back in' })
    expect(third).toMatchObject({ updated: ['bio'], synced: ['bio'] })

    // Another DID writes nothing.
    await db`update profiles set bio = null, synced_fields = '{}' where id = ${account.id}`
    const foreign = await applyBskyProfile(account.id, { ...remote, did: 'did:plc:not-the-signed-in-person' })
    expect(foreign).toMatchObject({ fetched: false, updated: [] })
    expect((await db`select bio from profiles where id = ${account.id}`)[0].bio).toBeNull()
  } finally { await account.cleanup(); await db.end() }
})

test('a synced field follows the network; a re-sync overrides local edits and rebuilds synced_fields', async () => {
  const db = postgres(local, { max: 2, onnotice: () => {} })
  const account = await createTestAccount('profile-sync', { sql: db })
  try {
    const { applyBskyProfile } = await loadModule()
    const [identity] = await db`select did from accounts where id = ${account.id}`
    await db`update profiles set display_name = null, bio = null, synced_fields = '{}' where id = ${account.id}`
    const remote = { did: identity.did, handle: 'sync.example.test', displayName: 'First name', description: 'First bio', avatar: null }
    await applyBskyProfile(account.id, remote)

    // Still network-owned: a changed network value overwrites.
    const refreshed = await applyBskyProfile(account.id, { ...remote, displayName: 'Renamed on Bluesky' })
    expect(refreshed).toMatchObject({ updated: ['display_name'], synced: ['display_name', 'bio'] })
    let [profile] = await db`select display_name, bio, synced_fields from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Renamed on Bluesky', bio: 'First bio' })

    // A PATCH that repeats the current value (an onboarding form submitted unchanged) keeps the field synced;
    // one that changes it makes only that field local.
    expect((await patchProfile(account.cookie, { display_name: 'Renamed on Bluesky', bio: 'First bio', onboarding_completed: true })).status).toBe(200)
    ;[profile] = await db`select synced_fields from profiles where id = ${account.id}`
    expect(profile.synced_fields.sort()).toEqual(['bio', 'display_name'])
    expect((await patchProfile(account.cookie, { bio: 'Written here' })).status).toBe(200)
    ;[profile] = await db`select synced_fields from profiles where id = ${account.id}`
    expect(profile.synced_fields).toEqual(['display_name'])

    // Refresh: the local bio survives, the synced name follows the network, the set is unchanged.
    await applyBskyProfile(account.id, { ...remote, displayName: 'Third name', description: 'Third bio' })
    ;[profile] = await db`select display_name, bio, synced_fields from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Third name', bio: 'Written here', synced_fields: ['display_name'] })

    // Re-sync (force): every field the network has a value for is re-imported and becomes synced again.
    const resynced = await applyBskyProfile(account.id, { ...remote, displayName: 'Third name', description: 'Third bio' }, { force: true })
    expect(resynced).toMatchObject({ updated: ['bio'], synced: ['display_name', 'bio'] })
    ;[profile] = await db`select display_name, bio, synced_fields from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Third name', bio: 'Third bio', synced_fields: ['display_name', 'bio'] })

    // A forced re-sync when the network has no bio: the local bio is kept but is no longer marked synced.
    const partial = await applyBskyProfile(account.id, { ...remote, displayName: 'Third name', description: null }, { force: true })
    expect(partial.synced).toEqual(['display_name'])
    ;[profile] = await db`select bio from profiles where id = ${account.id}`
    expect(profile.bio).toBe('Third bio')
  } finally { await account.cleanup(); await db.end() }
})

test('the re-sync endpoint is same-origin, signed-in and OAuth-only; the identity route reports sync state', async () => {
  const db = postgres(local, { max: 2, onnotice: () => {} })
  const account = await createTestAccount('profile-resync', { sql: db })
  try {
    const anon = await fetch(`${TEST_BASE_URL}/api/atproto/me/resync`, { method: 'POST', headers: { origin: TEST_BASE_URL } })
    expect(anon.status).toBe(401)
    const crossSite = await fetch(`${TEST_BASE_URL}/api/atproto/me/resync`, { method: 'POST', headers: { cookie: account.cookie, origin: 'https://evil.example' } })
    expect(crossSite.status).toBe(403)
    // A custodial account has no network profile to import from.
    const custodial = await fetch(`${TEST_BASE_URL}/api/atproto/me/resync`, { method: 'POST', headers: { cookie: account.cookie, origin: TEST_BASE_URL } })
    expect(custodial.status).toBe(409)
    expect(await custodial.json()).toMatchObject({ code: 'not_oauth' })

    const me = await fetch(`${TEST_BASE_URL}/api/atproto/me`, { headers: { cookie: account.cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ linked: true, syncedFields: [], profileSyncedAt: null })

    // The stale Bluesky CDN allowance is gone: only uploads served here are accepted.
    const cdn = await patchProfile(account.cookie, { avatar_url: 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafy@jpeg' })
    expect(cdn.status).toBe(400)
  } finally { await account.cleanup(); await db.end() }
})

test('the gathering profile record is text-only, within the lexicon limits, and carries no unknown fields', async () => {
  const { buildGatheringProfileRecord, clampGraphemes, assertNoForeignDid } = await withServerOnlyShim(
    () => require('../src/lib/atproto/records') as typeof import('../src/lib/atproto/records'),
  )
  const { assertValidRecord, assertNoUnknownFields } = await withServerOnlyShim(
    () => require('../src/lib/atproto/validate') as typeof import('../src/lib/atproto/validate'),
  )
  const { NSID, isBorrowedNsid } = require('../src/lib/atproto/nsids') as typeof import('../src/lib/atproto/nsids')
  expect(isBorrowedNsid(NSID.actorProfile)).toBe(true)

  const long = '🧑‍🌾'.repeat(400) + 'x'.repeat(3000)
  const record = buildGatheringProfileRecord({
    name: `Front Range Unconference ${long}`,
    tagline: null,
    description: `A weekend of open sessions. ${long}`,
    createdAt: '2026-09-01T00:00:00.000Z',
  })
  expect(record.$type).toBe(NSID.actorProfile)
  expect(record.createdAt).toBe('2026-09-01T00:00:00.000Z')
  expect(Object.keys(record).sort()).toEqual(['$type', 'createdAt', 'description', 'displayName'])
  expect(() => assertValidRecord(NSID.actorProfile, record)).not.toThrow()
  expect(() => assertNoUnknownFields(NSID.actorProfile, record)).not.toThrow()
  expect(() => assertNoForeignDid(record, 'did:plc:gathering000000000000000')).not.toThrow()
  expect(clampGraphemes('a👩‍👩‍👧‍👦b', 2)).toBe('a👩‍👩‍👧‍👦')
  expect(clampGraphemes('👩‍👩‍👧‍👦👩‍👩‍👧‍👦', 5, 30)).toBe('👩‍👩‍👧‍👦')

  // Tagline wins over description; both blank leaves description out.
  expect(buildGatheringProfileRecord({ name: 'Small', tagline: '  One line  ', description: 'Longer text' }).description).toBe('One line')
  expect(buildGatheringProfileRecord({ name: 'Small', tagline: '', description: null })).toEqual({ $type: NSID.actorProfile, displayName: 'Small' })
})
