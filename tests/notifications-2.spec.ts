import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * The second notifications suite: the four types that were declared but never fired, the
 * lifecycle/reminder job, the announcements and organizer alerts, and email hygiene
 * (unsubscribe, digest). Covers the P2-1 … P2-10 cluster of
 * docs/design/audits/2026-09-22-feature-inventory.md.
 *
 * Runs against the local stack and the dev server on :3001 with mail disabled. Every
 * gathering and account is this suite's own (tests/helpers) and is deleted afterwards; the
 * lifecycle job is always scoped to those gatherings so a run never touches seeded data.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

// `server-only` is a bundler marker; resolve it to Next's empty stub so the real modules load.
type Resolver = (request: string, ...rest: unknown[]) => string
const M = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = M._resolveFilename
const SERVER_ONLY_STUB = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? SERVER_ONLY_STUB : originalResolve.call(this, request, ...rest)
}
/* eslint-disable @typescript-eslint/no-require-imports */
const db = require('../src/lib/db') as typeof import('../src/lib/db')
const transition = require('../src/lib/events/transition') as typeof import('../src/lib/events/transition')
const notifications = require('../src/lib/notifications') as typeof import('../src/lib/notifications')
const job = require('../src/lib/events/lifecycle-job') as typeof import('../src/lib/events/lifecycle-job')
const unsubscribe = require('../src/lib/email/unsubscribe') as typeof import('../src/lib/email/unsubscribe')
const emails = require('../src/lib/email/notification-emails') as typeof import('../src/lib/email/notification-emails')
const mail = require('../src/lib/auth/mail') as typeof import('../src/lib/auth/mail')
/* eslint-enable @typescript-eslint/no-require-imports */

class Rollback extends Error {}

