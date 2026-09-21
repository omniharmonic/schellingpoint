import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { execFileSync } from 'node:child_process'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, withServerOnlyShim, type TestAccount, type TestGathering } from './helpers/gathering'

// The gathering feed (design §7) against the REAL local stack: dev server :3001, Postgres, PDS.
//
//   - the pure post builder: truncation, stray-mention stripping, the consented mention only
//   - `assertNoForeignDid`'s mention allowance is confined to mention-facet `did` paths in a post
//   - policy off → publishing the schedule claims no feed rows
//   - policy on, host without consent → the post says "the host", carries no mention facet, and
//     validates against the vendored lexicons
//   - host with consent (their own account, with a handle) → a mention facet with their DID and a
//     `feed_posts.mentions` entry
//   - more first-published sessions than the digest threshold → ONE digest post
//   - re-publishing claims nothing new (idempotent)
//   - the consent route's auth (401 / 403 / cross-origin)
//   - the privacy audit passes with posts present
// Everything created here is removed afterwards (gathering, identity, accounts, PDS repos).
loadEnvConfig(process.cwd(), true)

const base = 'http://localhost:3001'
const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(pds && migrationUrl && adminPassword && process.env.DATABASE_URL && process.env.ATPROTO_CUSTODY_KEY)

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const NSID_POST = 'app.bsky.feed.post'
const MENTION = 'app.bsky.richtext.facet#mention'
const LINK = 'app.bsky.richtext.facet#link'

type Feed = typeof import('../src/lib/atproto/feed')
type Records = typeof import('../src/lib/atproto/records')
type Validate = typeof import('../src/lib/atproto/validate')

interface Facet { index: { byteStart: number; byteEnd: number }; features: Array<{ $type: string; did?: string; uri?: string }> }
interface PostRecord { $type: string; text: string; facets?: Facet[]; langs?: string[]; createdAt: string; embed?: { $type: string; external?: { uri: string; title: string; description: string } } }

const mentionsOf = (r: { facets?: Facet[] }) => (r.facets ?? []).flatMap((f) => f.features.filter((x) => x.$type === MENTION).map((x) => x.did))
const linksOf = (r: { facets?: Facet[] }) => (r.facets ?? []).flatMap((f) => f.features.filter((x) => x.$type === LINK).map((x) => x.uri))

async function api<T = Record<string, unknown>>(person: TestAccount | null, method: string, pathname: string, json?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(person ? { cookie: person.cookie } : {}), origin: base, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T }
}

