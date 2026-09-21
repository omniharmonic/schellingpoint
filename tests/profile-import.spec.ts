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

/* ───────────── custodial profile record (release design §5.5) + hourly refresh (§5.2) ───────────── */

const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const PROFILE_NSID = 'app.bsky.actor.profile'

async function patchIdentity(cookie: string, body: unknown, origin = TEST_BASE_URL) {
  return fetch(`${TEST_BASE_URL}/api/atproto/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify(body),
  })
}

/** The person's `app.bsky.actor.profile@self` straight from the local PDS; null when absent. */
async function liveProfileRecord(did: string): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
  const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`)
  url.searchParams.set('repo', did)
  url.searchParams.set('collection', PROFILE_NSID)
  url.searchParams.set('rkey', 'self')
  const res = await fetch(url)
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`getRecord failed (${res.status})`)
  return (await res.json()) as { uri: string; cid: string; value: Record<string, unknown> }
}

test('a custodial person can publish their profile record to their own repo, keep it in sync, and delete it', async () => {
  test.skip(!pds, 'PDS_URL / PDS_INTERNAL_URL is not set')
  const db = postgres(local, { max: 2, onnotice: () => {} })
  const account = await createTestAccount('profile-record', { sql: db })
  try {
    expect((await patchProfile(account.cookie, { display_name: 'Record Person', bio: 'Bio one' })).status).toBe(200)

    // Off by default: no record, flag false.
    const before = await (await fetch(`${TEST_BASE_URL}/api/atproto/me`, { headers: { cookie: account.cookie } })).json()
    expect(before).toMatchObject({ kind: 'custodial', publishProfile: false, profileRecordUri: null })
    expect(await liveProfileRecord(account.did)).toBeNull()
    expect((await (await fetch(`${TEST_BASE_URL}/api/me/profile`, { headers: { cookie: account.cookie } })).json()).profile.publish_profile).toBe(false)

    // Guards: same-origin, signed in, a boolean, at least one field.
    expect((await patchIdentity(account.cookie, { publish_profile: true }, 'https://evil.example')).status).toBe(403)
    expect((await fetch(`${TEST_BASE_URL}/api/atproto/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: TEST_BASE_URL }, body: '{"publish_profile":true}' })).status).toBe(401)
    expect((await patchIdentity(account.cookie, { publish_profile: 'yes' })).status).toBe(400)
    expect((await patchIdentity(account.cookie, {})).status).toBe(400)

    // Opt in: the record is written to the PERSON's repo, as them, and tracked.
    const on = await patchIdentity(account.cookie, { publish_profile: true })
    expect(on.status).toBe(200)
    const onBody = await on.json()
    expect(onBody).toMatchObject({ publishProfile: true, profileRecordUri: `at://${account.did}/${PROFILE_NSID}/self` })
    const record = await liveProfileRecord(account.did)
    expect(record).not.toBeNull()
    expect(record!.value).toMatchObject({ $type: PROFILE_NSID, displayName: 'Record Person', description: 'Bio one' })
    expect(Object.keys(record!.value).sort()).toEqual(['$type', 'createdAt', 'description', 'displayName']) // no avatar/banner blob
    const { assertValidRecord, assertNoUnknownFields } = await withServerOnlyShim(
      () => require('../src/lib/atproto/validate') as typeof import('../src/lib/atproto/validate'),
    )
    const { assertNoForeignDid } = await withServerOnlyShim(() => require('../src/lib/atproto/records') as typeof import('../src/lib/atproto/records'))
    expect(() => assertValidRecord(PROFILE_NSID, record!.value)).not.toThrow()
    expect(() => assertNoUnknownFields(PROFILE_NSID, record!.value)).not.toThrow()
    expect(() => assertNoForeignDid(record!.value, account.did)).not.toThrow()
    let [row] = await db`select publish_profile, profile_record_uri, profile_record_cid from profiles where id = ${account.id}`
    expect(row).toEqual({ publish_profile: true, profile_record_uri: record!.uri, profile_record_cid: record!.cid })

    // Turning it on again is idempotent (CAS on the cid we hold): same uri, still one record.
    expect((await patchIdentity(account.cookie, { publish_profile: true })).status).toBe(200)

    // Editing the bio here rewrites the record after the response; an unrelated edit does not touch it.
    expect((await patchProfile(account.cookie, { bio: 'Bio two' })).status).toBe(200)
    await expect.poll(async () => (await liveProfileRecord(account.did))?.value.description, { timeout: 20_000 }).toBe('Bio two')
    const rewritten = (await liveProfileRecord(account.did))!
    expect(rewritten.cid).not.toBe(record!.cid)
    expect(rewritten.value.displayName).toBe('Record Person')
    await expect.poll(async () => (await db`select profile_record_cid from profiles where id = ${account.id}`)[0].profile_record_cid, { timeout: 10_000 }).toBe(rewritten.cid)
    expect((await patchProfile(account.cookie, { affiliation: 'Somewhere' })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 1500))
    expect((await liveProfileRecord(account.did))!.cid).toBe(rewritten.cid)

    // Opt out: the record is deleted from their repo and forgotten.
    const off = await patchIdentity(account.cookie, { publish_profile: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ publishProfile: false, profileRecordUri: null })
    expect(await liveProfileRecord(account.did)).toBeNull()
    ;[row] = await db`select publish_profile, profile_record_uri, profile_record_cid from profiles where id = ${account.id}`
    expect(row).toEqual({ publish_profile: false, profile_record_uri: null, profile_record_cid: null })

    // A later edit writes nothing when opted out.
    expect((await patchProfile(account.cookie, { bio: 'Bio three' })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 1500))
    expect(await liveProfileRecord(account.did)).toBeNull()
  } finally { await account.cleanup(); await db.end() }
})

test('an OAuth account is refused (409); the hourly refresh job is cron-guarded, re-reads active OAuth accounts once an hour and skips custodial ones', async () => {
  test.skip(!pds, 'PDS_URL / PDS_INTERNAL_URL is not set')
  const db = postgres(local, { max: 2, onnotice: () => {} })
  const account = await createTestAccount('profile-refresh', { sql: db })
  const cron = await withServerOnlyShim(() => require('../src/lib/notifications/cron') as typeof import('../src/lib/notifications/cron'))
  try {
    // Route auth is the shared cron check: a wrong bearer is refused whenever a secret is configured.
    const request = (auth?: string) => new Request(`${TEST_BASE_URL}/api/jobs/profile-refresh`, { headers: auth ? { authorization: auth } : {} })
    expect(cron.authorizeCron(request('Bearer wrong'), { secret: 's3cret-s3cret-s3cret', nodeEnv: 'development' })?.status).toBe(401)
    expect(cron.authorizeCron(request(), { secret: undefined, nodeEnv: 'production' })?.status).toBe(503)
    const anonJob = await fetch(`${TEST_BASE_URL}/api/jobs/profile-refresh`, { headers: { authorization: 'Bearer definitely-wrong' } })
    expect([200, 401]).toContain(anonJob.status) // 401 whenever CRON_SECRET is set locally

    // As a custodial account: publish a record (so the person's repo holds a real network profile), then
    // the job leaves the account alone — custodial accounts have nothing to import.
    expect((await patchProfile(account.cookie, { display_name: 'Refresh Person', bio: 'From the record' })).status).toBe(200)
    expect((await patchIdentity(account.cookie, { publish_profile: true })).status).toBe(200)
    const job = (secret?: string) =>
      fetch(`${TEST_BASE_URL}/api/jobs/profile-refresh`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} })
    let run = await job(process.env.CRON_SECRET)
    expect(run.status).toBe(200)
    let report = (await run.json()).report as { attempted: number; fetched: number; updated: number; truncated: boolean }
    expect(Object.keys(report).sort()).toEqual(['attempted', 'fetched', 'truncated', 'updated'])
    expect((await db`select profile_refresh_at from profiles where id = ${account.id}`)[0].profile_refresh_at).toBeNull()

    // Now the same account as if it had come through the Bluesky door (kind flipped in place; its
    // session was created just now, so it counts as active).
    await db`update accounts set kind = 'oauth' where id = ${account.id}`
    const refused = await patchIdentity(account.cookie, { publish_profile: false })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'not_custodial' })
    // Blank the local fields: the refresh must fill them from the record in the person's own repo.
    await db`update profiles set display_name = null, bio = null, synced_fields = '{}' where id = ${account.id}`
    run = await job(process.env.CRON_SECRET)
    expect(run.status).toBe(200)
    report = (await run.json()).report
    expect(report.attempted).toBeGreaterThanOrEqual(1)
    expect(report.fetched).toBeGreaterThanOrEqual(1)
    let [profile] = await db`select display_name, bio, synced_fields, profile_refresh_at, profile_synced_at from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Refresh Person', bio: 'From the record' })
    expect(profile.synced_fields.sort()).toEqual(['bio', 'display_name'])
    expect(profile.profile_refresh_at).not.toBeNull()
    expect(profile.profile_synced_at).not.toBeNull()

    // At most once an hour: a second tick does not touch the account again.
    const stamp = profile.profile_refresh_at
    await db`update profiles set display_name = null where id = ${account.id}`
    run = await job(process.env.CRON_SECRET)
    expect(run.status).toBe(200)
    ;[profile] = await db`select display_name, profile_refresh_at from profiles where id = ${account.id}`
    expect(profile.profile_refresh_at).toEqual(stamp)
    expect(profile.display_name).toBeNull()

    // An hour later it is due again and a locally edited field stays local (non-force import).
    await db`update profiles set profile_refresh_at = now() - interval '2 hours', bio = 'Edited here', synced_fields = '{}' where id = ${account.id}`
    run = await job(process.env.CRON_SECRET)
    expect(run.status).toBe(200)
    ;[profile] = await db`select display_name, bio, synced_fields from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Refresh Person', bio: 'Edited here', synced_fields: ['display_name'] })

    // Back to custodial so the opt-out path (and the cleanup) runs as the person.
    await db`update accounts set kind = 'custodial' where id = ${account.id}`
    expect((await patchIdentity(account.cookie, { publish_profile: false })).status).toBe(200)
    expect(await liveProfileRecord(account.did)).toBeNull()
  } finally {
    await db`update accounts set kind = 'custodial' where id = ${account.id}`.catch(() => undefined)
    await account.cleanup()
    await db.end()
  }
})
