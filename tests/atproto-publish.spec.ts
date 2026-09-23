import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'
import { createTestGathering, type TestGathering } from './helpers/gathering'

// Failure paths of the gathering actor and the publish pipeline. Fakes stand in for the PDS where
// the point is the failure (CAS mismatch, authorisation, R9, sidecar); the revoked-credential test
// uses the REAL local PDS rejecting a real wrong password, next to a real healthy gathering.
loadEnvConfig(process.cwd(), true)

const base = 'http://localhost:3001'
const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(migrationUrl && pds && adminPassword && process.env.DATABASE_URL && process.env.ATPROTO_CUSTODY_KEY)

type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}
/* eslint-disable @typescript-eslint/no-require-imports */
const actorMod = require('../src/lib/atproto/actor') as typeof import('../src/lib/atproto/actor')
const recordsMod = require('../src/lib/atproto/records') as typeof import('../src/lib/atproto/records')
/* eslint-enable @typescript-eslint/no-require-imports */

const GATHERING = 'did:plc:gatheringfailurepath2345'
const STRANGER = 'did:plc:strangerfailurepath23456'
const CID = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'
const NOW = '2026-09-14T12:00:00.000Z'

type Row = import('../src/lib/atproto/actor').AuditRow

function fakeActor(opts: {
  roles?: Record<string, import('../src/lib/atproto/actor').MemberRole>
  ladder?: Record<string, number>
  dids?: Record<string, string>
  optIn?: Record<string, boolean>
  stewards?: number
  publishRoles?: boolean
} = {}) {
  const audits: Row[] = []
  const writes: Array<Record<string, unknown>> = []
  const indexed: Array<{ uri: string; cid: string }> = []
  const port = new actorMod.AppCustodyGatheringActor('event-1', GATHERING, {
    roles: {
      appointedRole: async (_e, id) => opts.roles?.[id] ?? null,
      derivedRole: async (_e, id) => opts.ladder?.[id] ?? 0,
      accountDid: async (id) => opts.dids?.[id] ?? null,
      publicRoleOptIn: async (_e, id) => opts.optIn?.[id] ?? false,
    },
    policy: { destructiveActionStewards: async () => opts.stewards ?? 2, publishRoles: async () => opts.publishRoles ?? false },
    audit: {
      write: async (row) => {
        audits.push(row)
        return `audit-${audits.length}`
      },
      amend: async () => undefined,
    },
    session: {
      putRecord: async (input) => {
        writes.push(input as unknown as Record<string, unknown>)
        return { uri: `at://${GATHERING}/${input.collection}/${input.rkey}`, cid: CID }
      },
      deleteRecord: async () => undefined,
    },
    index: { upsert: async (i) => void indexed.push({ uri: i.uri, cid: i.cid }), remove: async () => undefined },
  })
  return { port, audits, writes, indexed }
}

const track = () => recordsMod.buildTrackRecord({ name: 'Regen', createdAt: NOW }) as unknown as Record<string, unknown>
const approval = (accountId: string) => ({ accountId, recordUri: `at://did:plc:x/freeschool.draft.approval/${accountId}`, recordCid: CID, at: NOW })