async function getRecordLive(uri: string): Promise<{ status: number; value: PostRecord }> {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) throw new Error(`not an at-uri: ${uri}`)
  const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`)
  url.searchParams.set('repo', m[1]!)
  url.searchParams.set('collection', m[2]!)
  url.searchParams.set('rkey', m[3]!)
  const res = await fetch(url)
  const body = (await res.json()) as { value: PostRecord }
  return { status: res.status, value: body.value }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('gathering feed', () => {
  test.skip(!configured, 'the local stack env (PDS_URL, DATABASE_MIGRATION_URL, PDS_ADMIN_PASSWORD, ATPROTO_CUSTODY_KEY) is not set')
  test.setTimeout(180_000)

  let raw: postgres.Sql
  let feed: Feed
  let records: Records
  let validate: Validate
  let gathering: TestGathering
  let owner: TestAccount
  let host: TestAccount
  let stranger: TestAccount
  let slots: Array<{ id: string; venue_id: string }> = []
  let slotAt = 0
  const feedPath = () => `/api/v1/events/${gathering.slug}/feed`
  const mePath = () => `/api/v1/events/${gathering.slug}/participants/me`

  test.beforeAll(async () => {
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })
    ;({ feed, records, validate } = await withServerOnlyShim(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      return {
        feed: require('../src/lib/atproto/feed') as Feed,
        records: require('../src/lib/atproto/records') as Records,
        validate: require('../src/lib/atproto/validate') as Validate,
      }
      /* eslint-enable @typescript-eslint/no-require-imports */
    }))
    gathering = await createTestGathering(raw, { tag: 'feed', status: 'proposals_open', visibility: 'public', withProgram: true, mintIdentity: true })
    owner = await createTestAccount('feed-owner', { sql: raw, base })
    host = await createTestAccount('feed-host', { sql: raw, base })
    stranger = await createTestAccount('feed-stranger', { sql: raw, base })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${host.id}, 'attendee')`
    const rows = await raw<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and venue_id is not null and coalesce(is_break, false) = false order by start_time, id
    `
    slots = rows
    expect(slots.length).toBeGreaterThanOrEqual(8)
  })

  test.afterAll(async () => {
    if (!raw) return
    try {
      await gathering?.cleanup()
      for (const p of [owner, host, stranger]) await p?.cleanup()
    } finally {
      await raw.end({ timeout: 5 })
    }
  })

  async function newSession(title: string, hostId: string): Promise<string> {
    const slot = slots[slotAt++]!
    // The insert trigger sets the status itself (approved/pending); scheduling is a separate update, as in the app.
    const [row] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, topic_tags)
      values (${gathering.id}, ${title}, 'A session for the feed tests.', 'talk', 30, ${hostId}, 'pending', ${['governance']})
      returning id
    `
    await raw`update sessions set status = 'scheduled', time_slot_id = ${slot.id}, venue_id = ${slot.venue_id} where id = ${row!.id}`
    return row!.id
  }

  async function publishSchedule(): Promise<void> {
    const res = await api<{ results: Array<{ error?: string }> }>(owner, 'POST', `/api/v1/events/${gathering.slug}/admin/atproto/publish`, { what: 'schedule' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results.filter((r) => r.error)).toEqual([])
  }

  async function deliver() {
    const res = await api<{ status: string; posts: Array<{ id: string; kind: string; status: string; text: string; uri: string | null; mentions: Array<{ did: string; handle: string }>; error: string | null }> }>(owner, 'POST', feedPath(), { action: 'deliver' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body
  }

  async function ledger(sessionId?: string) {
    return raw<{ id: string; kind: string; status: string; subject_id: string | null; uri: string | null; text: string; mentions: Array<{ did: string; handle: string }>; error: string | null }[]>`
      select id, kind, status, subject_id, uri, text, mentions, error from feed_posts
      where event_id = ${gathering.id} ${sessionId ? raw`and subject_id = ${sessionId}` : raw``} order by created_at, id
    `
  }

  test('the builder truncates the title, strips stray mentions and keeps only the consented one', () => {
    const consentedHost = { did: 'did:plc:feedhostconsented00001', handle: 'alice.test' }
    const url = 'https://unconference.events/e/g/sessions/1'
    const card = { title: 'A session', description: 'Sat · Main Hall' }
    const template = 'On the schedule: “{title}” — Sat, Oct 3, 9:00 AM in Main Hall, hosted by {host}. {link}'

    const long = feed.buildPostRecord({ template, title: 'x'.repeat(400), host: null, consented: new Set(), url, card, createdAt: new Date() })
    expect(long.text.length).toBeLessThanOrEqual(300)
    expect(long.text).toContain('…” — Sat')
    expect(long.text).toContain('hosted by the host')
    expect(long.text.endsWith(feed.displayUrl(url))).toBe(true)
    expect(linksOf(long)).toEqual([url])
    validate.assertValidRecord(NSID_POST, long.record)
    validate.assertNoUnknownFields(NSID_POST, long.record)
    expect(long.record).toMatchObject({ langs: ['en'], embed: { $type: 'app.bsky.embed.external', external: { uri: url, title: 'A session' } } })

    // A title smuggling a mention: the facet is dropped and the text rewritten.
    const stray = feed.buildPostRecord({ template, title: 'Ask @evil.test anything', host: null, consented: new Set(), url, card, createdAt: new Date() })
    expect(stray.text).not.toContain('@evil.test')
    expect(mentionsOf(stray)).toEqual([])
    expect(stray.mentions).toEqual([])

    // The host without consent is "the host"; with consent, a facet naming exactly their DID.
    const noConsent = feed.buildPostRecord({ template, title: 'Commons lab', host: consentedHost, consented: new Set(), url, card, createdAt: new Date() })
    expect(noConsent.text).toContain('hosted by the host')
    expect(noConsent.text).not.toContain('@alice.test')
    expect(mentionsOf(noConsent)).toEqual([])
    const consented = feed.buildPostRecord({ template, title: 'Commons lab', host: consentedHost, consented: new Set([consentedHost.did]), url, card, createdAt: new Date() })
    expect(consented.text).toContain('hosted by @alice.test')
    expect(mentionsOf(consented)).toEqual([consentedHost.did])
    expect(consented.mentions).toEqual([consentedHost])
    validate.assertValidRecord(NSID_POST, consented.record)
    // A consented host whose handle also appears as a stray mention elsewhere: only one facet, at "@alice.test".
    const twice = feed.buildPostRecord({ template, title: 'With @alice.test and @bob.test', host: consentedHost, consented: new Set([consentedHost.did]), url, card, createdAt: new Date() })
    expect(twice.text).not.toContain('@bob.test')
    expect(mentionsOf(twice)).toEqual([consentedHost.did])
  })

  test('assertNoForeignDid admits a consented DID only at a mention facet inside a post', () => {
    const actor = 'did:plc:feedgatheringactor000001'
    const other = 'did:plc:feedsomeoneelse00000001'
    const post = (extra: Record<string, unknown> = {}) => ({
      $type: NSID_POST,
      text: 'hosted by @x.test',
      facets: [{ index: { byteStart: 10, byteEnd: 17 }, features: [{ $type: MENTION, did: other }] }],
      langs: ['en'],
      createdAt: new Date().toISOString(),
      ...extra,
    })
    expect(() => records.assertNoForeignDid(post(), actor, { gatheringDid: actor })).toThrow(/R9/)
    expect(() => records.assertNoForeignDid(post(), actor, { gatheringDid: actor, consentedMentionDids: new Set([other]) })).not.toThrow()
    // Not at a mention path (a link feature, the text, another record type): still refused.
    expect(() => records.assertNoForeignDid(post({ facets: [{ index: { byteStart: 0, byteEnd: 1 }, features: [{ $type: LINK, uri: other }] }] }), actor, { gatheringDid: actor, consentedMentionDids: new Set([other]) })).toThrow(/R9/)
    expect(() => records.assertNoForeignDid(post({ text: `hosted by ${other}` }), actor, { gatheringDid: actor, consentedMentionDids: new Set([other]) })).toThrow(/R9/)
    expect(() => records.assertNoForeignDid({ ...post(), $type: 'schellingpoint.draft.track' }, actor, { gatheringDid: actor, consentedMentionDids: new Set([other]) })).toThrow(/R9/)
  })

  test('policy off: publishing the schedule claims no feed rows', async () => {
    await newSession(`Feed off ${RUN}`, host.id)
    await publishSchedule()
    expect(await ledger()).toEqual([])
    const status = await api<{ enabled: boolean; blocked: string | null; counts: { queued: number } }>(owner, 'GET', feedPath())
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ enabled: false, counts: { queued: 0 } })
    expect(status.body.blocked).toMatch(/off/)
  })

  test('policy on, host without consent: the post says "the host", carries no mention facet, and validates', async () => {
    const on = await api(owner, 'PATCH', `/api/events/${gathering.id}/settings`, { feed_posts: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    const sessionId = await newSession(`Feed no consent ${RUN}`, host.id)
    await publishSchedule()
    const [claimed] = await ledger(sessionId)
    expect(claimed).toMatchObject({ kind: 'session-scheduled', status: 'queued', uri: null })

    const delivered = await deliver()
    const [row] = await ledger(sessionId)
    expect(row, JSON.stringify(delivered)).toMatchObject({ status: 'posted', mentions: [] })
    expect(row!.error).toBeNull()
    expect(row!.text).toContain('hosted by the host')
    expect(row!.text).not.toContain(host.handle)
    expect(row!.uri!.startsWith(`at://${gathering.actorDid}/${NSID_POST}/`)).toBe(true)

    const live = await getRecordLive(row!.uri!)
    expect(live.status).toBe(200)
    expect(live.value.text).toBe(row!.text)
    expect(mentionsOf(live.value)).toEqual([])
    expect(linksOf(live.value)).toEqual([expect.stringContaining(`/e/${gathering.slug}/sessions/${sessionId}`)])
    expect(live.value.langs).toEqual(['en'])
    expect(live.value.embed?.external?.uri).toContain(`/sessions/${sessionId}`)
    validate.assertValidRecord(NSID_POST, live.value)
    validate.assertNoUnknownFields(NSID_POST, live.value)
    expect(JSON.stringify(live.value)).not.toContain(host.did)

    const [audit] = await raw<{ n: number }[]>`select count(*)::int as n from at_audit where event_id = ${gathering.id} and action = 'publish-post' and decision = 'allow' and uri = ${row!.uri}`
    expect(audit!.n).toBe(1)
    const [indexed] = await raw<{ n: number }[]>`select count(*)::int as n from at_records where uri = ${row!.uri}`
    expect(indexed!.n).toBe(1)
  })

  test('the consent route: 401 signed out, 403 cross-origin, 403 for a non-member; the member sees their switch', async () => {
    expect((await api(null, 'GET', mePath())).status).toBe(401)
    const cross = await api(host, 'PATCH', mePath(), { mention_in_posts: true }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)
    expect((await api(stranger, 'PATCH', mePath(), { mention_in_posts: true })).status).toBe(403)
    expect((await api(host, 'PATCH', mePath(), { mention_in_posts: 'yes' })).status).toBe(400)
    const me = await api<{ mention_in_posts: boolean; has_handle: boolean; feed_posts: boolean }>(host, 'GET', mePath())
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ mention_in_posts: false, has_handle: true, feed_posts: true })
    const [still] = await raw<{ mention_in_posts: boolean }[]>`select mention_in_posts from event_members where event_id = ${gathering.id} and user_id = ${host.id}`
    expect(still!.mention_in_posts).toBe(false)
  })

  test('host with consent: a mention facet with their DID, recorded in feed_posts.mentions', async () => {
    const opt = await api<{ mention_in_posts: boolean }>(host, 'PATCH', mePath(), { mention_in_posts: true })
    expect(opt.status, JSON.stringify(opt.body)).toBe(200)
    expect(opt.body.mention_in_posts).toBe(true)

    const sessionId = await newSession(`Feed consented ${RUN}`, host.id)
    // Somebody else's session in the same publish: the consent must not leak across sessions.
    const otherSessionId = await newSession(`Feed other host ${RUN}`, owner.id)
    await publishSchedule()
    await deliver()

    const [mine] = await ledger(sessionId)
    expect(mine).toMatchObject({ status: 'posted' })
    expect(mine!.text).toContain(`hosted by @${host.handle}`)
    expect(mine!.mentions).toEqual([{ did: host.did, handle: host.handle }])
    const live = await getRecordLive(mine!.uri!)
    expect(mentionsOf(live.value)).toEqual([host.did])
    validate.assertValidRecord(NSID_POST, live.value)

    const [other] = await ledger(otherSessionId)
    expect(other).toMatchObject({ status: 'posted', mentions: [] })
    expect(other!.text).toContain('hosted by the host')
    expect(JSON.stringify((await getRecordLive(other!.uri!)).value)).not.toContain(host.did)
  })

  test('more first-published sessions than the threshold become one digest post', async () => {
    const set = await api(owner, 'PATCH', `/api/events/${gathering.id}/settings`, { feed_digest_threshold: 2 })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    const ids = [await newSession(`Digest a ${RUN}`, host.id), await newSession(`Digest b ${RUN}`, owner.id), await newSession(`Digest c ${RUN}`, host.id)]
    await publishSchedule()
    const rows = await ledger()
    const perSession = rows.filter((r) => r.subject_id && ids.includes(r.subject_id))
    expect(perSession.map((r) => r.status)).toEqual(['digested', 'digested', 'digested'])
    const digests = rows.filter((r) => r.kind === 'schedule-digest')
    expect(digests).toHaveLength(1)
    expect(digests[0]!.status).toBe('queued')

    await deliver()
    const [digest] = (await ledger()).filter((r) => r.kind === 'schedule-digest')
    expect(digest!.status).toBe('posted')
    expect(digest!.text).toContain('3 sessions were added to the schedule')
    expect(digest!.mentions).toEqual([])
    const live = await getRecordLive(digest!.uri!)
    expect(mentionsOf(live.value)).toEqual([])
    validate.assertValidRecord(NSID_POST, live.value)
    for (const r of perSession) expect(r.uri).toBeNull()
  })

  test('re-running the publish claims nothing new, and delivering again posts nothing', async () => {
    const before = await ledger()
    await publishSchedule()
    const after = await ledger()
    expect(after.map((r) => [r.id, r.status, r.uri])).toEqual(before.map((r) => [r.id, r.status, r.uri]))
    const again = await api<{ status: string }>(owner, 'POST', feedPath(), { action: 'deliver' })
    expect(again.body.status).toBe('idle')
    const listed = await api<{ posts: Array<{ status: string; bskyUrl: string | null }>; counts: { posted: number; queued: number; failed: number } }>(owner, 'GET', feedPath())
    expect(listed.body.counts).toMatchObject({ queued: 0, failed: 0 })
    expect(listed.body.counts.posted).toBeGreaterThanOrEqual(4)
    expect(listed.body.posts.every((p) => p.status !== 'digested')).toBe(true)
    expect(listed.body.posts.filter((p) => p.status === 'posted').every((p) => p.bskyUrl?.startsWith('https://bsky.app/profile/'))).toBe(true)
    // Only organisers read the ledger.
    expect((await api(host, 'GET', feedPath())).status).toBe(403)
  })

  test('the privacy audit passes with posts present', async () => {
    const out = execFileSync('npx', ['tsx', 'scripts/atproto-privacy-audit.ts'], { encoding: 'utf8', env: { ...process.env } })
    expect(out).toContain('[ ok ] foreign-did')
    expect(out).toContain('[ ok ] host-name')
    expect(out).toContain('[ ok ] borrowed')
    expect(out).toMatch(/feed posts \(ledger\):\s+[1-9]/)
    expect(out.trim().endsWith('PASS')).toBe(true)
  })
})
