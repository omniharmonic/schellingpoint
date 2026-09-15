import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'

// Participant-side records in a PERSON's own repo, against the real local PDS: two custodial
// accounts are minted through the W0 custody module, one proposes, the other endorses, co-hosts and
// RSVPs publicly; the proposer publishes (then withdraws) time preferences and the proposal. The
// OAuth-door linkage gate and window validation are checked against the database alone.
loadEnvConfig(process.cwd(), true)

const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(migrationUrl && pds && adminPassword && process.env.DATABASE_URL && process.env.PDS_HANDLE_DOMAIN && process.env.ATPROTO_CUSTODY_KEY)

type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const FAKE_GATHERING = `did:plc:${`partgather${RUN}`.replace(/[^a-z2-7]/g, 'q').padEnd(24, 'q').slice(0, 24)}`
const CID = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'

async function live(uri: string): Promise<{ status: number; body: { cid?: string; value?: Record<string, unknown> } }> {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)!
  const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?repo=${m[1]}&collection=${m[2]}&rkey=${m[3]}`)
  return { status: res.status, body: await res.json() }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('participant records', () => {
  test.skip(!configured, 'the local stack env is not set')
  test.setTimeout(120_000)

  let raw: postgres.Sql
  let participant: typeof import('../src/lib/atproto/participant')
  let custody: typeof import('../src/lib/auth/custody')
  let db: typeof import('../src/lib/db')
  let eventId = ''
  let sessionId = ''
  const people: Record<'proposer' | 'friend', { id: string; did: string }> = {} as never
  const oauthDid = `did:plc:${`oauthpart${RUN}`.replace(/[^a-z2-7]/g, 'q').padEnd(24, 'q').slice(0, 24)}`
  let oauthId = ''

  test.beforeAll(async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    participant = require('../src/lib/atproto/participant')
    custody = require('../src/lib/auth/custody')
    db = require('../src/lib/db')
    /* eslint-enable @typescript-eslint/no-require-imports */
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })
    const [event] = await raw<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, actor_did, allowed_formats, allowed_durations, timezone)
      values (${`f-part-${RUN}`}, 'F participant test', '2026-10-01', '2026-10-02', 'proposals_open', ${FAKE_GATHERING},
              ${['talk', 'workshop']}, ${[30, 60]}, 'America/Denver')
      returning id
    `
    eventId = event!.id
    for (const role of ['proposer', 'friend'] as const) {
      const minted = await custody.mintCustodialAccount(`f-part-${role}-${RUN}@example.test`)
      people[role] = { id: minted.accountId, did: minted.did }
      await raw`insert into event_members (event_id, user_id, role) values (${eventId}, ${minted.accountId}, 'attendee')`
    }
    const [oauth] = await raw<{ id: string }[]>`insert into accounts (did, handle, kind) values (${oauthDid}, null, 'oauth') returning id`
    oauthId = oauth!.id
    const [session] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, is_self_hosted, custom_location, public_place,
                            self_hosted_start_time, self_hosted_end_time)
      values (${eventId}, 'Seed saving circle', 'Bring a jar.', 'workshop', 60, ${people.proposer.id}, 'approved', true,
              '1234 Hidden Garden Rd, Longmont CO 80501', 'East Longmont', '2026-10-01T16:00:00Z', '2026-10-01T17:00:00Z')
      returning id
    `
    sessionId = session!.id
  })

  test.afterAll(async () => {
    if (raw) {
      await raw`delete from events where id = ${eventId}`
      const ids = [people.proposer?.id, people.friend?.id, oauthId].filter(Boolean) as string[]
      const dids = [people.proposer?.did, people.friend?.did].filter(Boolean) as string[]
      await raw`delete from at_records where did = any(${[...dids, oauthDid]}::text[])`
      for (const did of dids) {
        await fetch(`${pds}/xrpc/com.atproto.admin.deleteAccount`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}` },
          body: JSON.stringify({ did }),
        })
      }
      if (ids.length) await raw`delete from accounts where id = any(${ids}::uuid[])`
      await raw.end({ timeout: 5 })
    }
    await db?.sql.end({ timeout: 5 }).catch(() => undefined)
    moduleWithResolver._resolveFilename = originalResolve
  })

  test('an OAuth-door account must confirm public linkage; custodial accounts need not', async () => {
    await expect(participant.publishingIdentity(oauthId)).rejects.toMatchObject({ code: 'confirm_public_linkage', status: 409 })
    await expect(participant.publishingIdentity(oauthId, { confirmPublicLinkage: true })).resolves.toMatchObject({ did: oauthDid, kind: 'oauth' })
    await expect(participant.publishingIdentity(oauthId, { requireLinkage: false })).resolves.toMatchObject({ did: oauthDid })
    await expect(participant.publishingIdentity(people.proposer.id)).resolves.toMatchObject({ did: people.proposer.did, kind: 'custodial' })
  })

  test('time windows must be real, ordered instants', () => {
    expect(participant.normalizeWindows([{ startsAt: '2026-10-01T18:00:00-06:00', endsAt: '2026-10-01T20:00:00-06:00', preference: 1 }], 'windows')).toEqual([
      { startsAt: '2026-10-02T00:00:00.000Z', endsAt: '2026-10-02T02:00:00.000Z', preference: 1 },
    ])
    expect(() => participant.normalizeWindows([{ startsAt: 'tuesday_am', endsAt: 'tuesday_pm' }], 'windows')).toThrow(/ISO 8601/)
    expect(() => participant.normalizeWindows([{ startsAt: '2026-10-01T20:00:00Z', endsAt: '2026-10-01T18:00:00Z' }], 'windows')).toThrow(/before/)
    expect(() => participant.normalizeWindows([{ startsAt: '2026-10-01T18:00:00Z', endsAt: '2026-10-01T20:00:00Z', preference: 4 }], 'windows')).toThrow(/preference/)
    expect(() => participant.normalizeWindows(new Array(41).fill({ startsAt: '2026-10-01T18:00:00Z', endsAt: '2026-10-01T20:00:00Z' }), 'windows')).toThrow(/40/)
  })

  test('the proposal is written in the author’s repo, carries the public place label and never the exact address', async () => {
    await expect(participant.publishProposal({ sessionId, userId: people.friend.id })).rejects.toMatchObject({ code: 'forbidden' })
    const res = await participant.publishProposal({ sessionId, userId: people.proposer.id })
    expect(res.uri.startsWith(`at://${people.proposer.did}/schellingpoint.draft.proposal/`)).toBe(true)
    const record = await live(res.uri)
    expect(record.body.cid).toBe(res.cid)
    expect(record.body.value).toMatchObject({ title: 'Seed saving circle', place: 'East Longmont', selfHosted: true, gathering: `at://${FAKE_GATHERING}/schellingpoint.draft.gathering/self` })
    expect(JSON.stringify(record.body.value)).not.toMatch(/1234|Hidden Garden|80501/)

    // An update is a CAS rewrite of the same record.
    await raw`update sessions set description = 'Bring a jar and a pencil.' where id = ${sessionId}`
    const again = await participant.publishProposal({ sessionId, userId: people.proposer.id })
    expect(again.uri).toBe(res.uri)
    expect(again.cid).not.toBe(res.cid)
  })

  test('an endorsement is the endorser’s own record, one per proposal, removable', async () => {
    await expect(participant.endorse({ sessionId, userId: people.proposer.id })).rejects.toMatchObject({ code: 'forbidden' })
    const first = await participant.endorse({ sessionId, userId: people.friend.id, note: 'Yes please' })
    expect(first.uri.startsWith(`at://${people.friend.did}/schellingpoint.draft.endorsement/`)).toBe(true)
    const second = await participant.endorse({ sessionId, userId: people.friend.id, note: 'Still yes' })
    expect(second.uri).toBe(first.uri)
    expect(await participant.countEndorsements((await raw<{ proposal_uri: string }[]>`select proposal_uri from sessions where id = ${sessionId}`)[0]!.proposal_uri)).toBe(1)
    await participant.unendorse({ sessionId, userId: people.friend.id })
    expect((await live(first.uri)).status).toBe(400)
  })

  test('a co-host writes their own record; nobody else can', async () => {
    await expect(participant.publishCohost({ sessionId, userId: people.friend.id })).rejects.toMatchObject({ code: 'not_cohost' })
    await raw`insert into session_cohosts (session_id, user_id, event_id) values (${sessionId}, ${people.friend.id}, ${eventId})`
    const res = await participant.publishCohost({ sessionId, userId: people.friend.id })
    expect(res.uri.startsWith(`at://${people.friend.did}/schellingpoint.draft.cohost/`)).toBe(true)
    const record = await live(res.uri)
    const [s] = await raw<{ proposal_uri: string; proposal_cid: string }[]>`select proposal_uri, proposal_cid from sessions where id = ${sessionId}`
    expect(record.body.value!.proposal).toEqual({ uri: s!.proposal_uri, cid: s!.proposal_cid })
    await participant.withdrawCohost({ sessionId, userId: people.friend.id })
    expect((await live(res.uri)).status).toBe(400)
  })

  test('a public RSVP is opt-in, strongRefs the calendar event and can be retracted', async () => {
    const eventUri = `at://${FAKE_GATHERING}/community.lexicon.calendar.event/3lbxyzabc2k2b`
    await expect(participant.publicRsvp({ sessionId, userId: people.friend.id, status: 'going' })).rejects.toMatchObject({ code: 'calendar_event_not_published' })
    await raw`update sessions set calendar_event_uri = ${eventUri}, calendar_event_cid = ${CID} where id = ${sessionId}`
    await expect(participant.publicRsvp({ sessionId, userId: people.friend.id, status: 'going' })).rejects.toMatchObject({ code: 'no_rsvp' })
    await raw`update sessions set status = 'scheduled' where id = ${sessionId}`
    await raw`insert into session_rsvps (event_id, session_id, user_id, status) values (${eventId}, ${sessionId}, ${people.friend.id}, 'confirmed')`
    const res = await participant.publicRsvp({ sessionId, userId: people.friend.id, status: 'interested' })
    const record = await live(res.uri)
    expect(record.body.value).toEqual({ $type: 'community.lexicon.calendar.rsvp', subject: { uri: eventUri, cid: CID }, status: 'community.lexicon.calendar.rsvp#interested' })
    await participant.retractPublicRsvp({ sessionId, userId: people.friend.id })
    expect((await live(res.uri)).status).toBe(400)
  })

  test('time preferences stay app-side unless published, and unpublishing deletes the record', async () => {
    const windows = [{ startsAt: '2026-10-01T16:00:00Z', endsAt: '2026-10-01T18:00:00Z', preference: 1 as const }]
    const privateOnly = await participant.publishTimePreference({ sessionId, userId: people.proposer.id, windows })
    expect(privateOnly.record).toBeNull()
    const published = await participant.publishTimePreference({ sessionId, userId: people.proposer.id, windows, blackouts: [], publish: true })
    expect(published.record!.uri.startsWith(`at://${people.proposer.did}/schellingpoint.draft.timePreference/`)).toBe(true)
    const record = await live(published.record!.uri)
    expect((record.body.value!.windows as unknown[])[0]).toEqual({ startsAt: '2026-10-01T16:00:00.000Z', endsAt: '2026-10-01T18:00:00.000Z', preference: 1 })
    await participant.publishTimePreference({ sessionId, userId: people.proposer.id, windows, publish: false })
    expect((await live(published.record!.uri)).status).toBe(400)
    const [row] = await raw<{ publish: boolean; record_uri: string | null; windows: unknown[] }[]>`select publish, record_uri, windows from time_preferences where session_id = ${sessionId}`
    expect(row).toMatchObject({ publish: false, record_uri: null })
    expect(row!.windows).toHaveLength(1)
    await expect(participant.publishTimePreference({ sessionId, userId: people.friend.id, windows })).rejects.toMatchObject({ code: 'forbidden' })
  })

  test('withdrawing deletes the author’s record and flags the session without changing it', async () => {
    const [before] = await raw<{ proposal_uri: string; status: string }[]>`select proposal_uri, status from sessions where id = ${sessionId}`
    await participant.withdrawProposal({ sessionId, userId: people.proposer.id })
    expect((await live(before!.proposal_uri)).status).toBe(400)
    const [after] = await raw<{ status: string; proposal_withdrawn_at: string | null }[]>`select status, proposal_withdrawn_at from sessions where id = ${sessionId}`
    expect(after!.status).toBe(before!.status)
    expect(after!.proposal_withdrawn_at).not.toBeNull()
    await expect(participant.withdrawProposal({ sessionId, userId: people.proposer.id })).rejects.toMatchObject({ code: 'nothing_to_withdraw' })
  })
})
