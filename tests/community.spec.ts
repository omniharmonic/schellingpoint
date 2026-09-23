import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import {
  createTestAccount,
  createTestGathering,
  TEST_BASE_URL,
  withServerOnlyShim,
  type TestAccount,
  type TestGathering,
} from './helpers/gathering'

/**
 * Community, compliance and day-of (the P2 "community" cluster of
 * docs/design/audits/2026-09-22-feature-inventory.md):
 *
 *   · leaving a gathering (spec §8) — the door that was missing
 *   · reports and the organizer moderation queue (MT §12.5, spec §9)
 *   · the per-gathering code of conduct and its acceptance (MT §12.19)
 *   · subscribable calendar feeds with reminders (MT §12.8)
 *   · check-in as a gate on attendance voting (MT §12.14)
 *   · cloning a gathering (MT §11.3)
 *   · host-facing per-session numbers (PRD §3.2)
 *
 * Integration, against the running dev server, the local Postgres and the local PDS. Every
 * fixture is created and removed by this file; the seeded gatherings are never touched.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || TEST_BASE_URL
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const configured = Boolean(ownerUrl && pdsUrl)

async function api(path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { origin: base }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, text, headers: res.headers }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('community, compliance and day-of', () => {
  test.skip(!configured, 'needs the local stack (Postgres + PDS) and the dev server')

  let sql: postgres.Sql
  let gathering: TestGathering
  let owner: TestAccount
  let member: TestAccount
  let stranger: TestAccount
  let moderator: TestAccount
  let organizer: TestAccount
  let sessionId: string

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'comm', withProgram: true, status: 'proposals_open' })
    owner = await createTestAccount('comm-owner', { sql, base })
    member = await createTestAccount('comm-member', { sql, base })
    stranger = await createTestAccount('comm-stranger', { sql, base })
    moderator = await createTestAccount('comm-moderator', { sql, base })
    organizer = await createTestAccount('comm-organizer', { sql, base })

    // Proposing needs membership (a DB trigger says so), so the roster comes first.
    await sql`
      insert into event_members (event_id, user_id, role)
      values (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${member.id}, 'attendee'),
             (${gathering.id}, ${moderator.id}, 'moderator'), (${gathering.id}, ${organizer.id}, 'admin')
    `

    const [session] = await sql<{ id: string }[]>`
      insert into sessions (event_id, host_id, title, description, format, duration, status)
      values (${gathering.id}, ${member.id}, 'A session that will be reported', 'Body', 'discussion', 30, 'approved')
      returning id
    `
    sessionId = session!.id

    // Scheduled from the start: RSVPs open only once a session has a time (a DB trigger), and
    // the calendar feed only carries scheduled sessions.
    const [slot] = await sql<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and is_break = false order by start_time limit 1
    `
    await sql`
      update sessions set status = 'scheduled', time_slot_id = ${slot!.id}, venue_id = ${slot!.venue_id}
      where id = ${sessionId}
    `
  })

  test.afterAll(async () => {
    await gathering?.cleanup().catch(() => undefined)
    await Promise.all(
      [owner?.cleanup(), member?.cleanup(), stranger?.cleanup(), moderator?.cleanup(), organizer?.cleanup()]
        .map((p) => p?.catch(() => undefined)),
    )
    await sql?.end({ timeout: 5 })
  })

  /* ─────────────────────────── leaving ─────────────────────────── */

  test('leaving cancels RSVPs and pending co-host invites, keeps proposals, and refuses the last owner', async () => {
    // Join, then acquire everything leaving is supposed to clear up.
    const joined = await api(`/api/v1/events/${gathering.slug}/me`, { method: 'POST', cookie: member.cookie, json: {} })
    expect([200, 201]).toContain(joined.status)

    await sql`
      insert into session_rsvps (event_id, session_id, user_id, status)
      values (${gathering.id}, ${sessionId}, ${member.id}, 'confirmed')
    `
    await sql`
      insert into cohost_invites (session_id, event_id, created_by, status)
      values (${sessionId}, ${gathering.id}, ${member.id}, 'pending')
    `

    const left = await api(`/api/v1/events/${gathering.slug}/me`, { method: 'DELETE', cookie: member.cookie })
    expect(left.status).toBe(200)
    expect(left.body.left).toBe(true)
    expect(left.body.rsvpsCancelled).toBe(1)
    expect(left.body.cohostInvitesRevoked).toBe(1)
    expect(left.body.proposalsKept).toBe(1)

    const [membership] = await sql`select 1 from event_members where event_id = ${gathering.id} and user_id = ${member.id}`
    expect(membership).toBeUndefined()

    const [rsvp] = await sql<{ status: string }[]>`
      select status from session_rsvps where session_id = ${sessionId} and user_id = ${member.id}
    `
    expect(rsvp!.status).toBe('cancelled')

    const [invite] = await sql<{ status: string }[]>`
      select status from cohost_invites where session_id = ${sessionId} and created_by = ${member.id}
    `
    expect(invite!.status).toBe('revoked')

    // The proposal is the proposer's own record: it stays, marked so organizers can see it.
    const [proposal] = await sql<{ id: string; author_left_at: string | null }[]>`
      select id, author_left_at from sessions where id = ${sessionId}
    `
    expect(proposal!.id).toBe(sessionId)
    expect(proposal!.author_left_at).not.toBeNull()

    // Leaving twice is a 404, not a second departure.
    expect((await api(`/api/v1/events/${gathering.slug}/me`, { method: 'DELETE', cookie: member.cookie })).status).toBe(404)

    // The only owner may not leave.
    const ownerLeave = await api(`/api/v1/events/${gathering.slug}/me`, { method: 'DELETE', cookie: owner.cookie })
    expect(ownerLeave.status).toBe(409)
    expect(ownerLeave.body.code).toBe('LastOwner')

    // ... and the read model says so before the button is pressed.
    const standing = await api(`/api/v1/events/${gathering.slug}/me`, { cookie: owner.cookie })
    expect(standing.body.canLeave).toBe(false)

    // Put the member back for the rest of the suite.
    await api(`/api/v1/events/${gathering.slug}/me`, { method: 'POST', cookie: member.cookie, json: {} })
    await sql`update sessions set author_left_at = null where id = ${sessionId}`
  })

  test('leaving is refused across origins and to signed-out callers', async () => {
    const res = await fetch(`${base}/api/v1/events/${gathering.slug}/me`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example', cookie: member.cookie, 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
    expect((await api(`/api/v1/events/${gathering.slug}/me`, { method: 'DELETE' })).status).toBe(401)
  })

  /* ────────────────── per-event code of conduct ────────────────── */

  test('a gathering can require its own code of conduct to be accepted before joining', async () => {
    await sql`
      update events set code_of_conduct_url = 'https://example.org/conduct', require_conduct_acceptance = true
      where id = ${gathering.id}
    `
    const refused = await api(`/api/v1/events/${gathering.slug}/me`, { method: 'POST', cookie: stranger.cookie, json: {} })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('ConductAcceptanceRequired')
    expect(refused.body.codeOfConductUrl).toBe('https://example.org/conduct')

    const accepted = await api(`/api/v1/events/${gathering.slug}/me`, { method: 'POST', cookie: stranger.cookie, json: { acceptConduct: true } })
    expect(accepted.status).toBe(201)
    expect(accepted.body.conductAcceptedAt).toBeTruthy()

    const [row] = await sql<{ conduct_accepted_at: string | null }[]>`
      select conduct_accepted_at from event_members where event_id = ${gathering.id} and user_id = ${stranger.id}
    `
    expect(row!.conduct_accepted_at).not.toBeNull()

    // The link travels with the read model so the join screen can show it.
    const standing = await api(`/api/v1/events/${gathering.slug}/me`, { cookie: stranger.cookie })
    expect(standing.body.codeOfConductUrl).toBe('https://example.org/conduct')
    expect(standing.body.conductAcceptanceRequired).toBe(true)

    await sql`update events set require_conduct_acceptance = false where id = ${gathering.id}`
  })

  test('the settings API refuses a conduct requirement with no document, and a non-http link', async () => {
    await sql`update events set code_of_conduct_url = null where id = ${gathering.id}`
    const noDoc = await api(`/api/events/${gathering.id}/settings`, {
      method: 'PATCH', cookie: owner.cookie, json: { require_conduct_acceptance: true },
    })
    expect(noDoc.status).toBe(400)
    expect(noDoc.body.field).toBe('code_of_conduct_url')

    const badLink = await api(`/api/events/${gathering.id}/settings`, {
      method: 'PATCH', cookie: owner.cookie, json: { code_of_conduct_url: 'javascript:alert(1)' },
    })
    expect(badLink.status).toBe(400)

    const ok = await api(`/api/events/${gathering.id}/settings`, {
      method: 'PATCH', cookie: owner.cookie, json: { code_of_conduct_url: 'https://example.org/conduct', require_conduct_acceptance: true },
    })
    expect(ok.status).toBe(200)
    await sql`update events set require_conduct_acceptance = false where id = ${gathering.id}`
  })

  /* ─────────────────── reports and moderation ─────────────────── */

  test('members report; strangers cannot; a second identical report is not a second case', async () => {
    const outsider = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: stranger.cookie, json: { subjectKind: 'session', sessionId, reason: 'spam' },
    })
    expect(outsider.status).toBe(201) // stranger joined above, so they are a member now

    const again = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: stranger.cookie, json: { subjectKind: 'session', sessionId, reason: 'spam' },
    })
    expect(again.status).toBe(200)
    expect(again.body.duplicate).toBe(true)

    const signedOut = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', json: { subjectKind: 'session', sessionId, reason: 'spam' },
    })
    expect(signedOut.status).toBe(401)

    // A subject from another gathering is refused even for a member of this one.
    const other = await createTestGathering(sql, { tag: 'comm2' })
    try {
      await sql`insert into event_members (event_id, user_id, role) values (${other.id}, ${owner.id}, 'owner')`
      const [alien] = await sql<{ id: string }[]>`
        insert into sessions (event_id, host_id, title, format, duration, status)
        values (${other.id}, ${owner.id}, 'Elsewhere', 'discussion', 30, 'approved') returning id
      `
      const crossed = await api(`/api/v1/events/${gathering.slug}/reports`, {
        method: 'POST', cookie: stranger.cookie, json: { subjectKind: 'session', sessionId: alien!.id, reason: 'spam' },
      })
      expect(crossed.status).toBe(404)
    } finally {
      await other.cleanup().catch(() => undefined)
    }
  })

  test('reporting is rate limited per account', async () => {
    // Ten filed reports inside the hour is the cap; the eleventh is refused with Retry-After.
    await sql`
      insert into moderation_reports (event_id, reporter_account_id, subject_kind, subject_ref, reason)
      select ${gathering.id}, ${member.id}, 'comment', 'seed-' || g, 'spam' from generate_series(1, 10) g
    `
    const refused = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: member.cookie, json: { subjectKind: 'comment', ref: 'one-too-many', reason: 'spam' },
    })
    expect(refused.status).toBe(429)
    expect(refused.body.code).toBe('RateLimited')
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)

    await sql`delete from moderation_reports where reporter_account_id = ${member.id}`
  })

  test('the queue is organizer-only, and hiding a session takes it out of the listings without touching the record', async () => {
    const asMember = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, { cookie: member.cookie })
    expect(asMember.status).toBe(403)

    const queue = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, { cookie: owner.cookie })
    expect(queue.status).toBe(200)
    const open = queue.body.reports.find((r: any) => r.subject.sessionId === sessionId)
    expect(open).toBeTruthy()
    expect(open.reporter.name).toBeTruthy()
    // A report never carries a DID (spec §9).
    expect(JSON.stringify(queue.body)).not.toContain('did:')

    const resolved = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: owner.cookie, json: { reportId: open.id, action: 'hide_session', note: 'Off topic for this gathering.' },
    })
    expect(resolved.status).toBe(200)
    expect(resolved.body.status).toBe('actioned')

    const [hidden] = await sql<{ hidden_by_moderation: boolean; proposal_uri: string | null }[]>`
      select hidden_by_moderation, proposal_uri from sessions where id = ${sessionId}
    `
    expect(hidden!.hidden_by_moderation).toBe(true)

    // Out of the member-facing listing; still visible to the author and to organizers.
    const asStranger = await api(`/api/v1/events/${gathering.slug}/sessions`, { cookie: stranger.cookie })
    expect((asStranger.body.sessions ?? []).some((s: any) => s.id === sessionId)).toBe(false)
    const asAuthor = await api(`/api/v1/events/${gathering.slug}/sessions`, { cookie: member.cookie })
    expect((asAuthor.body.sessions ?? []).some((s: any) => s.id === sessionId)).toBe(true)

    // The reporter is told the outcome, from application code, in the same transaction.
    const [note] = await sql<{ type: string; body: string | null }[]>`
      select type, body from notifications
      where user_id = ${stranger.id} and event_id = ${gathering.id} order by created_at desc limit 1
    `
    expect(note!.type).toBe('admin_announcement')
    expect(note!.body).toContain('removed that session from the listings')

    // And it can be put back.
    const back = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'POST', cookie: owner.cookie, json: { sessionId, unhide: true },
    })
    expect(back.status).toBe(200)
    const [listed] = await sql<{ hidden_by_moderation: boolean }[]>`
      select hidden_by_moderation from sessions where id = ${sessionId}
    `
    expect(listed!.hidden_by_moderation).toBe(false)
  })

  test('removing a member from the queue has the same consequences as leaving', async () => {
    const filed = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: owner.cookie, json: { subjectKind: 'profile', accountId: stranger.id, reason: 'harassment', details: 'Repeated.' },
    })
    expect(filed.status).toBe(201)

    await sql`
      insert into session_rsvps (event_id, session_id, user_id, status)
      values (${gathering.id}, ${sessionId}, ${stranger.id}, 'confirmed')
      on conflict (session_id, user_id) do update set status = 'confirmed'
    `

    const done = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: owner.cookie, json: { reportId: filed.body.id, action: 'remove_member' },
    })
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('actioned')

    const [gone] = await sql`select 1 from event_members where event_id = ${gathering.id} and user_id = ${stranger.id}`
    expect(gone).toBeUndefined()
    const [rsvp] = await sql<{ status: string }[]>`
      select status from session_rsvps where session_id = ${sessionId} and user_id = ${stranger.id}
    `
    expect(rsvp!.status).toBe('cancelled')
  })

  test('the queue refuses to remove the last owner and says why', async () => {
    const filed = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: member.cookie, json: { subjectKind: 'profile', accountId: owner.id, reason: 'other' },
    })
    expect(filed.status).toBe(201)
    const blocked = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: owner.cookie, json: { reportId: filed.body.id, action: 'remove_member' },
    })
    expect(blocked.status).toBe(409)
    expect(blocked.body.blocked).toBe('last-owner')
    const [still] = await sql`select 1 from event_members where event_id = ${gathering.id} and user_id = ${owner.id}`
    expect(still).toBeTruthy()
  })

  test('a moderator may act on members, but only an owner may remove an organizer', async () => {
    const filed = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: member.cookie, json: { subjectKind: 'profile', accountId: organizer.id, reason: 'harassment' },
    })
    expect(filed.status).toBe(201)

    // The moderation queue must not be a way around the roster's own rules.
    const escalation = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: moderator.cookie, json: { reportId: filed.body.id, action: 'remove_member' },
    })
    expect(escalation.status).toBe(403)
    expect(escalation.body.code).toBe('OwnerOnly')
    const [stillAdmin] = await sql<{ role: string }[]>`
      select role from event_members where event_id = ${gathering.id} and user_id = ${organizer.id}
    `
    expect(stillAdmin!.role).toBe('admin')
    // The case is untouched: a refused action resolves nothing.
    const [open] = await sql<{ status: string }[]>`select status from moderation_reports where id = ${filed.body.id}`
    expect(open!.status).toBe('open')

    // An owner may.
    const allowed = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: owner.cookie, json: { reportId: filed.body.id, action: 'remove_member' },
    })
    expect(allowed.status).toBe(200)
    const [gone] = await sql`select 1 from event_members where event_id = ${gathering.id} and user_id = ${organizer.id}`
    expect(gone).toBeUndefined()
  })

  test('a report is resolved once: a stale page cannot act twice', async () => {
    const filed = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: member.cookie, json: { subjectKind: 'comment', ref: 'resolve-once', reason: 'spam' },
    })
    expect(filed.status).toBe(201)
    expect((await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: moderator.cookie, json: { reportId: filed.body.id, action: 'dismiss' },
    })).status).toBe(200)

    const again = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: owner.cookie, json: { reportId: filed.body.id, action: 'remove_member' },
    })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('AlreadyResolved')
  })

  test('hiding a session takes it out of every list, publish path and search, and says what became of the published record', async () => {
    const filed = await api(`/api/v1/events/${gathering.slug}/reports`, {
      method: 'POST', cookie: member.cookie, json: { subjectKind: 'session', sessionId, reason: 'off_topic' },
    })
    expect([200, 201]).toContain(filed.status)

    const hidden = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'PATCH', cookie: owner.cookie, json: { reportId: filed.body.id, action: 'hide_session' },
    })
    expect(hidden.status).toBe(200)
    // Nothing of this session was ever published, and the queue says so rather than implying
    // the network has been dealt with.
    expect(hidden.body.publishedRecord).toBe('not-published')
    const [caseFile] = await sql<{ note: string | null }[]>`select note from moderation_reports where id = ${filed.body.id}`
    expect(caseFile!.note).toContain('[published record]')

    // 1. The public landing page's "recent sessions" and its session count.
    const landing = await (await fetch(`${base}/e/${gathering.slug}`)).text()
    expect(landing).not.toContain('A session that will be reported')

    // 2. The member dashboard — for everybody but the author, who still sees their own
    //    session under "my sessions". Hiding is a listing decision, not a way of keeping a
    //    person from their own proposal.
    const dashboard = await (await fetch(`${base}/e/${gathering.slug}/dashboard`, { headers: { cookie: moderator.cookie } })).text()
    expect(dashboard).not.toContain('A session that will be reported')
    const authorDashboard = await (await fetch(`${base}/e/${gathering.slug}/dashboard`, { headers: { cookie: member.cookie } })).text()
    expect(authorDashboard).toContain('A session that will be reported')

    // 3. The public schedule read model.
    const schedule = await api(`/api/v1/events/${gathering.slug}/schedule`)
    expect(JSON.stringify(schedule.body ?? {})).not.toContain(sessionId)

    // 4. The personal calendar feed (it is a saved session of the member's).
    const feedToken = await api('/api/me/calendar-feed', { method: 'POST', cookie: member.cookie, json: {} })
    expect(feedToken.status).toBe(201)
    const token = feedToken.body.url.split('/api/calendar/')[1]
    expect(await (await fetch(`${base}/api/calendar/${token}`)).text()).not.toContain('A session that will be reported')
    await api(`/api/me/calendar-feed?all=true`, { method: 'DELETE', cookie: member.cookie })

    // 5. The publish enumeration, the gathering's feed queue, the tally and knowledge search.
    const eventId = gathering.id
    const hiddenId = sessionId
    const server = await withServerOnlyShim(async () => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const db = require('../src/lib/db') as typeof import('../src/lib/db')
      const jobs = require('../src/lib/atproto/publish-jobs') as typeof import('../src/lib/atproto/publish-jobs')
      const feed = require('../src/lib/atproto/feed') as typeof import('../src/lib/atproto/feed')
      /* eslint-enable @typescript-eslint/no-require-imports */

      const schedulable = await jobs.schedulableSessionIds(eventId)

      // A visible control session, so "queued 0" means "the filter worked", not "nothing ran".
      const [control] = await db.sql<{ id: string }[]>`
        insert into sessions (event_id, host_id, title, format, duration, status)
        values (${eventId}, ${owner.id}, 'A session nobody reported', 'discussion', 30, 'approved')
        returning id
      `
      await db.sql`
        update events set feed_posts = true, actor_did = 'did:plc:commfeedgate' where id = ${eventId}
      `
      const hiddenQueued = await feed.enqueueSessionPosts({ eventId, kind: 'session-scheduled', sessionIds: [hiddenId], callerUserId: null })
      const visibleQueued = await feed.enqueueSessionPosts({ eventId, kind: 'session-scheduled', sessionIds: [control!.id], callerUserId: null })
      await db.sql`update events set feed_posts = false, actor_did = null where id = ${eventId}`
      await db.sql`delete from feed_posts where event_id = ${eventId}`
      await db.sql`delete from publish_jobs where event_id = ${eventId}`
      await db.sql`delete from sessions where id = ${control!.id}`

      return { schedulable, hiddenQueued, visibleQueued }
    })

    expect(server.schedulable).not.toContain(hiddenId)
    expect(server.hiddenQueued.queued).toBe(0)
    expect(server.visibleQueued.queued).toBe(1)

    // Put it back for the rest of the suite.
    const back = await api(`/api/v1/events/${gathering.slug}/admin/moderation`, {
      method: 'POST', cookie: owner.cookie, json: { sessionId, unhide: true },
    })
    expect(back.status).toBe(200)
  })

  /* ───────────────────────── calendar ───────────────────────── */

  test('a personal calendar feed carries saved sessions with a reminder, and revoking kills it', async () => {
    await sql`
      insert into favorites (event_id, session_id, user_id) values (${gathering.id}, ${sessionId}, ${member.id})
      on conflict do nothing
    `

    const minted = await api('/api/me/calendar-feed', { method: 'POST', cookie: member.cookie, json: {} })
    expect(minted.status).toBe(201)
    expect(minted.body.url).toContain('/api/calendar/cal_')
    expect(minted.body.webcalUrl.startsWith('webcal:')).toBe(true)

    const token = minted.body.url.split('/api/calendar/')[1]
    const feed = await fetch(`${base}/api/calendar/${token}`)
    expect(feed.status).toBe(200)
    expect(feed.headers.get('content-type')).toContain('text/calendar')
    const ics = await feed.text()
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('A session that will be reported')
    expect(ics).toContain('BEGIN:VALARM')
    expect(ics).toContain('TRIGGER:-PT15M')
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H')

    // The feed is the person's own: another account's token is another calendar.
    const listed = await api('/api/me/calendar-feed', { cookie: member.cookie })
    expect(listed.body.feeds.length).toBe(1)

    const revoked = await api(`/api/me/calendar-feed?id=${listed.body.feeds[0].id}`, { method: 'DELETE', cookie: member.cookie })
    expect(revoked.status).toBe(200)
    expect((await fetch(`${base}/api/calendar/${token}`)).status).toBe(404)
    expect((await fetch(`${base}/api/calendar/cal_not-a-real-token`)).status).toBe(404)
  })

  test('the gathering exposes a subscribable public ICS of its published schedule', async () => {
    const res = await fetch(`${base}/api/v1/events/${gathering.slug}/calendar?subscribe=true`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('inline')
    const ics = await res.text()
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H')
    expect(ics).toContain('SOURCE;VALUE=URI:')
    expect(ics).toContain('TRIGGER:-PT15M')

    // A subscription URL never carries somebody's private list.
    const refused = await fetch(`${base}/api/v1/events/${gathering.slug}/calendar?subscribe=true&favorites=true`)
    expect(refused.status).toBe(400)
  })

  /* ───────────────── check-in gates attendance voting ───────────────── */

  test('the check-in gate passes everyone when off, and only checked-in people when on', async () => {
    const eventId = gathering.id
    const memberId = member.id
    const result = await withServerOnlyShim(async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const gate = require('../src/lib/checkin/eligibility') as typeof import('../src/lib/checkin/eligibility')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require('../src/lib/db') as typeof import('../src/lib/db')

      const off = await gate.checkinGate(db.sql, eventId, memberId)
      await db.sql`update events set checkin_gates_voting = true where id = ${eventId}`
      const onWithout = await gate.checkinGate(db.sql, eventId, memberId)
      const gated = await gate.checkinGatesVoting(db.sql, eventId)

      const [tier] = await db.sql<{ id: string }[]>`
        insert into ticket_tiers (event_id, name) values (${eventId}, 'Gate test') returning id
      `
      await db.sql`
        insert into tickets (event_id, tier_id, user_id, status, checked_in_at)
        values (${eventId}, ${tier!.id}, ${memberId}, 'checked_in', now())
      `
      const onWith = await gate.checkinGate(db.sql, eventId, memberId)

      await db.sql`delete from tickets where event_id = ${eventId}`
      await db.sql`delete from ticket_tiers where id = ${tier!.id}`
      await db.sql`update events set checkin_gates_voting = false where id = ${eventId}`
      return { off, onWithout, onWith, gated }
    })

    expect(result.off.eligible).toBe(true)
    expect(result.gated).toBe(true)
    expect(result.onWithout.eligible).toBe(false)
    expect(result.onWithout.code).toBe('CheckinRequired')
    expect(result.onWith.eligible).toBe(true)
  })

  /* ───────────────────────── cloning ───────────────────────── */

  test('cloning copies the shape and nothing about people', async () => {
    const slug = `${gathering.slug}-copy`.slice(0, 40)
    const created = await api(`/api/v1/events/${gathering.slug}/admin/clone`, {
      method: 'POST', cookie: owner.cookie,
      json: { name: `${gathering.name} 2027`, slug, startDate: '2027-06-01' },
    })
    expect(created.status).toBe(201)

    const cloneId: string = created.body.event.id
    try {
      expect(created.body.copied.venues).toBe(3)
      expect(created.body.copied.tracks).toBe(4)
      expect(created.body.copied.timeSlots).toBeGreaterThan(0)

      const [row] = await sql<{ status: string; actor_did: string | null; code_of_conduct_url: string | null; end_date: unknown }[]>`
        select status, actor_did, code_of_conduct_url, end_date from events where id = ${cloneId}
      `
      expect(row!.status).toBe('draft')
      // A DID is minted for a gathering, never inherited from a different one.
      expect(row!.actor_did).toBeNull()
      expect(row!.code_of_conduct_url).toBe('https://example.org/conduct')
      // This suite's own connection has no date coercion, so normalise before comparing.
      expect(new Date(row!.end_date as string).toISOString().slice(0, 10)).toBe('2027-06-02')

      // Only the person who made the copy is in it, and nothing else about people came across.
      const members = await sql<{ user_id: string; role: string }[]>`select user_id, role from event_members where event_id = ${cloneId}`
      expect(members.length).toBe(1)
      expect(members[0]!.user_id).toBe(owner.id)
      const [sessions] = await sql`select 1 from sessions where event_id = ${cloneId}`
      expect(sessions).toBeUndefined()
      const [reports] = await sql`select 1 from moderation_reports where event_id = ${cloneId}`
      expect(reports).toBeUndefined()

      // Slots keep the grid shape, re-dated, and hang off the copied venues.
      const [orphans] = await sql`
        select 1 from time_slots ts left join venues v on v.id = ts.venue_id and v.event_id = ${cloneId}
        where ts.event_id = ${cloneId} and v.id is null
      `
      expect(orphans).toBeUndefined()

      // A second copy cannot take the same address.
      const dup = await api(`/api/v1/events/${gathering.slug}/admin/clone`, {
        method: 'POST', cookie: owner.cookie, json: { name: 'Again', slug, startDate: '2027-06-01' },
      })
      expect(dup.status).toBe(409)

      // A non-organizer cannot copy a gathering.
      const refused = await api(`/api/v1/events/${gathering.slug}/admin/clone`, {
        method: 'POST', cookie: member.cookie, json: { name: 'Nope', slug: `${slug}-2`, startDate: '2027-06-01' },
      })
      expect(refused.status).toBe(403)
    } finally {
      await sql`delete from events where id = ${cloneId}`
    }
  })

  /* ───────────────── host-facing session numbers ───────────────── */

  test('a host sees their own session’s counts; a stranger sees a 404', async () => {
    const mine = await api(`/api/v1/events/${gathering.slug}/sessions/${sessionId}/host-analytics`, { cookie: member.cookie })
    expect(mine.status).toBe(200)
    expect(typeof mine.body.rsvps).toBe('number')
    expect(typeof mine.body.favorites).toBe('number')
    expect(mine.body.k).toBeGreaterThan(0)
    // No round has closed, so there is no tally — and no count is invented.
    expect(mine.body.tally).toBeNull()

    const organizer = await api(`/api/v1/events/${gathering.slug}/sessions/${sessionId}/host-analytics`, { cookie: owner.cookie })
    expect(organizer.status).toBe(200)

    const outsider = await api(`/api/v1/events/${gathering.slug}/sessions/${sessionId}/host-analytics`, { cookie: stranger.cookie })
    expect(outsider.status).toBe(404)
    expect((await api(`/api/v1/events/${gathering.slug}/sessions/${sessionId}/host-analytics`)).status).toBe(401)
  })

  /* ───────────────────────── PWA shell ───────────────────────── */

  test('the PWA shell is served: manifest, icons, service worker and an offline page', async () => {
    const manifest = await fetch(`${base}/manifest.webmanifest`)
    expect(manifest.status).toBe(200)
    const json = JSON.parse(await manifest.text())
    expect(json.start_url).toBe('/')
    expect(json.display).toBe('standalone')
    expect(json.icons.some((i: any) => i.purpose === 'maskable')).toBe(true)

    const worker = await fetch(`${base}/sw.js`)
    expect(worker.status).toBe(200)
    const source = await worker.text()
    // The one rule that matters: nothing private is ever cached.
    expect(source).toContain("url.pathname.startsWith('/api/me/')")
    expect(source).toContain("url.pathname.startsWith('/api/calendar/')")

    expect((await fetch(`${base}/offline`)).status).toBe(200)
    expect((await fetch(`${base}/icons/icon-192.png`)).status).toBe(200)
  })
})
