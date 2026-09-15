import { test, expect } from '@playwright/test'
import postgres from 'postgres'
import { createTestAccount, withServerOnlyShim } from './helpers/gathering'

const local = process.env.DATABASE_MIGRATION_URL
if (!local || !['localhost', '127.0.0.1'].includes(new URL(local).hostname)) throw new Error('Profile tests require the isolated local stack')

test('Bluesky import fills missing profile fields, preserves edits, and rejects another DID', async () => {
  const db = postgres(local, { max: 2, onnotice: () => {} })
  const account = await createTestAccount('profile-import', { sql: db })
  try {
    const { applyBskyProfile } = await withServerOnlyShim(() => require('../src/lib/atproto/bsky-profile') as typeof import('../src/lib/atproto/bsky-profile'))
    const [identity] = await db`select did from accounts where id = ${account.id}`
    await db`update profiles set display_name = 'placeholder', bio = null, interests = array['community gardens'] where id = ${account.id}`
    const remote = { did: identity.did, handle: 'local.example.test', displayName: 'Garden Host', description: 'Growing things together.', avatar: null }
    await applyBskyProfile(account.id, remote, { placeholderName: 'placeholder' })
    let [profile] = await db`select display_name, bio, interests from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'Garden Host', bio: 'Growing things together.', interests: ['community gardens'] })
    await db`update profiles set display_name = 'My chosen name', bio = 'My edited bio' where id = ${account.id}`
    await applyBskyProfile(account.id, { ...remote, displayName: 'Different remote name' })
    ;[profile] = await db`select display_name, bio from profiles where id = ${account.id}`
    expect(profile).toMatchObject({ display_name: 'My chosen name', bio: 'My edited bio' })
    await db`update profiles set bio = null where id = ${account.id}`
    await applyBskyProfile(account.id, { ...remote, did: 'did:plc:not-the-signed-in-person' })
    expect((await db`select bio from profiles where id = ${account.id}`)[0].bio).toBeNull()
  } finally { await account.cleanup(); await db.end() }
})
