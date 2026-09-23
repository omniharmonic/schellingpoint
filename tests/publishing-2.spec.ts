import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { execFileSync } from 'node:child_process'
import postgres from 'postgres'
import sharp from 'sharp'
import { createTestAccount, createTestGathering, withServerOnlyShim, type TestAccount, type TestGathering } from './helpers/gathering'

// Publishing wave 2 (design §14 items 1–2, §10.3; inventory P2-18 … P2-23) against the REAL local
// stack: dev server :3001, Postgres, PDS.
//
//   1. avatar blobs   the JSON blob form validates (validate.ts → BlobRef); sharp re-encodes to a
//                     512² JPEG under the lexicon's 1 MB cap; only OUR upload store is read; the
//                     gathering's profile record carries the logo as `avatar`, the upload is
//                     audited once (`upload-blob`) and cached in `at_blobs`; a feed link card
//                     carries the same blob as its thumb
//   2. delete-post    "Retract" goes through the two-organiser approval flow: one organiser leaves
//                     the post up, the second retracts it from the repo and marks the ledger row
//   3. summaries      organizers edit a generated summary and the gathering's themes; members read
//                     the edited text; a member cannot edit
//   4. Ask flag       `hasReadableTranscripts` is true only for a viewer who may read one
//   5. keyless reads  /api/v1/sessions and /api/v1/sessions/:id serve published sessions with no
//                     key at all, and never a display name, bio or affiliation
//
// Everything created here is removed afterwards (gathering, identity, accounts, PDS repos).
loadEnvConfig(process.cwd(), true)

const base = 'http://localhost:3001'
const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(pds && migrationUrl && adminPassword && process.env.DATABASE_URL && process.env.ATPROTO_CUSTODY_KEY)

const NSID_PROFILE = 'app.bsky.actor.profile'
const NSID_POST = 'app.bsky.feed.post'

type Validate = typeof import('../src/lib/atproto/validate')
type Records = typeof import('../src/lib/atproto/records')
type Blobs = typeof import('../src/lib/atproto/blobs')
type Store = typeof import('../src/lib/knowledge/store')
type Files = typeof import('../src/lib/storage/files')

interface JsonBlob {
  $type: string
  ref: { $link: string }
  mimeType: string
  size: number
}

async function api<T = Record<string, unknown>>(
  person: TestAccount | null,
  method: string,
  pathname: string,
  json?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(person ? { cookie: person.cookie } : {}), origin: base, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T }
}

async function recordLive(uri: string): Promise<{ status: number; value: Record<string, unknown> }> {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) throw new Error(`not an at-uri: ${uri}`)
  return getRecordLive(m[1]!, m[2]!, m[3]!)
}