test.describe('gathering actor port (fakes)', () => {
  test('non-members are denied and the denial is audited', async () => {
    const { port, audits, writes } = fakeActor()
    await expect(port.putRecordAsGathering({ callerUserId: 'nobody', action: 'publish-track', collection: 'schellingpoint.draft.track', rkey: 'a', record: track(), reason: 'publish' })).rejects.toMatchObject({ name: 'GatheringActionDeniedError', code: 'ErrPermissionDenied' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ decision: 'deny', action: 'publish-track' })
    expect(writes).toHaveLength(0)
  })

  test('a moderator cannot publish as the gathering; an admin can, with an audit row and read-your-writes', async () => {
    const { port, audits, writes, indexed } = fakeActor({ roles: { mod: 'moderator', adm: 'admin' } })
    await expect(port.putRecordAsGathering({ callerUserId: 'mod', action: 'publish-track', collection: 'schellingpoint.draft.track', rkey: 'a', record: track(), reason: 'publish' })).rejects.toThrow(/owner or admin/)
    const res = await port.putRecordAsGathering({ callerUserId: 'adm', action: 'publish-track', collection: 'schellingpoint.draft.track', rkey: 'a', record: track(), reason: 'publish a track' })
    expect(res.cid).toBe(CID)
    expect(audits.map((a) => a.decision)).toEqual(['deny', 'allow'])
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toHaveProperty('swapRecord') // omitted swap = plain upsert, never a `null` assertion
    expect(indexed).toEqual([{ uri: res.uri, cid: CID }])
    await port.putRecordAsGathering({ callerUserId: 'adm', action: 'publish-track', collection: 'schellingpoint.draft.track', rkey: 'b', record: track(), reason: 'first write', swapRecord: null })
    expect(writes[1]).toHaveProperty('swapRecord', null)
  })

  test('destructive actions need the policy threshold of distinct organiser approvals', async () => {
    const { port, audits } = fakeActor({ roles: { a: 'owner', b: 'admin', c: 'attendee' }, stewards: 2 })
    const move = (callerUserId: string | null, approvals: ReturnType<typeof approval>[]) =>
      port.putRecordAsGathering({ callerUserId, action: 'move-slot', collection: 'schellingpoint.draft.track', rkey: 'm', record: track(), reason: 'move', approvals })
    await expect(move('a', [])).rejects.toMatchObject({ code: 'ErrThresholdNotMet' })
    await expect(move('a', [approval('a')])).rejects.toMatchObject({ code: 'ErrThresholdNotMet' })
    await expect(move('a', [approval('a'), approval('a')])).rejects.toMatchObject({ code: 'ErrThresholdNotMet' })
    await expect(move('a', [approval('a'), approval('c')])).rejects.toThrow(/approver is not an owner or admin/)
    await expect(move(null, [approval('a'), approval('b')])).rejects.toThrow(/cannot run as a system job/)
    await expect(move('a', [approval('a'), approval('b')])).resolves.toMatchObject({ cid: CID })
    const allow = audits.find((r) => r.decision === 'allow')
    expect(allow?.approvals).toHaveLength(2)
    expect(audits.filter((r) => r.decision === 'deny')).toHaveLength(5)
  })

  test('R9 and the sidecar rule are enforced before anything is authorised or written', async () => {
    const { port, audits, writes } = fakeActor({ roles: { adm: 'admin' } })
    await expect(
      port.putRecordAsGathering({ callerUserId: 'adm', action: 'publish-track', collection: 'schellingpoint.draft.track', rkey: 'x', record: { ...track(), description: `led by ${STRANGER}` }, reason: 'r9' }),
    ).rejects.toMatchObject({ name: 'ForeignDidError' })
    const event = recordsMod.buildSessionCalendarEvent({ name: 'Talk', startsAt: NOW, endsAt: NOW, sessionUrl: 'https://x.test/s', createdAt: NOW })
    await expect(
      port.putRecordAsGathering({ callerUserId: 'adm', action: 'publish-event', collection: 'community.lexicon.calendar.event', rkey: 'y', record: { ...event, voteCount: 12 } as never, reason: 'sidecar' }),
    ).rejects.toMatchObject({ name: 'RecordValidationError' })
    expect(audits).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  test('a role claim may only name the member who asked, with all three gates open', async () => {
    const subject = 'did:plc:subjectfailurepath234567'
    const claim = recordsMod.buildMembershipRecord({ subjectDid: subject, role: 20, gatheringDid: GATHERING, createdAt: NOW }) as unknown as Record<string, unknown>
    const attempt = (actor: ReturnType<typeof fakeActor>, callerUserId: string) =>
      actor.port.putRecordAsGathering({ callerUserId, action: 'publish-role-claim', collection: 'coop.lexicon.membership', rkey: recordsMod.membershipClaimRkey(GATHERING, subject), record: claim, reason: 'claim' })
    const base = { dids: { me: subject, other: STRANGER }, ladder: { me: 20, other: 20 }, optIn: { me: true, other: true }, publishRoles: true }
    await expect(attempt(fakeActor(base), 'other')).rejects.toThrow(/only name the member who asked/)
    await expect(attempt(fakeActor({ ...base, publishRoles: false }), 'me')).rejects.toThrow(/does not publish role claims/)
    await expect(attempt(fakeActor({ ...base, optIn: { me: false } }), 'me')).rejects.toThrow(/not opted in/)
    await expect(attempt(fakeActor({ ...base, ladder: { me: 10 } }), 'me')).rejects.toThrow(/role >= host/)
    await expect(attempt(fakeActor(base), 'me')).resolves.toMatchObject({ cid: CID })
  })
})

test.describe('publish pipeline and registry', () => {
  test.skip(!configured, 'the local stack env is not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let raw: postgres.Sql
  let publish: typeof import('../src/lib/atproto/publish')
  let actors: typeof import('../src/lib/atproto/actors')
  let crypto: typeof import('../src/lib/atproto/crypto')
  let db: typeof import('../src/lib/db')
  const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const tempEvents: string[] = []
  const tempDids: string[] = []
  const tempAccounts: string[] = []
  const gatherings: TestGathering[] = []

  test.beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    publish = require('../src/lib/atproto/publish')
    actors = require('../src/lib/atproto/actors')
    crypto = require('../src/lib/atproto/crypto')
    db = require('../src/lib/db')
    /* eslint-enable @typescript-eslint/no-require-imports */
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })
  })

  test.afterAll(async () => {
    actors?.configureGatheringActors()
    for (const did of tempDids) {
      await fetch(`${pds}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}` },
        body: JSON.stringify({ did }),
      }).catch(() => undefined)
    }
    if (raw) {
      for (const g of gatherings) await g.cleanup()
      if (tempDids.length) {
        await raw`delete from at_records where did = any(${tempDids}::text[])`
        await raw`delete from at_credentials where did = any(${tempDids}::text[])`
        await raw`delete from at_audit where actor_did = any(${tempDids}::text[])`
      }
      if (tempEvents.length) {
        await raw`delete from at_audit where event_id = any(${tempEvents}::uuid[])`
        await raw`delete from events where id = any(${tempEvents}::uuid[])`
      }
      if (tempAccounts.length) {
        await raw`delete from accounts where id = any(${tempAccounts}::uuid[])`
      }
      await raw.end({ timeout: 5 })
    }
    await db?.sql.end({ timeout: 5 }).catch(() => undefined)
    moduleWithResolver._resolveFilename = originalResolve
  })

  test('admin and approval routes refuse unsigned requests', async () => {
    const admin = `${base}/api/v1/events/demo-gathering/admin/atproto`
    expect((await fetch(admin)).status).toBe(401)
    expect((await fetch(admin, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(admin, { method: 'DELETE' })).status).toBe(401)
    expect((await fetch(`${admin}/publish`, { method: 'POST', body: '{"what":"all"}' })).status).toBe(401)
    expect((await fetch(`${admin}/sessions/${randomUUID()}`, { method: 'POST', body: '{"action":"republish"}' })).status).toBe(401)
    expect((await fetch(`${base}/api/v1/events/demo-gathering/approvals`)).status).toBe(401)
    expect((await fetch(`${base}/api/v1/events/demo-gathering/approvals`, { method: 'POST', body: '{}' })).status).toBe(401)
    // A cross-site browser request is refused before anything else.
    expect((await fetch(admin, { method: 'POST', body: '{}', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  })

  test('a CAS mismatch re-reads the live record and retries once against its cid', async () => {
    // A gathering of our own with venues that were never published (no stored cid).
    const event = await createTestGathering(raw, { tag: 'cas', withProgram: true })
    gatherings.push(event)
    const store = new Map<string, string>()
    const calls: Array<{ rkey: string; swapRecord: unknown; reason: string }> = []
    const deps: import('../src/lib/atproto/publish').PublishDeps = {
      put: async (input) => {
        calls.push({ rkey: input.rkey, swapRecord: input.swapRecord, reason: input.reason })
        const uri = `at://${GATHERING}/${input.collection}/${input.rkey}`
        const current = store.get(uri) ?? null
        if (input.swapRecord !== undefined && input.swapRecord !== current) throw Object.assign(new Error('InvalidSwap: record was at another cid'), { error: 'InvalidSwap' })
        const cid = `bafyrei${input.rkey}${calls.length}`.padEnd(59, 'a')
        store.set(uri, cid)
        return { uri, cid, auditId: 'audit' }
      },
      del: async () => ({ auditId: 'audit' }),
      getRecord: async <T,>(repo: string, collection: string, rkey: string) => {
        const uri = `at://${repo}/${collection}/${rkey}`
        const cid = store.get(uri)
        return cid ? { uri, cid, value: {} as T } : null
      },
      actorDidFor: async () => GATHERING,
      indexedCid: async () => null,
      persist: false,
    }
    const [venue] = await raw<{ id: string }[]>`select id from venues where event_id = ${event!.id} order by created_at, id limit 1`
    const rkey = (require('../src/lib/atproto/rkey') as typeof import('../src/lib/atproto/rkey')).deterministicRkey('venue', venue!.id)
    // Someone else already wrote this venue record at a cid we never saw.
    store.set(`at://${GATHERING}/schellingpoint.draft.venue/${rkey}`, 'bafyreiforeignwriteaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const out = await publish.publishVenues({ eventId: event!.id, callerUserId: null }, deps)
    expect(out.results.filter((r) => r.error)).toEqual([])
    const forVenue = calls.filter((c) => c.rkey === rkey)
    expect(forVenue).toHaveLength(2)
    expect(forVenue[0]!.swapRecord).toBeNull()
    expect(forVenue[1]!.swapRecord).toBe('bafyreiforeignwriteaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(forVenue[1]!.reason).toMatch(/retried after CAS mismatch/)
  })

  test('the registry is an LRU bounded at 64 ports', async () => {
    actors.configureGatheringActors({
      actorDidFor: async (id) => `did:plc:lru${id.padStart(21, 'a')}`,
      sessionFor: () => ({ putRecord: async () => ({ uri: 'at://x/y/z', cid: CID }), deleteRecord: async () => undefined }),
      index: null,
    })
    for (let i = 0; i < 70; i++) await actors.actorForEvent(String(i))
    expect(actors.cachedGatheringActorCount()).toBe(64)
    const first = await actors.actorForEvent('69')
    expect(await actors.actorForEvent('69')).toBe(first)
    actors.configureGatheringActors()
  })

  test('a revoked credential fails only its own gathering, then disables with an organiser banner', async () => {
    const make = async (slug: string) => {
      const [row] = await raw<{ id: string }[]>`
        insert into events (slug, name, start_date, end_date, status) values (${slug}, ${`F failure path ${slug}`}, '2026-10-01', '2026-10-02', 'published') returning id
      `
      tempEvents.push(row!.id)
      return row!.id
    }
    const revokedEvent = await make(`f-revoked-${RUN}`)
    const healthyEvent = await make(`f-healthy-${RUN}`)

    // The revoked gathering: a credential row whose password the PDS rejects.
    const revokedDid = `did:plc:${RUN.padEnd(24, 'q').slice(0, 24).replace(/[^a-z2-7]/g, 'q')}`
    tempDids.push(revokedDid)
    const { wrapped, keyVersion } = crypto.wrapSecret('definitely-not-the-password')
    await raw`
      insert into at_credentials (did, kind, identifier, wrapped, key_version, pds_url, rotated_at)
      values (${revokedDid}, 'app-password', ${`nobody-${RUN}.test`}, ${wrapped}, ${keyVersion}, ${process.env.PDS_URL ?? pds}, now())
    `
    await raw`update events set actor_did = ${revokedDid} where id = ${revokedEvent}`

    // The healthy gathering: a real DID minted on the local PDS. The minting organizer has to be
    // a real account — `at_credentials.created_by` references `accounts(id)` (migration 0035).
    const [minter] = await raw<{ id: string }[]>`
      insert into accounts (did, handle, email, kind)
      values (${`did:plc:fminter${RUN}`}, ${`f-minter-${RUN}.test`}, ${`f-minter-${RUN}@example.test`}, 'custodial')
      returning id
    `
    tempAccounts.push(minter!.id)
    const minted = await actors.mintGatheringActor(healthyEvent, minter!.id)
    tempDids.push(minted.did)

    const write = (eventId: string, rkey: string) =>
      actors.putRecordAsGathering({ eventId, callerUserId: null, action: 'publish-track', collection: 'schellingpoint.draft.track', rkey, record: track(), reason: 'failure-path test' })

    await expect(write(revokedEvent, 'revoked1')).rejects.toMatchObject({ name: 'GatheringCredentialError' })
    await expect(write(healthyEvent, 'healthy1')).resolves.toMatchObject({ uri: `at://${minted.did}/schellingpoint.draft.track/healthy1` })
    let [cred] = await raw<{ consecutive_failures: number; disabled_at: string | null; last_error: string | null }[]>`
      select consecutive_failures, disabled_at, last_error from at_credentials where did = ${revokedDid}
    `
    expect(cred!.consecutive_failures).toBe(1)
    expect(cred!.last_error).toBeTruthy()
    expect((await actors.gatheringActorHealth(revokedEvent)).state).toBe('failing')

    await expect(write(revokedEvent, 'revoked2')).rejects.toMatchObject({ name: 'GatheringCredentialError' })
    await expect(write(revokedEvent, 'revoked3')).rejects.toMatchObject({ name: 'GatheringCredentialError' })
    ;[cred] = await raw`select consecutive_failures, disabled_at, last_error from at_credentials where did = ${revokedDid}`
    expect(cred!.disabled_at).not.toBeNull()
    const health = await actors.gatheringActorHealth(revokedEvent)
    expect(health.state).toBe('disabled')
    expect(health.banner).toMatch(/Reconnect the gathering account/)
    await expect(write(revokedEvent, 'revoked4')).rejects.toThrow(/disabled after repeated authentication failures/)

    // The healthy gathering is untouched throughout.
    await expect(write(healthyEvent, 'healthy2')).resolves.toMatchObject({ cid: expect.any(String) })
    expect((await actors.gatheringActorHealth(healthyEvent)).state).toBe('ok')

    await actors.resetGatheringCredential(revokedEvent)
    ;[cred] = await raw`select consecutive_failures, disabled_at, last_error from at_credentials where did = ${revokedDid}`
    expect(cred).toMatchObject({ consecutive_failures: 0, disabled_at: null })
  })
})