async function rolledBack(fn: (t: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await db.sql
    .begin(async (t) => {
      await fn(t)
      throw new Rollback()
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e
    })
}

/** Rows in a person's feed of one type for one gathering. */
async function feedOf(userId: string, eventId: string, type?: string) {
  return db.sql<{ type: string; title: string; body: string | null; action_url: string | null }[]>`
    select type, title, body, action_url from notifications
    where user_id = ${userId} and event_id = ${eventId}
      ${type ? db.sql`and type = ${type}` : db.sql``}
    order by created_at, id
  `
}

const json = (cookie: string) => ({ cookie, origin: base, 'content-type': 'application/json' })

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('notifications: the types that never fired, the clock, and email hygiene', () => {
  test.skip(!isLocal, 'DATABASE_URL is not a local Postgres (see docs/ATPROTO_APPVIEW_PLAN.md §7.3)')

  test.afterAll(async () => {
    M._resolveFilename = originalResolve
    await db.sql.end({ timeout: 5 })
  })

  // ---------------------------------------------------------------------------
  // Pure / library
  // ---------------------------------------------------------------------------

  test('the three new types are in the database CHECK and agree with the category function', async () => {
    const added = ['event_published', 'proposals_open', 'rsvp_promoted'] as const
    const rows = await db.sql<{ type: string; category: string }[]>`
      select t as type, public.get_notification_category(t) as category
      from unnest(${added as unknown as string[]}::text[]) as t
    `
    expect(Object.fromEntries(rows.map((r) => [r.type, r.category]))).toEqual({
      event_published: 'event_announcements',
      proposals_open: 'event_announcements',
      rsvp_promoted: 'session_updates',
    })
    // `voting_updates` now controls something real (inventory 8.13 / P2-9).
    const [voting] = await db.sql<{ category: string }[]>`select public.get_notification_category('voting_opened') as category`
    expect(voting.category).toBe('voting_updates')

    // And the CHECK accepts them: an unknown type is still refused.
    await rolledBack(async (t) => {
      const [account] = await t<{ id: string }[]>`
        insert into accounts (did, handle, email, kind, email_verified_at)
        values (${`did:plc:n2t${randomUUID().slice(0, 8)}`}, ${`n2t-${randomUUID().slice(0, 8)}.test`}, null, 'custodial', now())
        returning id
      `
      for (const type of added) {
        expect(await notifications.notify(t, { eventId: null, userIds: [account.id], type, title: `n2 ${type}` })).toBe(1)
      }
      await t`savepoint bad_type`
      await expect(
        t`select public.emit_notifications(null, ${[account.id]}::uuid[], 'not_a_type', 'x', null, null, '{}'::jsonb)`,
      ).rejects.toMatchObject({ code: '23514' })
      await t`rollback to savepoint bad_type`
    })
  })

  test('unsubscribe tokens round-trip and refuse a tampered signature', () => {
    const accountId = randomUUID()
    const eventId = randomUUID()
    const scoped = unsubscribe.unsubscribeToken({ accountId, eventId })
    expect(unsubscribe.verifyUnsubscribeToken(scoped)).toEqual({ accountId, eventId })

    const global = unsubscribe.unsubscribeToken({ accountId, eventId: null })
    expect(unsubscribe.verifyUnsubscribeToken(global)).toEqual({ accountId, eventId: null })
    // The two are not interchangeable: an event token cannot be re-pointed at another event.
    expect(unsubscribe.verifyUnsubscribeToken(scoped.replace(eventId, randomUUID()))).toBeNull()
    expect(unsubscribe.verifyUnsubscribeToken(`${scoped}x`)).toBeNull()
    expect(unsubscribe.verifyUnsubscribeToken('')).toBeNull()
    expect(unsubscribe.verifyUnsubscribeToken(null)).toBeNull()

    const headers = unsubscribe.unsubscribeHeaders({ accountId, eventId })
    expect(headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(headers?.['List-Unsubscribe']).toContain('/api/unsubscribe?t=')
  })

  test('a notification email carries the unsubscribe link and RFC 8058 headers', () => {
    const scope = { accountId: randomUUID(), eventId: randomUUID() }
    const rendered = emails.renderNotificationEmail({
      type: 'event_reminder',
      title: 'Test gathering starts tomorrow',
      body: 'See you there.',
      actionUrl: '/e/test/schedule',
      recipientName: 'Ada',
      event: { name: 'Test gathering', slug: 'test' },
      unsubscribeUrl: unsubscribe.unsubscribeUrl(scope),
      unsubscribeHeaders: unsubscribe.unsubscribeHeaders(scope),
    })
    expect(rendered.html).toContain('Stop emails like this')
    expect(rendered.html).toContain('/unsubscribe?t=')
    expect(rendered.text).toContain('Stop these emails:')
    expect(rendered.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

    // Without a link (no signing key) nothing breaks and no empty href is emitted.
    const bare = emails.renderNotificationEmail({
      type: 'event_reminder', title: 'T', body: null, actionUrl: null, recipientName: null, event: null,
    })
    expect(bare.html).not.toContain('Stop emails like this')
    expect(bare.headers).toBeUndefined()
  })

  test('dueReminder fires once in each window and never after the start', () => {
    const start = new Date('2026-06-01T00:00:00Z')
    const at = (ms: number) => job.dueReminder(start, new Date(start.getTime() - ms))
    expect(at(30 * 60_000)).toBe('1h')
    expect(at(59 * 60_000)).toBe('1h')
    expect(at(2 * 3_600_000)).toBe('24h')
    expect(at(23 * 3_600_000)).toBe('24h')
    expect(at(25 * 3_600_000)).toBeNull()
    expect(job.dueReminder(start, start)).toBeNull()
    expect(job.dueReminder(start, new Date(start.getTime() + 1))).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // The clock: automatic phases, reminders, starting-soon, alerts
  // ---------------------------------------------------------------------------

  test.describe('the lifecycle job', () => {
    let gathering: TestGathering
    let owner: TestAccount
    let member: TestAccount

    test.beforeAll(async () => {
      owner = await createTestAccount('n2-owner', { sql: db.sql, base })
      member = await createTestAccount('n2-member', { sql: db.sql, base })
      gathering = await createTestGathering(db.sql, { tag: 'n2clock', status: 'published', startInDays: 10 })
      await db.sql`
        insert into event_members (event_id, user_id, role)
        values (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${member.id}, 'attendee')
      `
    })

    test.afterAll(async () => {
      await gathering?.cleanup().catch(() => undefined)
      await owner?.cleanup().catch(() => undefined)
      await member?.cleanup().catch(() => undefined)
    })

    test('with auto_lifecycle off nothing moves, however overdue the dates are', async () => {
      await db.sql`
        update events set proposals_open_at = now() - interval '1 hour', auto_lifecycle = false
        where id = ${gathering.id}
      `
      const report = await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })
      expect(report.transitions).toEqual([])
      const [row] = await db.sql<{ status: string }[]>`select status from events where id = ${gathering.id}`
      expect(row.status).toBe('published')
    })

    test('auto_lifecycle walks overdue phases in order, announcing each one to members', async () => {
      await db.sql`
        update events set auto_lifecycle = true,
          proposals_open_at = now() - interval '2 hours',
          voting_opens_at = now() - interval '1 hour',
          voting_closes_at = now() + interval '3 days'
        where id = ${gathering.id}
      `
      const report = await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })
      expect(report.transitions.map((t) => t.to)).toEqual(['proposals_open', 'voting_open'])

      const [row] = await db.sql<{ status: string }[]>`select status from events where id = ${gathering.id}`
      expect(row.status).toBe('voting_open')

      // Both announcements reached the member — proposals_open is the type that never fired.
      const feed = await feedOf(member.id, gathering.id)
      expect(feed.map((n) => n.type)).toEqual(['proposals_open', 'voting_opened'])
      expect(feed[0].action_url).toBe(`/e/${gathering.slug}/propose`)

      // Entering voting_open opened the round, exactly as the settings route does.
      const [round] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from vote_rounds where event_id = ${gathering.id} and phase = 'pre-event' and finalized_at is null
      `
      expect(round.n).toBe(1)

      // Idempotent: a second run has nothing left to do and writes nothing new.
      const again = await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })
      expect(again.transitions).toEqual([])
      expect((await feedOf(member.id, gathering.id)).length).toBe(2)
    })

    test('the 24 h and 1 h reminders go once each, and `event_reminder` finally fires', async () => {
      // Start the gathering tomorrow on its own clock, and stop the phase walk here.
      await db.sql`
        update events set auto_lifecycle = false,
          start_date = (current_date + 1), end_date = (current_date + 2)
        where id = ${gathering.id}
      `
      const [row] = await db.sql<{ start_date: string; timezone: string }[]>`
        select start_date::text as start_date, timezone from events where id = ${gathering.id}
      `
      const start = job.dayStart(row.start_date, row.timezone)

      const first = await job.runLifecycleJob(new Date(start.getTime() - 5 * 3_600_000), { eventIds: [gathering.id], skipPrune: true })
      expect(first.reminders).toBeGreaterThanOrEqual(2) // owner + member
      const repeat = await job.runLifecycleJob(new Date(start.getTime() - 4 * 3_600_000), { eventIds: [gathering.id], skipPrune: true })
      expect(repeat.reminders).toBe(0)

      const hour = await job.runLifecycleJob(new Date(start.getTime() - 30 * 60_000), { eventIds: [gathering.id], skipPrune: true })
      expect(hour.reminders).toBeGreaterThanOrEqual(2)

      const reminders = await feedOf(member.id, gathering.id, 'event_reminder')
      expect(reminders).toHaveLength(2)
      expect(reminders[0].title).toContain('starts tomorrow')
      expect(reminders[1].title).toContain('in about an hour')

      const marks = await db.sql<{ mark: string }[]>`
        select mark from notification_marks where event_id = ${gathering.id} and kind = 'reminder' order by mark
      `
      expect(marks.map((m) => m.mark)).toEqual(['1h', '24h'])
    })

    test('a saved session 15 minutes out reaches the person who saved it, once', async () => {
      const [venue] = await db.sql<{ id: string }[]>`
        insert into venues (event_id, name, slug, capacity) values (${gathering.id}, 'Clock Room', 'clock-room', 10) returning id
      `
      const [slot] = await db.sql<{ id: string }[]>`
        insert into time_slots (event_id, venue_id, day_date, start_time, end_time, slot_type)
        values (${gathering.id}, ${venue.id}, current_date, now() + interval '10 minutes', now() + interval '70 minutes', 'session')
        returning id
      `
      const [session] = await db.sql<{ id: string }[]>`
        insert into sessions (event_id, host_id, title, description, status, venue_id, time_slot_id, duration)
        values (${gathering.id}, ${owner.id}, 'Saved session', 'x', 'scheduled', ${venue.id}, ${slot.id}, 60)
        returning id
      `
      await db.sql`insert into favorites (event_id, session_id, user_id) values (${gathering.id}, ${session.id}, ${member.id})`
      await db.sql`update events set status = 'live' where id = ${gathering.id}`

      const first = await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })
      expect(first.startingSoon).toBe(1)
      const second = await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })
      expect(second.startingSoon).toBe(0)

      const soon = (await feedOf(member.id, gathering.id, 'event_reminder')).filter((n) => n.title.includes('Saved session'))
      expect(soon).toHaveLength(1)
      expect(soon[0].body).toContain('Clock Room')
      // The host did not save it, so the host is not told.
      expect((await feedOf(owner.id, gathering.id, 'event_reminder')).some((n) => n.title.includes('Saved session'))).toBe(false)

      // …and once the room is 80 % claimed, the organizers hear about that, once.
      await db.sql`update sessions set rsvp_count = 8 where id = ${session.id}`
      const capacity = await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })
      expect(capacity.alerts).toBe(1)
      expect(await job.runLifecycleJob(new Date(), { eventIds: [gathering.id], skipPrune: true })).toMatchObject({ alerts: 0 })
      const alert = (await feedOf(owner.id, gathering.id, 'admin_announcement')).filter((n) => n.title.includes('nearly full'))
      expect(alert).toHaveLength(1)
      expect(alert[0].body).toContain('8 of 10')
      expect((await feedOf(member.id, gathering.id, 'admin_announcement'))).toHaveLength(0)
    })

    test('the attendance round opens at the start for a gathering that went live early', async () => {
      // Started yesterday on its own clock, so "the gathering has begun" is unambiguous
      // whatever time of day the suite runs at.
      const other = await createTestGathering(db.sql, { tag: 'n2att', status: 'live', startInDays: -1 })
      try {
        await db.sql`insert into event_members (event_id, user_id, role) values (${other.id}, ${owner.id}, 'owner')`
        await db.sql`update events set attendance_voting_enabled = true where id = ${other.id}`
        const report = await job.runLifecycleJob(new Date(), { eventIds: [other.id], skipPrune: true })
        expect(report.attendanceRoundsOpened).toBe(1)
        const [round] = await db.sql<{ phase: string; finalized_at: string | null }[]>`
          select phase, finalized_at from vote_rounds where event_id = ${other.id}
        `
        expect(round).toMatchObject({ phase: 'attendance', finalized_at: null })
        expect((await feedOf(owner.id, other.id, 'voting_opened'))).toHaveLength(1)
        // Idempotent.
        expect(await job.runLifecycleJob(new Date(), { eventIds: [other.id], skipPrune: true })).toMatchObject({ attendanceRoundsOpened: 0 })

        // …and a CLOSED round is never resurrected. `openRound` only reuses an unfinalized
        // round, so without the guard every tick would open a new one, publish another
        // tally and announce it to every member again (review defect 5).
        await db.sql`update vote_rounds set finalized_at = now(), ballot_key = null where event_id = ${other.id}`
        for (let i = 0; i < 2; i++) {
          expect(await job.runLifecycleJob(new Date(), { eventIds: [other.id], skipPrune: true })).toMatchObject({ attendanceRoundsOpened: 0 })
        }
        const [rounds] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from vote_rounds where event_id = ${other.id} and phase = 'attendance'
        `
        expect(rounds.n).toBe(1)
        expect(await feedOf(owner.id, other.id, 'voting_opened')).toHaveLength(1)
      } finally {
        await other.cleanup().catch(() => undefined)
      }
    })

    test('after the last day of the gathering no attendance round is opened at all', async () => {
      const over = await createTestGathering(db.sql, { tag: 'n2over', status: 'live', startInDays: -4 })
      try {
        await db.sql`insert into event_members (event_id, user_id, role) values (${over.id}, ${owner.id}, 'owner')`
        await db.sql`update events set attendance_voting_enabled = true where id = ${over.id}`
        const report = await job.runLifecycleJob(new Date(), { eventIds: [over.id], skipPrune: true })
        expect(report.attendanceRoundsOpened).toBe(0)
        const [rounds] = await db.sql<{ n: number }[]>`select count(*)::int as n from vote_rounds where event_id = ${over.id}`
        expect(rounds.n).toBe(0)
        expect(await feedOf(owner.id, over.id, 'voting_opened')).toHaveLength(0)
      } finally {
        await over.cleanup().catch(() => undefined)
      }
    })

    test('auto-lifecycle into `live` announces attendance voting exactly once in a tick', async () => {
      // The transition opens and announces the round; the attendance stage runs in the same
      // tick and must recognise its mark rather than announcing it a second time (defect 8).
      const going = await createTestGathering(db.sql, { tag: 'n2live', status: 'scheduling', startInDays: -1 })
      try {
        await db.sql`insert into event_members (event_id, user_id, role) values (${going.id}, ${member.id}, 'attendee')`
        await db.sql`update events set attendance_voting_enabled = true, auto_lifecycle = true where id = ${going.id}`

        const report = await job.runLifecycleJob(new Date(), { eventIds: [going.id], skipPrune: true })
        expect(report.transitions.map((t) => t.to)).toEqual(['live'])
        expect(report.attendanceRoundsOpened).toBe(0) // the transition already did it

        expect(await feedOf(member.id, going.id, 'voting_opened')).toHaveLength(1)
        const [rounds] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from vote_rounds where event_id = ${going.id} and phase = 'attendance'
        `
        expect(rounds.n).toBe(1)
        const marks = await db.sql<{ kind: string; mark: string }[]>`
          select kind, mark from notification_marks where event_id = ${going.id} and kind = 'attendance'
        `
        expect(marks).toEqual([{ kind: 'attendance', mark: 'opened' }])
      } finally {
        await going.cleanup().catch(() => undefined)
      }
    })

    test('organizer alerts after a closed round: most-wanted unscheduled, then keep-apart pairs together', async () => {
      const alerts = await createTestGathering(db.sql, { tag: 'n2alert', status: 'scheduling', withProgram: true, startInDays: 3 })
      try {
        await db.sql`insert into event_members (event_id, user_id, role) values (${alerts.id}, ${owner.id}, 'owner')`
        const made = await db.sql<{ id: string; title: string }[]>`
          insert into sessions (event_id, host_id, title, description, status, duration, is_votable)
          values (${alerts.id}, ${owner.id}, 'Wanted A', 'x', 'approved', 60, true),
                 (${alerts.id}, ${owner.id}, 'Wanted B', 'x', 'approved', 60, true)
          returning id, title
        `

        // A finalized round with three ballots (the gathering's k) that all wanted both
        // sessions: comparable, and keep-apart at 100 %.
        const [round] = await db.sql<{ id: string }[]>`
          insert into vote_rounds (event_id, phase, mechanism, credits, opens_at, closes_at, ballot_key, finalized_at)
          values (${alerts.id}, 'pre-event', 'quadratic', 100, now() - interval '3 days', now() - interval '2 days', null, now() - interval '2 hours')
          returning id
        `
        for (let i = 0; i < 3; i++) {
          const [ballot] = await db.sql<{ token: Buffer }[]>`
            insert into vote_ballots (round_id, event_id, token, cast_at)
            values (${round.id}, ${alerts.id}, extensions.gen_random_bytes(32), now() - interval '2 days')
            returning token
          `
          for (const session of made) {
            await db.sql`
              insert into vote_entries (round_id, event_id, session_id, votes, credits, day, ballot_token)
              values (${round.id}, ${alerts.id}, ${session.id}, 3, 9, current_date, ${ballot.token})
            `
          }
        }

        // Nothing is scheduled yet: the organizers hear that the most-wanted sessions have no slot.
        const first = await job.runLifecycleJob(new Date(), { eventIds: [alerts.id], skipPrune: true })
        expect(first.alerts).toBe(1)
        const unscheduled = (await feedOf(owner.id, alerts.id, 'admin_announcement')).filter((n) => n.title.includes('no slot yet'))
        expect(unscheduled).toHaveLength(1)
        expect(unscheduled[0].body).toContain('Wanted A')
        // A vote count never leaves a notification (spec §5.3 holds after the close too).
        expect(unscheduled[0].body).not.toMatch(/\b\d+ votes?\b/)
        expect(await job.runLifecycleJob(new Date(), { eventIds: [alerts.id], skipPrune: true })).toMatchObject({ alerts: 0 })

        // Now place both in the same time slot: they share their whole audience.
        const [slot] = await db.sql<{ id: string }[]>`
          select id from time_slots where event_id = ${alerts.id} and not is_break order by start_time limit 1
        `
        await db.sql`
          update sessions set status = 'scheduled', time_slot_id = ${slot.id}
          where event_id = ${alerts.id} and id in ${db.sql(made.map((m) => m.id))}
        `
        const clash = await job.runLifecycleJob(new Date(), { eventIds: [alerts.id], skipPrune: true })
        expect(clash.alerts).toBe(1)
        const conflicts = (await feedOf(owner.id, alerts.id, 'admin_announcement')).filter((n) => n.title.includes('share an audience'))
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0].body).toContain('Wanted A')
        // One notice per gathering per day.
        expect(await job.runLifecycleJob(new Date(), { eventIds: [alerts.id], skipPrune: true })).toMatchObject({ alerts: 0 })
      } finally {
        await alerts.cleanup().catch(() => undefined)
      }
    })

    test('publishing a gathering announces it to its members (`event_published`)', async () => {
      // The side effects are shared by the settings route and the clock; exercise them
      // directly so the announcement is covered without minting a PDS identity.
      await rolledBack(async (t) => {
        const [row] = await t<{ id: string; slug: string; name: string; timezone: string; voting_closes_at: string | null }[]>`
          select id, slug, name, timezone, voting_closes_at from events where id = ${gathering.id}
        `
        const written = await transition.transitionSideEffects(t, { row, from: 'draft', to: 'published' })
        expect(written).toBeGreaterThanOrEqual(2) // owner + member
        const [note] = await t<{ type: string; title: string; action_url: string }[]>`
          select type, title, action_url from notifications
          where event_id = ${gathering.id} and user_id = ${member.id} and type = 'event_published'
        `
        expect(note.title).toContain(row.name)
        expect(note.action_url).toBe(`/e/${row.slug}`)
      })
    })

    test('the job route needs the cron bearer and answers with counts only', async () => {
      const res = await fetch(`${base}/api/jobs/lifecycle`)
      expect(res.status).toBe(200) // the dev server runs without CRON_SECRET
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(Object.keys(body.report).sort()).toEqual([
        'alerts', 'attendanceRoundsOpened', 'errors', 'marksPruned', 'reminders',
        'stageErrors', 'startingSoon', 'transitions',
      ])
      // Every stage reports its own failure count, and a healthy run has none.
      expect(Object.keys(body.report.stageErrors).sort()).toEqual([
        'attendance', 'capacity', 'conflicts', 'prune', 'reminders', 'starting_soon', 'transitions', 'unscheduled',
      ])
      expect(Object.values(body.report.stageErrors).every((n) => n === 0)).toBe(true)
      expect(JSON.stringify(body)).not.toContain('@example.test')
    })
  })

  // ---------------------------------------------------------------------------
  // The four declared-but-dead types, end to end
  // ---------------------------------------------------------------------------

  test.describe('proposals, co-hosts and the waitlist', () => {
    let gathering: TestGathering
    let organizer: TestAccount
    let proposer: TestAccount
    let invitee: TestAccount
    let sessionId = ''

    test.beforeAll(async () => {
      organizer = await createTestAccount('n2-org', { sql: db.sql, base })
      proposer = await createTestAccount('n2-prop', { sql: db.sql, base })
      invitee = await createTestAccount('n2-cohost', { sql: db.sql, base })
      gathering = await createTestGathering(db.sql, { tag: 'n2prop', status: 'proposals_open', requireProposalApproval: true })
      await db.sql`
        insert into event_members (event_id, user_id, role)
        values (${gathering.id}, ${organizer.id}, 'owner'), (${gathering.id}, ${invitee.id}, 'attendee')
      `
    })

    test.afterAll(async () => {
      await gathering?.cleanup().catch(() => undefined)
      for (const a of [organizer, proposer, invitee]) await a?.cleanup().catch(() => undefined)
    })

    test('proposing writes `session_submitted` to the proposer and `new_proposal` to organizers', async () => {
      const res = await fetch(`${base}/api/v1/sessions`, {
        method: 'POST',
        headers: json(proposer.cookie),
        body: JSON.stringify({
          event_slug: gathering.slug,
          title: 'A proposal with a receipt',
          description: 'Testing session_submitted.',
          format: 'talk',
          duration: 60,
        }),
      })
      const body = await res.json()
      expect(res.status, JSON.stringify(body)).toBe(201)
      sessionId = body.id

      const mine = await feedOf(proposer.id, gathering.id, 'session_submitted')
      expect(mine).toHaveLength(1)
      expect(mine[0].title).toContain('A proposal with a receipt')
      expect(mine[0].body).toContain('review') // this gathering reviews proposals first
      expect(mine[0].action_url).toBe(`/e/${gathering.slug}/sessions/${sessionId}`)

      // The organizer still gets theirs, and not the proposer's receipt.
      expect(await feedOf(organizer.id, gathering.id, 'new_proposal')).toHaveLength(1)
      expect(await feedOf(organizer.id, gathering.id, 'session_submitted')).toHaveLength(0)
    })

    test('an emailed co-host invite notifies the invitee (`cohost_invited`) and records only that it went out', async () => {
      const res = await fetch(`${base}/api/sessions/${sessionId}/invites`, {
        method: 'POST',
        headers: json(proposer.cookie),
        body: JSON.stringify({ email: invitee.email }),
      })
      const body = await res.json()
      expect(res.status, JSON.stringify(body)).toBe(201)
      expect(body.emailed).toBe(true)

      const invited = await feedOf(invitee.id, gathering.id, 'cohost_invited')
      expect(invited).toHaveLength(1)
      expect(invited[0].action_url).toBe(`/invite/${body.token}`)

      // The address is never stored on the invite: only that a link was emailed.
      const [row] = await db.sql<{ emailed_at: string | null; status: string }[]>`
        select emailed_at, status from cohost_invites where id = ${body.id}
      `
      expect(row.status).toBe('pending')
      expect(row.emailed_at).not.toBeNull()
      const columns = await db.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'cohost_invites'
      `
      expect(columns.map((c) => c.column_name)).not.toContain('email')

      // A malformed address is refused before an invite is created.
      const bad = await fetch(`${base}/api/sessions/${sessionId}/invites`, {
        method: 'POST', headers: json(proposer.cookie), body: JSON.stringify({ email: 'not-an-address' }),
      })
      expect(bad.status).toBe(400)
    })

    test('declining an invite closes it and tells the proposer (`cohost_declined`)', async () => {
      const created = await fetch(`${base}/api/sessions/${sessionId}/invites`, {
        method: 'POST', headers: json(proposer.cookie), body: JSON.stringify({}),
      }).then((r) => r.json())

      const res = await fetch(`${base}/api/invite/${created.token}/decline`, {
        method: 'POST', headers: json(invitee.cookie),
      })
      const body = await res.json()
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(body.declined).toBe(true)

      const [invite] = await db.sql<{ status: string; declined_by: string | null; declined_at: string | null }[]>`
        select status, declined_by, declined_at from cohost_invites where id = ${created.id}
      `
      expect(invite.status).toBe('declined')
      expect(invite.declined_by).toBe(invitee.id)
      expect(invite.declined_at).not.toBeNull()

      const declined = await feedOf(proposer.id, gathering.id, 'cohost_declined')
      expect(declined).toHaveLength(1)
      expect(declined[0].body).toContain('will not be co-hosting')

      // A declined invite cannot then be accepted, and declining twice is harmless.
      const accept = await fetch(`${base}/api/invite/${created.token}/accept`, { method: 'POST', headers: json(invitee.cookie) })
      expect(accept.status).toBe(409)
      const twice = await fetch(`${base}/api/invite/${created.token}/decline`, { method: 'POST', headers: json(invitee.cookie) })
      expect(twice.status).toBe(200)
      expect(await feedOf(proposer.id, gathering.id, 'cohost_declined')).toHaveLength(1)
    })

    test('a batch approval reaches co-hosts as well as the proposer', async () => {
      // The invitee accepts a fresh invite, so the session has a real co-host.
      const created = await fetch(`${base}/api/sessions/${sessionId}/invites`, {
        method: 'POST', headers: json(proposer.cookie), body: JSON.stringify({}),
      }).then((r) => r.json())
      const accepted = await fetch(`${base}/api/invite/${created.token}/accept`, { method: 'POST', headers: json(invitee.cookie) })
      expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200)

      const res = await fetch(`${base}/api/v1/events/${gathering.slug}/sessions/batch`, {
        method: 'PATCH',
        headers: json(organizer.cookie),
        body: JSON.stringify({ action: 'approve', session_ids: [sessionId] }),
      })
      const body = await res.json()
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(body.affected).toBe(1)

      expect(await feedOf(proposer.id, gathering.id, 'session_approved')).toHaveLength(1)
      expect(await feedOf(invitee.id, gathering.id, 'session_approved')).toHaveLength(1)
      // Never to the organizer who pressed the button.
      expect(await feedOf(organizer.id, gathering.id, 'session_approved')).toHaveLength(0)
    })

    test('a cancelled RSVP promotes the next person and tells them (`rsvp_promoted`)', async () => {
      const [venue] = await db.sql<{ id: string }[]>`
        insert into venues (event_id, name, slug, capacity) values (${gathering.id}, 'One Seat', 'one-seat', 1) returning id
      `
      const [slot] = await db.sql<{ id: string }[]>`
        insert into time_slots (event_id, venue_id, day_date, start_time, end_time, slot_type)
        values (${gathering.id}, ${venue.id}, current_date + 14, now() + interval '14 days', now() + interval '14 days 1 hour', 'session')
        returning id
      `
      const [session] = await db.sql<{ id: string }[]>`
        insert into sessions (event_id, host_id, title, description, status, venue_id, time_slot_id, duration)
        values (${gathering.id}, ${organizer.id}, 'One-seat session', 'x', 'scheduled', ${venue.id}, ${slot.id}, 60)
        returning id
      `

      const rsvp = (cookie: string, method: 'PUT' | 'DELETE') =>
        fetch(`${base}/api/v1/events/${gathering.slug}/rsvps/${session.id}`, { method, headers: json(cookie), body: method === 'PUT' ? '{}' : undefined })

      expect((await rsvp(proposer.cookie, 'PUT')).status).toBe(200)
      const waitlisted = await rsvp(invitee.cookie, 'PUT')
      expect(waitlisted.status).toBe(200)
      expect((await waitlisted.json()).my_rsvp).toMatchObject({ status: 'waitlist' })

      expect((await rsvp(proposer.cookie, 'DELETE')).status).toBe(200)

      const promoted = await feedOf(invitee.id, gathering.id, 'rsvp_promoted')
      expect(promoted).toHaveLength(1)
      expect(promoted[0].title).toContain('One-seat session')
      expect(promoted[0].action_url).toBe(`/e/${gathering.slug}/sessions/${session.id}`)
      const [state] = await db.sql<{ status: string }[]>`
        select status from session_rsvps where session_id = ${session.id} and user_id = ${invitee.id}
      `
      expect(state.status).toBe('confirmed')
      // The person who left is not told they promoted someone.
      expect(await feedOf(proposer.id, gathering.id, 'rsvp_promoted')).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Email hygiene: the digest and one-click unsubscribe
  // ---------------------------------------------------------------------------

  test('mail over the hourly limit becomes one digest instead of being dropped', async () => {
    const savedKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      await rolledBack(async (t) => {
        const suffix = randomUUID().slice(0, 8)
        const [account] = await t<{ id: string; email: string }[]>`
          insert into accounts (did, handle, email, kind, email_verified_at)
          values (${`did:plc:n2dig${suffix}`}, ${`n2dig-${suffix}.test`}, ${`n2-digest-${suffix}@example.test`}, 'custodial', now())
          returning id, email
        `
        const [event] = await t<{ id: string }[]>`
          insert into events (slug, name, start_date, end_date)
          values (${`n2-digest-${suffix}`}, 'Digest gathering', current_date + 3, current_date + 4) returning id
        `
        const titles = ['one', 'two', 'three', 'four']
        for (const title of titles) {
          await notifications.notify(t, { eventId: event.id, userIds: [account.id], type: 'admin_announcement', title, body: `${title} body` })
          // Distinct, old enough to be digested, and in a known order: the dispatcher ranks
          // a recipient's pending rows by (created_at, id), and only the first is under the
          // per-hour limit.
          await t`
            update notifications set created_at = now() - interval '3 hours' + ${`${titles.indexOf(title)} minutes`}::interval
            where user_id = ${account.id} and title = ${title}
          `
        }

        // Only this account's mail is inspected: a dispatch run sees every pending row in
        // the table, including rows other tests in this file are still working through.
        const sends: Array<{ to: string; subject: string; text: string; headers?: Record<string, string> }> = []
        const result = await notifications.dispatchPending({
          db: t,
          limit: 500,
          perHour: 1,
          send: async (message) => {
            if (message.to === account.email) sends.push(message as (typeof sends)[number])
            return mail.sendMail(message)
          },
        })

        // One row rides the normal path; the other three arrive as a single digest.
        expect(result.digests).toBeGreaterThanOrEqual(1)
        expect(result.digested).toBeGreaterThanOrEqual(3)
        expect(result.rateLimited).toBe(0)
        expect(sends).toHaveLength(2)
        const outcomes = await t<{ email_outcome: string | null }[]>`
          select email_outcome from notifications where user_id = ${account.id} order by created_at, id
        `
        expect(outcomes.filter((o) => o.email_outcome === 'digested')).toHaveLength(3)
        expect(outcomes.every((o) => o.email_outcome !== null)).toBe(true)

        const digest = sends.find((s) => s.subject.includes('3 updates'))
        expect(digest, sends.map((s) => s.subject).join(' | ')).toBeTruthy()
        expect(digest!.text).toContain('two — two body')
        expect(digest!.text).toContain('four — four body')
        expect(digest!.text).not.toContain('one — one body') // that one was emailed on its own
        expect(digest!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
      })
    } finally {
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey
    }
  })

  test('a backlog longer than one digest is paged, not truncated', async () => {
    const savedKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      await rolledBack(async (t) => {
        const suffix = randomUUID().slice(0, 8)
        const [account] = await t<{ id: string; email: string }[]>`
          insert into accounts (did, handle, email, kind, email_verified_at)
          values (${`did:plc:n2pag${suffix}`}, ${`n2pag-${suffix}.test`}, ${`n2-paged-${suffix}@example.test`}, 'custodial', now())
          returning id, email
        `
        const [event] = await t<{ id: string }[]>`
          insert into events (slug, name, start_date, end_date)
          values (${`n2-paged-${suffix}`}, 'Paged gathering', current_date + 3, current_date + 4) returning id
        `
        // 51 rows: one under the hourly limit, 50 to digest — more than one 40-line email.
        for (let i = 0; i < 51; i++) {
          await notifications.notify(t, {
            eventId: event.id, userIds: [account.id], type: 'admin_announcement',
            title: `item ${String(i).padStart(2, '0')}`,
          })
        }
        await t`
          update notifications n set created_at = now() - interval '3 hours' + (split_part(n.title, ' ', 2)::int * interval '1 minute')
          where n.user_id = ${account.id}
        `

        const sends: Array<{ to: string; subject: string; text: string }> = []
        const result = await notifications.dispatchPending({
          db: t,
          limit: 500,
          perHour: 1,
          send: async (message) => {
            if (message.to === account.email) sends.push(message as (typeof sends)[number])
            return mail.sendMail(message)
          },
        })
        expect(result.digested).toBeGreaterThanOrEqual(50)

        // Two digests (40 + 10) plus the one row that was under the limit — and nothing
        // was quietly marked handled without being in an email.
        const digests = sends.filter((m) => m.subject.includes('updates'))
        expect(digests).toHaveLength(2)
        expect(digests[0].subject).toContain('40 updates')
        expect(digests[1].subject).toContain('10 updates')

        const rows = await t<{ title: string; email_outcome: string | null }[]>`
          select title, email_outcome from notifications where user_id = ${account.id}
        `
        expect(rows.filter((r) => r.email_outcome === 'digested')).toHaveLength(50)
        expect(rows.every((r) => r.email_outcome !== null)).toBe(true)
        // Every digested title appears in exactly one of the two emails.
        const body = digests.map((d) => d.text).join('\n')
        for (const row of rows.filter((r) => r.email_outcome === 'digested')) {
          expect(body).toContain(row.title)
        }
      })
    } finally {
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey
    }
  })

  test('one-click unsubscribe turns email off for that gathering and nothing else', async () => {
    const person = await createTestAccount('n2-unsub', { sql: db.sql, base })
    const gathering = await createTestGathering(db.sql, { tag: 'n2unsub', status: 'published' })
    try {
      await db.sql`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${person.id}, 'attendee')`
      const token = unsubscribe.unsubscribeToken({ accountId: person.id, eventId: gathering.id })

      // GET never unsubscribes: a link scanner must not be able to.
      const peek = await fetch(`${base}/api/unsubscribe?t=${encodeURIComponent(token)}`)
      expect(peek.status).toBe(200)
      expect(await peek.json()).toMatchObject({ valid: true, scope: 'event', eventName: gathering.name })
      const [untouched] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from notification_preferences where user_id = ${person.id}
      `
      expect(untouched.n).toBe(0)

      const res = await fetch(`${base}/api/unsubscribe?t=${encodeURIComponent(token)}`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, scope: 'event' })

      const prefs = await db.sql<{ category: string; email_enabled: boolean; in_app_enabled: boolean }[]>`
        select category, email_enabled, in_app_enabled from notification_preferences
        where user_id = ${person.id} and event_id = ${gathering.id}
      `
      expect(prefs).toHaveLength(5)
      expect(prefs.every((p) => p.email_enabled === false)).toBe(true)
      // In-app is untouched: unsubscribing from email is not leaving the gathering.
      expect(prefs.every((p) => p.in_app_enabled === true)).toBe(true)
      // Global preferences are untouched too.
      const [globals] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from notification_preferences where user_id = ${person.id} and event_id is null
      `
      expect(globals.n).toBe(0)

      // …and the dispatcher now skips their email for this gathering.
      await rolledBack(async (t) => {
        await notifications.notify(t, { eventId: gathering.id, userIds: [person.id], type: 'admin_announcement', title: 'after unsubscribe' })
        await notifications.dispatchPending({ db: t, limit: 50, perHour: 100, send: mail.sendMail })
        const [row] = await t<{ email_outcome: string | null }[]>`
          select email_outcome from notifications where user_id = ${person.id} and title = 'after unsubscribe'
        `
        expect(row.email_outcome).toBe('opted_out')
      })

      // A token that does not verify changes nothing and still answers 200 (no oracle).
      const forged = await fetch(`${base}/api/unsubscribe?t=${encodeURIComponent(`${token}x`)}`, { method: 'POST' })
      expect(forged.status).toBe(200)
      expect(await forged.json()).toEqual({ ok: true })

      // The page renders for a valid token without changing anything.
      const page = await fetch(`${base}/unsubscribe?t=${encodeURIComponent(token)}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('Stop these emails?')
    } finally {
      await gathering.cleanup().catch(() => undefined)
      await person.cleanup().catch(() => undefined)
    }
  })
})