async function getRecordLive(repo: string, collection: string, rkey: string): Promise<{ status: number; value: Record<string, unknown> }> {
  const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`)
  url.searchParams.set('repo', repo)
  url.searchParams.set('collection', collection)
  url.searchParams.set('rkey', rkey)
  const res = await fetch(url)
  const body = (await res.json().catch(() => ({}))) as { value?: Record<string, unknown> }
  return { status: res.status, value: body.value ?? {} }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('publishing wave 2', () => {
  test.skip(!configured, 'the local stack env (PDS_URL, DATABASE_MIGRATION_URL, PDS_ADMIN_PASSWORD, ATPROTO_CUSTODY_KEY) is not set')
  test.setTimeout(240_000)

  let raw: postgres.Sql
  let validate: Validate
  let records: Records
  let blobs: Blobs
  let store: Store
  let files: Files
  let gathering: TestGathering
  let owner: TestAccount
  let admin: TestAccount
  let member: TestAccount
  let stranger: TestAccount
  let logoUrl: string
  let sessionId: string
  let postId: string
  let postUri: string

  test.beforeAll(async () => {
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })
    ;({ validate, records, blobs, store, files } = await withServerOnlyShim(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      return {
        validate: require('../src/lib/atproto/validate') as Validate,
        records: require('../src/lib/atproto/records') as Records,
        blobs: require('../src/lib/atproto/blobs') as Blobs,
        store: require('../src/lib/knowledge/store') as Store,
        files: require('../src/lib/storage/files') as Files,
      }
      /* eslint-enable @typescript-eslint/no-require-imports */
    }))

    gathering = await createTestGathering(raw, { tag: 'pub2', status: 'proposals_open', visibility: 'public', withProgram: true, mintIdentity: true })
    owner = await createTestAccount('pub2-owner', { sql: raw, base })
    admin = await createTestAccount('pub2-admin', { sql: raw, base })
    member = await createTestAccount('pub2-member', { sql: raw, base })
    stranger = await createTestAccount('pub2-stranger', { sql: raw, base })
    await raw`
      insert into event_members (event_id, user_id, role) values
        (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${admin.id}, 'admin'), (${gathering.id}, ${member.id}, 'attendee')
    `

    // A logo in OUR upload store — the only source a blob may come from.
    const png = await sharp({ create: { width: 700, height: 500, channels: 3, background: { r: 30, g: 120, b: 90 } } }).png().toBuffer()
    const stored = await withServerOnlyShim(() => files.storeImage(new Uint8Array(png), 'png'))
    logoUrl = stored.url
    await raw`update events set logo_url = ${logoUrl}, feed_posts = true, transcripts_enabled = true where id = ${gathering.id}`

    // One scheduled session, so there is something to publish and to post about.
    const [slot] = await raw<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and venue_id is not null and coalesce(is_break, false) = false order by start_time, id limit 1
    `
    const [session] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, topic_tags)
      values (${gathering.id}, 'Blobs and thumbs', 'A session for the publishing tests.', 'talk', 30, ${member.id}, 'pending', ${['governance']})
      returning id
    `
    sessionId = session!.id
    await raw`update sessions set status = 'scheduled', time_slot_id = ${slot!.id}, venue_id = ${slot!.venue_id} where id = ${sessionId}`
  })

  test.afterAll(async () => {
    if (!raw) return
    try {
      const did = gathering?.actorDid
      await gathering?.cleanup()
      if (did) await raw`delete from at_blobs where did = ${did}`
      for (const p of [owner, admin, member, stranger]) await p?.cleanup()
    } finally {
      await raw.end({ timeout: 5 })
    }
  })

  /* ─────────────────────────── 1. avatar blobs ─────────────────────────── */

  test('a JSON blob validates as a blob ref, and a malformed one does not', () => {
    const blob: JsonBlob = { $type: 'blob', ref: { $link: 'bafkreialhqbrgnqxzd3lmz2yq5adsvhfgbhqpqzlmcu7dg57xvvqz4knlm' }, mimeType: 'image/jpeg', size: 1234 }
    const withAvatar = records.buildGatheringProfileRecord({ name: 'Blob Gathering', tagline: 'With a logo', avatar: blob as never })
    expect(withAvatar).toHaveProperty('avatar')
    // The record carries the JSON form; validation converts it, so this must not throw.
    validate.assertValidRecord(NSID_PROFILE, withAvatar)
    validate.assertNoUnknownFields(NSID_PROFILE, withAvatar as unknown as object)
    expect(validate.isJsonBlob(blob)).toBe(true)
    expect(validate.isJsonBlob({ $type: 'blob', ref: 'not-an-object', mimeType: 'image/jpeg', size: 1 })).toBe(false)
    // A string where a blob belongs is still refused.
    expect(() => validate.assertValidRecord(NSID_PROFILE, { ...withAvatar, avatar: 'https://cdn.example/avatar.png' })).toThrow(/blob/i)
    // Text-only profiles keep validating.
    validate.assertValidRecord(NSID_PROFILE, records.buildGatheringProfileRecord({ name: 'No logo' }))
  })

  test('avatar bytes are re-encoded to a 512² JPEG under the lexicon cap, and only our own store is read', async () => {
    const source = await withServerOnlyShim(() => blobs.localImageBytes(logoUrl))
    expect(source).not.toBeNull()
    const encoded = await blobs.encodeAvatarBytes(source!)
    expect(encoded).not.toBeNull()
    expect(encoded!.mimeType).toBe('image/jpeg')
    expect(encoded!.bytes.byteLength).toBeLessThanOrEqual(blobs.BLOB_MAX_BYTES)
    const meta = await sharp(encoded!.bytes).metadata()
    expect(meta.format).toBe('jpeg')
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(blobs.AVATAR_PX)

    // A third-party CDN URL (or any absolute URL) is never fetched.
    for (const url of ['https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafy@jpeg', 'http://localhost:3001/uploads/aa/bb.png', '/uploads/../../etc/passwd', null]) {
      expect(await withServerOnlyShim(() => blobs.localImageBytes(url))).toBeNull()
    }
  })

  test('publishing the gathering puts the logo on its profile record, audited once and cached', async () => {
    const res = await api<{ results: Array<{ kind: string; error?: string }> }>(owner, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto/publish`, { what: 'gathering' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results.filter((r) => r.error)).toEqual([])

    const live = await getRecordLive(gathering.actorDid!, NSID_PROFILE, 'self')
    expect(live.status).toBe(200)
    const avatar = live.value.avatar as JsonBlob | undefined
    expect(avatar, JSON.stringify(live.value)).toBeTruthy()
    expect(avatar!.mimeType).toBe('image/jpeg')
    expect(typeof avatar!.ref.$link).toBe('string')
    expect(live.value).not.toHaveProperty('banner')
    // The record still validates when read back from the PDS in its JSON form.
    validate.assertValidRecord(NSID_PROFILE, live.value)
    validate.assertNoUnknownFields(NSID_PROFILE, live.value)

    const cache = await raw<{ cid: string; mime_type: string; size: number; purpose: string }[]>`
      select cid, mime_type, size, purpose from at_blobs where did = ${gathering.actorDid!}
    `
    expect(cache).toHaveLength(1)
    expect(cache[0]!.cid).toBe(avatar!.ref.$link)

    const [audit] = await raw<{ n: number; reason: string }[]>`
      select count(*)::int as n, max(reason) as reason from at_audit
      where event_id = ${gathering.id} and action = 'upload-blob' and decision = 'allow'
    `
    expect(audit!.n).toBe(1)
    expect(audit!.reason).toContain(avatar!.ref.$link)

    // Re-publishing uses the cached blob: no second upload, no second audit row.
    const again = await api<{ results: Array<{ error?: string }> }>(owner, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto/publish`, { what: 'gathering' })
    expect(again.status).toBe(200)
    const [after] = await raw<{ n: number }[]>`select count(*)::int as n from at_audit where event_id = ${gathering.id} and action = 'upload-blob'`
    expect(after!.n).toBe(1)
    const stillOne = await raw<{ cid: string }[]>`select cid from at_blobs where did = ${gathering.actorDid!}`
    expect(stillOne).toHaveLength(1)
  })

  test('a feed post carries the gathering logo as the link card thumb', async () => {
    const published = await api<{ results: Array<{ error?: string }> }>(owner, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto/publish`, { what: 'schedule' })
    expect(published.status, JSON.stringify(published.body)).toBe(200)

    const delivered = await api<{ status: string }>(owner, 'POST', `/api/v1/events/${gathering.slug}/feed`, { action: 'deliver' })
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200)

    const [row] = await raw<{ id: string; uri: string | null; status: string; error: string | null }[]>`
      select id, uri, status, error from feed_posts where event_id = ${gathering.id} and status = 'posted' order by created_at limit 1
    `
    expect(row, 'a post should have gone out').toBeTruthy()
    expect(row!.error).toBeNull()
    postId = row!.id
    postUri = row!.uri!

    const live = await recordLive(postUri)
    expect(live.status).toBe(200)
    const external = (live.value.embed as { external?: { thumb?: JsonBlob } } | undefined)?.external
    expect(external?.thumb, JSON.stringify(live.value.embed)).toBeTruthy()
    expect(external!.thumb!.mimeType).toBe('image/jpeg')
    validate.assertValidRecord(NSID_POST, live.value)
    validate.assertNoUnknownFields(NSID_POST, live.value)

    // The thumb is the same blob as the avatar: uploaded once for this gathering.
    const cache = await raw<{ cid: string }[]>`select cid from at_blobs where did = ${gathering.actorDid!}`
    expect(cache).toHaveLength(1)
    expect(external!.thumb!.ref.$link).toBe(cache[0]!.cid)
  })

  test('the privacy audit passes with blobs on the profile record and the link card', async () => {
    // A custodial person's own avatar too: the audit allows it behind the same opt-in as the record.
    const patched = await fetch(`${base}/api/atproto/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: member.cookie, origin: base },
      body: JSON.stringify({ publish_profile: true }),
    })
    expect(patched.status).toBe(200)

    const out = execFileSync('npx', ['tsx', 'scripts/atproto-privacy-audit.ts'], { encoding: 'utf8', env: { ...process.env } })
    expect(out).toContain('[ ok ] borrowed')
    expect(out).toContain('[ ok ] profile-optin')
    expect(out).toContain('[ ok ] foreign-did')
    expect(out.trim().endsWith('PASS')).toBe(true)

    await fetch(`${base}/api/atproto/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: member.cookie, origin: base },
      body: JSON.stringify({ publish_profile: false }),
    })
  })

  /* ─────────────────────────── 2. retracting a post ─────────────────────────── */

  test('retracting a post needs two organizers, and only organizers may ask', async () => {
    const path = `/api/v1/events/${gathering.slug}/approvals`
    expect((await api(member, 'POST', path, { action: 'request-post-deletion', postId, reason: 'Wrong link' })).status).toBe(403)
    expect((await api(stranger, 'POST', path, { action: 'request-post-deletion', postId, reason: 'Wrong link' })).status).toBe(403)
    expect((await api(owner, 'POST', path, { action: 'request-post-deletion', postId, reason: '' })).status).toBe(400)
    const cross = await api(owner, 'POST', path, { action: 'request-post-deletion', postId, reason: 'x' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)

    const first = await api<{ status: string; approvalsNeeded: number; requestId: string; threshold: number }>(owner, 'POST', path, {
      action: 'request-post-deletion',
      postId,
      reason: 'The session moved; this post points at the old time.',
    })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body).toMatchObject({ status: 'awaiting_approval', approvalsNeeded: 1, threshold: 2 })

    // One organizer is not enough: the post is still on the network and still 'posted'.
    expect((await recordLive(postUri)).status).toBe(200)
    const [pending] = await raw<{ status: string }[]>`select status from feed_posts where id = ${postId}`
    expect(pending!.status).toBe('posted')

    // A second organizer applies it.
    const second = await api<{ status: string; approvalsNeeded: number }>(admin, 'POST', path, { action: 'approve', requestId: first.body.requestId })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body).toMatchObject({ status: 'applied', approvalsNeeded: 0 })

    expect((await recordLive(postUri)).status).toBe(400)
    const [gone] = await raw<{ status: string; deleted_at: string | null }[]>`select status, deleted_at from feed_posts where id = ${postId}`
    expect(gone!.status).toBe('deleted')
    expect(gone!.deleted_at).not.toBeNull()

    const [audit] = await raw<{ n: number; approvals: unknown }[]>`
      select count(*)::int as n, max(approvals::text)::jsonb as approvals from at_audit
      where event_id = ${gathering.id} and action = 'delete-post' and decision = 'allow' and uri = ${postUri}
    `
    expect(audit!.n).toBe(1)
    expect((audit!.approvals as Array<{ accountId: string }>).length).toBe(2)

    // The organizer feed view shows it as retracted, not missing.
    const view = await api<{ posts: Array<{ id: string; status: string }> }>(owner, 'GET', `/api/v1/events/${gathering.slug}/feed`)
    expect(view.status).toBe(200)
    expect(view.body.posts.find((p) => p.id === postId)?.status).toBe('deleted')
    // Asking again is a no-op, not a second deletion.
    const repeat = await api<{ status: string }>(owner, 'POST', path, { action: 'request-post-deletion', postId, reason: 'again' })
    expect(repeat.body.status).toBe('applied')
  })

  /* ─────────────────────────── 3. series ─────────────────────────── */

  test('a series is created from the gathering and its occurrences are listed', async () => {
    const created = await api<{ seriesId: string; uri: string; results: Array<{ error?: string }> }>(owner, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto`, {
      action: 'create-series',
      series: { freq: 'monthly', interval: 1, count: 3 },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(created.body.seriesId).toBeTruthy()

    const status = await api<{ series: Array<{ id: string; freq: string; interval: number; count: number | null; published: boolean; occurrences: number }> }>(
      owner,
      'GET',
      `/api/v1/events/${gathering.slug}/admin/atproto`,
    )
    expect(status.status).toBe(200)
    const row = status.body.series.find((s) => s.id === created.body.seriesId)
    expect(row, JSON.stringify(status.body.series)).toBeTruthy()
    expect(row).toMatchObject({ freq: 'monthly', interval: 1, count: 3, published: true })
    expect(row!.occurrences).toBeGreaterThanOrEqual(1)

    // Materializing again writes nothing new (deterministic rkeys, unique occurrence key).
    const again = await api<{ results: Array<{ error?: string }> }>(owner, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto`, { action: 'materialize-series', seriesId: created.body.seriesId })
    expect(again.status).toBe(200)
    const after = await api<{ series: Array<{ id: string; occurrences: number }> }>(owner, 'GET', `/api/v1/events/${gathering.slug}/admin/atproto`)
    expect(after.body.series.find((s) => s.id === created.body.seriesId)!.occurrences).toBe(row!.occurrences)

    // A member cannot create one.
    expect((await api(member, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto`, { action: 'create-series', series: { freq: 'weekly' } })).status).toBe(403)
  })

  /* ─────────────────────────── 4. editable summaries and themes ─────────────────────────── */

  test('organizers edit a session summary; members read the edit, and cannot make one', async () => {
    const path = `/api/v1/sessions/${sessionId}/transcript`
    const uploaded = await api(owner, 'POST', path, { text: 'Alice: we talked about soil.\n\nBob: and about software.', consent: true })
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201)

    // Stand in for a generated summary.
    await raw`update session_transcripts set summary = 'Generated text.', summary_generated_at = now() where session_id = ${sessionId} and replaced_at is null`

    expect((await api(member, 'PATCH', path, { summary: 'Member edit' })).status).toBe(403)
    expect((await api(stranger, 'PATCH', path, { summary: 'Stranger edit' })).status).toBe(403)
    expect((await api(owner, 'PATCH', path, {})).status).toBe(400)
    const cross = await api(owner, 'PATCH', path, { summary: 'x' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)

    const edited = await api<{ transcript: { summary: string; summary_edited_at: string | null } }>(owner, 'PATCH', path, {
      summary: 'What the room actually decided: plant the cover crop first.',
    })
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    expect(edited.body.transcript.summary).toContain('cover crop')
    expect(edited.body.transcript.summary_edited_at).not.toBeNull()

    const asMember = await api<{ transcript: { summary: string; summary_edited_at: string | null }; can_edit_summary?: boolean }>(member, 'GET', path)
    expect(asMember.status).toBe(200)
    expect(asMember.body.transcript.summary).toContain('cover crop')
    expect(asMember.body.can_edit_summary).toBe(false)
    const asOwner = await api<{ can_edit_summary?: boolean }>(owner, 'GET', path)
    expect(asOwner.body.can_edit_summary).toBe(true)

    const [row] = await raw<{ summary_edited_by: string | null }[]>`select summary_edited_by from session_transcripts where session_id = ${sessionId} and replaced_at is null`
    expect(row!.summary_edited_by).toBe(owner.id)
  })

  test('organizers edit the gathering themes; members never can', async () => {
    const path = `/api/v1/events/${gathering.slug}/knowledge/summaries`
    await raw`
      update events set themes = ${raw.json({ generated_at: new Date().toISOString(), model: 'test', themes: [{ title: 'Soil', summary: 'Generated.', sessions: [] }] } as never)}::jsonb
      where id = ${gathering.id}
    `
    expect((await api(member, 'PATCH', path, { themes: [] })).status).toBe(403)
    expect((await api(owner, 'PATCH', path, { themes: 'not an array' })).status).toBe(400)

    const saved = await api<{ themes: { themes: Array<{ title: string; summary: string; sessions: string[] }> } }>(owner, 'PATCH', path, {
      themes: [
        { title: 'Soil and software', summary: 'The two threads that ran through the day.', sessions: [sessionId, '00000000-0000-0000-0000-000000000000'] },
        { title: '', summary: 'dropped' },
      ],
    })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.themes.themes).toHaveLength(1)
    expect(saved.body.themes.themes[0]).toMatchObject({ title: 'Soil and software' })
    // A session id that is not this gathering's is dropped.
    expect(saved.body.themes.themes[0]!.sessions).toEqual([sessionId])

    const coverage = await api<{ themes: { themes: Array<{ title: string }> } | null; themes_edited_at: string | null }>(owner, 'GET', `/api/v1/events/${gathering.slug}/knowledge/coverage`)
    expect(coverage.status).toBe(200)
    expect(coverage.body.themes!.themes[0]!.title).toBe('Soil and software')
    expect(coverage.body.themes_edited_at).not.toBeNull()

    const [row] = await raw<{ themes_edited_by: string | null }[]>`select themes_edited_by from events where id = ${gathering.id}`
    expect(row!.themes_edited_by).toBe(owner.id)
  })

  test('the Ask flag is true only for a viewer who may read a transcript', async () => {
    await withServerOnlyShim(async () => {
      expect(await store.hasReadableTranscripts(gathering.id, 'attendee')).toBe(true)
      expect(await store.hasReadableTranscripts(gathering.id, 'owner')).toBe(true)
      expect(await store.hasReadableTranscripts(gathering.id, null)).toBe(false)
      // Organizer-only transcripts are not "readable" for a plain member.
      await raw`update session_transcripts set visibility = 'organizers' where session_id = ${sessionId} and replaced_at is null`
      expect(await store.hasReadableTranscripts(gathering.id, 'attendee')).toBe(false)
      expect(await store.hasReadableTranscripts(gathering.id, 'admin')).toBe(true)
      await raw`update session_transcripts set visibility = 'members' where session_id = ${sessionId} and replaced_at is null`
      // Turning transcripts off takes the item away for everyone.
      await raw`update events set transcripts_enabled = false where id = ${gathering.id}`
      expect(await store.hasReadableTranscripts(gathering.id, 'owner')).toBe(false)
      await raw`update events set transcripts_enabled = true where id = ${gathering.id}`
    })
  })

  /* ─────────────────────────── 5. the keyless partner read ─────────────────────────── */

  test('/api/v1/sessions needs no key and serves only published sessions, with no personal fields', async () => {
    const res = await fetch(`${base}/api/v1/sessions?event=${gathering.slug}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; count: number }
    expect(body.count).toBeGreaterThanOrEqual(1)
    const published = body.data.find((s) => s.id === sessionId)
    expect(published, JSON.stringify(body.data)).toBeTruthy()
    expect(published).toMatchObject({ title: 'Blobs and thumbs', cancelled: false })
    const text = JSON.stringify(body.data)
    for (const leak of ['display_name', 'affiliation', 'bio', 'host_name', member.email]) expect(text).not.toContain(leak)

    // A key changes nothing — there is no key.
    const withKey = await fetch(`${base}/api/v1/sessions?event=${gathering.slug}`, { headers: { 'x-api-key': 'anything-at-all' } })
    expect(withKey.status).toBe(200)

    // One session by id, and 404 for one that is not published.
    const byId = await fetch(`${base}/api/v1/sessions/${sessionId}`)
    expect(byId.status).toBe(200)
    expect(((await byId.json()) as { data: { id: string } }).data.id).toBe(sessionId)

    const [draft] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status)
      values (${gathering.id}, 'Never published', 'x', 'talk', 30, ${member.id}, 'pending') returning id
    `
    expect((await fetch(`${base}/api/v1/sessions/${draft!.id}`)).status).toBe(404)
    expect((await fetch(`${base}/api/v1/sessions?event=${gathering.slug}`)).status).toBe(200)
    expect(JSON.stringify(await (await fetch(`${base}/api/v1/sessions?event=${gathering.slug}`)).json())).not.toContain('Never published')
    await raw`delete from sessions where id = ${draft!.id}`

    // Bad input and hidden gatherings.
    expect((await fetch(`${base}/api/v1/sessions?event=${gathering.slug}&day=nope`)).status).toBe(400)
    expect((await fetch(`${base}/api/v1/sessions?event=${gathering.slug}&track=nope`)).status).toBe(400)
    expect((await fetch(`${base}/api/v1/sessions`)).status).toBe(400)
    expect((await fetch(`${base}/api/v1/sessions?event=no-such-gathering-${Date.now()}`)).status).toBe(404)

    const hidden = await createTestGathering(raw, { tag: 'pub2h', status: 'draft', visibility: 'private' })
    try {
      expect((await fetch(`${base}/api/v1/sessions?event=${hidden.slug}`)).status).toBe(404)
    } finally {
      await hidden.cleanup()
    }
  })
})
