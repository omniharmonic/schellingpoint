import 'server-only'
import type postgres from 'postgres'
import { sql, type Sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { ATTENDANCE_MARK, claimMark } from '@/lib/notifications/marks'
import { isValidTransition } from './lifecycle'
import { parseTimeInTimezone } from './timezone'
import { publishGatheringRecords } from './network'
import { queueTransitionFeedPost, transitionSideEffects } from './transition'
import { openAttendanceRound } from '@/lib/voting/attendance'
import { eventK, schedulingInputs } from '@/lib/voting/rounds'
import { keepApartPairs, overlapMatrix } from '@/lib/scheduling/clusters'
import { rolesWith } from '@/lib/scheduling/admin-api'
import type { EventStatus } from '@/types/event'

/**
 * The gathering clock (inventory P1-6, P2-3, P2-4, P2-6, P2-17).
 *
 * `GET /api/jobs/lifecycle` runs this every five minutes. Everything here is idempotent:
 * a phase change is guarded by an optimistic update on the status it read, and everything
 * else records a row in `notification_marks` so a second run says nothing twice.
 *
 * What it does, in order:
 *   1. advances gatherings that asked for it (`events.auto_lifecycle`) through the phases
 *      on the timestamps their organizer set, through exactly the code path the settings
 *      route uses (`transitionSideEffects`), so rounds, notifications and feed posts fire
 *      identically;
 *   2. opens the attendance round at the gathering's start for a live gathering that has
 *      attendance voting on but was moved to `live` by hand before its start date;
 *   3. reminds members 24 hours and 1 hour before the gathering starts;
 *   4. tells a member 15 minutes before a session they saved starts;
 *   5. raises the three organizer alerts the PRD asks for: most-voted sessions still
 *      unscheduled, keep-apart pairs placed at the same time, and a session at 80 % of
 *      its room;
 *   6. prunes marks older than the notification retention window.
 *
 * No count of any open round ever leaves this file (spec §5.3): the scheduling alerts read
 * a *closed* round, and even then they name sessions, never numbers of votes.
 */

/** The independent pieces of one run. A failure in one never stops the others. */
export const LIFECYCLE_STAGES = [
  'transitions', 'attendance', 'reminders', 'starting_soon', 'capacity', 'unscheduled', 'conflicts', 'prune',
] as const
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]

export interface LifecycleJobReport {
  /** Phase changes applied, oldest first. */
  transitions: Array<{ eventId: string; from: EventStatus; to: EventStatus; notified: number }>
  attendanceRoundsOpened: number
  reminders: number
  startingSoon: number
  alerts: number
  marksPruned: number
  /** How many gatherings (or whole stages) failed, per stage. */
  stageErrors: Record<LifecycleStage, number>
  /** One line per failure; a gathering slug at most, never an identifier of a person. */
  errors: string[]
}

/** Statuses the clock will move a gathering into, and what it waits for to do so. */
const AUTO_NEXT: Partial<Record<EventStatus, EventStatus>> = {
  // `draft → published` stays a human decision: it mints an identity and writes public records.
  published: 'proposals_open',
  proposals_open: 'voting_open',
  voting_open: 'scheduling',
  scheduling: 'live',
  live: 'completed',
}

interface ClockEvent {
  id: string
  slug: string
  name: string
  status: EventStatus
  timezone: string
  start_date: string
  end_date: string
  proposals_open_at: string | null
  voting_opens_at: string | null
  voting_closes_at: string | null
  auto_lifecycle: boolean
  attendance_voting_enabled: boolean
}

/**
 * When a calendar day begins on the gathering's own clock.
 *
 * Usually local midnight. In the zones that jump forward AT midnight (America/Santiago,
 * Asia/Beirut and friends on their DST date) 00:00 simply does not exist that day, so the
 * day begins at 01:00 local — falling back to UTC midnight there would move the whole
 * gathering by hours. UTC midnight is the last resort, for a zone Intl cannot use at all.
 */
export function dayStart(date: string, timezone: string): Date {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(date)?.[0] ?? date.slice(0, 10)
  for (const time of ['00:00', '01:00']) {
    try {
      return parseTimeInTimezone(time, day, timezone)
    } catch {
      // try the next one
    }
  }
  return new Date(`${day}T00:00:00Z`)
}

/** Today's calendar date (`YYYY-MM-DD`) on the gathering's own clock. */
export function localDay(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/** The day after `date`, as `YYYY-MM-DD`. */
export function nextDay(date: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(date)?.[0] ?? date.slice(0, 10)
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + 86_400_000).toISOString().slice(0, 10)
}

/**
 * When a gathering in `status` is due to move on, or null when its organizer has not said.
 * A missing deadline is never guessed: the phase simply stays where the organizer left it.
 */
export function transitionDueAt(event: ClockEvent): Date | null {
  switch (event.status) {
    case 'published':
      return event.proposals_open_at ? new Date(event.proposals_open_at) : null
    case 'proposals_open':
      return event.voting_opens_at ? new Date(event.voting_opens_at) : null
    case 'voting_open':
      return event.voting_closes_at ? new Date(event.voting_closes_at) : null
    case 'scheduling':
      return dayStart(event.start_date, event.timezone)
    case 'live':
      return dayStart(nextDay(event.end_date), event.timezone)
    default:
      return null
  }
}

/** The caller recorded on network writes the clock makes: the gathering's owner. */
async function ownerOf(eventId: string): Promise<string | null> {
  const [row] = await sql<{ user_id: string }[]>`
    select user_id from event_members
    where event_id = ${eventId} and role in ('owner', 'admin')
    order by case role when 'owner' then 0 else 1 end, joined_at nulls last
    limit 1
  `
  return row?.user_id ?? null
}

/** Who an organizer alert goes to: the roles that may act on it (`approveProposals`). */
const ALERT_ROLES = rolesWith('approveProposals')

async function organizerIds(db: Sql, eventId: string): Promise<string[]> {
  const rows = await db<{ user_id: string }[]>`
    select user_id from event_members where event_id = ${eventId} and role in ${db(ALERT_ROLES)}
  `
  return rows.map((r) => r.user_id)
}

function note(report: LifecycleJobReport, stage: LifecycleStage, where: string, e: unknown): void {
  report.stageErrors[stage]++
  report.errors.push(`${where}: ${stage} failed (${e instanceof Error ? e.name : 'error'})`)
}

/** Runs one stage; an unexpected throw is recorded and the run carries on. */
async function stage(report: LifecycleJobReport, name: LifecycleStage, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (e) {
    note(report, name, 'run', e)
  }
}

/** Runs `fn` per gathering; one gathering's failure never costs the others theirs. */
async function forEachEvent(
  report: LifecycleJobReport,
  name: LifecycleStage,
  events: readonly ClockEvent[],
  fn: (event: ClockEvent) => Promise<void>,
): Promise<void> {
  for (const event of events) {
    try {
      await fn(event)
    } catch (e) {
      note(report, name, event.slug, e)
    }
  }
}

/* ───────────────────────────── 1 + 2. phases ───────────────────────────── */

async function clockEvents(eventIds?: readonly string[]): Promise<ClockEvent[]> {
  if (eventIds && !eventIds.length) return []
  return sql<ClockEvent[]>`
    select id, slug, name, status, timezone, start_date::text as start_date, end_date::text as end_date,
           proposals_open_at, voting_opens_at, voting_closes_at, auto_lifecycle, attendance_voting_enabled
    from events
    where status not in ('draft', 'archived')
      ${eventIds ? sql`and id in ${sql(eventIds as string[])}` : sql``}
      and (auto_lifecycle or attendance_voting_enabled or end_date >= current_date - 2)
    order by start_date, id
  `
}

/**
 * One phase change, in its own transaction, guarded on the status we read. Returns the new
 * row when it moved, null when another writer got there first.
 */
async function applyTransition(
  event: ClockEvent,
  to: EventStatus,
): Promise<{ notified: number; slug: string } | null> {
  return sql.begin(async (t: postgres.TransactionSql) => {
    const [row] = await t<
      { id: string; slug: string; name: string; timezone: string; voting_closes_at: string | null }[]
    >`
      update events set status = ${to}, updated_at = now()
      where id = ${event.id} and status = ${event.status}
      returning id, slug, name, timezone, voting_closes_at
    `
    if (!row) return null
    const notified = await transitionSideEffects(t, { row, from: event.status, to })
    return { notified, slug: row.slug }
  })
}

async function advancePhases(report: LifecycleJobReport, events: ClockEvent[], now: Date): Promise<void> {
  await forEachEvent(report, 'transitions', events.filter((e) => e.auto_lifecycle), async (event) => {
    let current: ClockEvent = event
    // A gathering that has been asleep catches up one phase at a time, in order, so every
    // phase it passes through still writes the notifications that phase owes its members.
    for (let step = 0; step < 6; step++) {
      const to = AUTO_NEXT[current.status]
      if (!to || !isValidTransition(current.status, to)) break
      const due = transitionDueAt(current)
      if (!due || due.getTime() > now.getTime()) break
      let moved: { notified: number; slug: string } | null
      try {
        moved = await applyTransition(current, to)
      } catch (e) {
        note(report, 'transitions', `${current.slug} (${current.status} → ${to})`, e)
        break
      }
      if (!moved) break
      report.transitions.push({ eventId: current.id, from: current.status, to, notified: moved.notified })

      // After the commit: the feed post this phase claims, and the gathering record, whose
      // `phase` field follows the status (spec §8.1).
      const caller = await ownerOf(current.id)
      if (await queueTransitionFeedPost(current.id, to, caller)) {
        await import('@/lib/atproto/feed').then((f) => f.kickFeedDelivery(current.id)).catch(() => undefined)
      }
      if (caller) {
        const [published] = await sql<{ actor_did: string | null; atproto_published_at: string | null }[]>`
          select actor_did, atproto_published_at from events where id = ${current.id}
        `
        if (published?.actor_did && published.atproto_published_at) {
          const write = await publishGatheringRecords(current.id, caller)
          // A network write that did not land is reported, not fatal: the phase change is
          // committed and the Network page offers a retry (spec §6).
          if (!write.ok) report.errors.push(`${current.slug}: gathering record not refreshed after ${to}`)
        }
      }
      current = { ...current, status: to }
    }
  })
}

/**
 * A gathering an organizer moved to `live` before its start date has no attendance round
 * yet worth voting in; open it at the start (design §11, inventory 5.9).
 *
 * Opened at most ONCE per gathering, ever. `openRound` reuses only an *unfinalized* round,
 * so without the two guards below a force-closed round — or one sealed by `closes_at` after
 * the last day — would be recreated on the next tick, publish another tally and announce
 * itself to every member again, every five minutes, forever.
 *
 *   * any attendance round on the gathering, open or closed, means this has happened;
 *   * past the end of the gathering's last day on its own clock there is nothing left to
 *     vote in, so nothing is opened even if no round was ever created.
 *
 * The round, the mark and the announcement are one transaction, so a failure leaves no mark
 * claiming the members were told.
 */
async function openDueAttendanceRounds(report: LifecycleJobReport, events: ClockEvent[], now: Date): Promise<void> {
  const due = events.filter(
    (event) =>
      event.attendance_voting_enabled &&
      event.status === 'live' &&
      dayStart(event.start_date, event.timezone).getTime() <= now.getTime() &&
      dayStart(nextDay(event.end_date), event.timezone).getTime() > now.getTime(),
  )
  await forEachEvent(report, 'attendance', due, async (event) => {
    const [existing] = await sql<{ id: string }[]>`
      select id from vote_rounds where event_id = ${event.id} and phase = 'attendance' limit 1
    `
    if (existing) return // opened once already, by this job or by the transition into `live`

    const opened = await sql.begin(async (t: postgres.TransactionSql) => {
      const round = await openAttendanceRound(t, event.id)
      if (!round || round.status !== 'open') return null
      if (!(await claimMark(t, event.id, ATTENDANCE_MARK.kind, ATTENDANCE_MARK.mark))) return null
      const members = await t<{ user_id: string }[]>`select user_id from event_members where event_id = ${event.id}`
      await notify(t, {
        eventId: event.id,
        userIds: members.map((m) => m.user_id),
        type: 'voting_opened',
        title: `Attendance voting is open for ${event.name}`,
        body: `You have ${round.credits} fresh credits. Vote for a session while you are in it, from My schedule or the session page.`,
        actionUrl: `/e/${event.slug}/schedule?view=mine`,
        data: { round: 'attendance', closes_at: round.closesAt },
      })
      return round
    })
    if (opened) report.attendanceRoundsOpened++
  })
}

/* ───────────────────────────── 3 + 4. reminders ───────────────────────────── */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Which reminder is due for a gathering starting at `start`, if any. */
export function dueReminder(start: Date, now: Date): '24h' | '1h' | null {
  const delta = start.getTime() - now.getTime()
  if (delta <= 0) return null
  if (delta <= HOUR_MS) return '1h'
  if (delta <= DAY_MS) return '24h'
  return null
}

async function sendReminders(report: LifecycleJobReport, events: ClockEvent[], now: Date): Promise<void> {
  const waiting = events.filter((e) => e.status !== 'live' && e.status !== 'completed')
  await forEachEvent(report, 'reminders', waiting, async (event) => {
    const which = dueReminder(dayStart(event.start_date, event.timezone), now)
    if (!which) return
    const when = which === '24h' ? 'tomorrow' : 'in about an hour'
    // Mark and notification in one transaction: a mark that outlived a failed notify would
    // silence the reminder for good.
    report.reminders += await sql.begin(async (t: postgres.TransactionSql) => {
      if (!(await claimMark(t, event.id, 'reminder', which))) return 0
      const members = await t<{ user_id: string }[]>`select user_id from event_members where event_id = ${event.id}`
      return notify(t, {
        eventId: event.id,
        userIds: members.map((m) => m.user_id),
        type: 'event_reminder',
        title: `${event.name} starts ${when}`,
        body: which === '24h'
          ? 'Take a look at the schedule and save the sessions you want to be in.'
          : 'The schedule and your saved sessions are on your phone in My schedule.',
        actionUrl: `/e/${event.slug}/schedule`,
        data: { reminder: which },
      })
    })
  })
}

/** A session someone saved starts in the next quarter of an hour. One notice per person. */
async function sendStartingSoon(report: LifecycleJobReport, events: ClockEvent[]): Promise<void> {
  const live = events.filter((e) => e.status === 'live' || e.status === 'scheduling')
  await forEachEvent(report, 'starting_soon', live, async (event) => {
    const rows = await sql<{ session_id: string; title: string; user_id: string; venue: string | null }[]>`
      select s.id as session_id, s.title, f.user_id, v.name as venue
      from sessions s
      join favorites f on f.session_id = s.id
      left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
      left join venues v on v.id = s.venue_id
      where s.event_id = ${event.id} and s.status = 'scheduled'
        and coalesce(ts.start_time, case when s.is_self_hosted then s.self_hosted_start_time end) > now()
        and coalesce(ts.start_time, case when s.is_self_hosted then s.self_hosted_start_time end) <= now() + interval '15 minutes'
      order by s.id, f.user_id
    `
    for (const row of rows) {
      report.startingSoon += await sql.begin(async (t: postgres.TransactionSql) => {
        if (!(await claimMark(t, event.id, 'starting_soon', `${row.session_id}:${row.user_id}`))) return 0
        return notify(t, {
          eventId: event.id,
          userIds: [row.user_id],
          type: 'event_reminder',
          title: `"${row.title}" starts in 15 minutes`,
          body: row.venue ? `It is in ${row.venue}.` : 'You saved this session.',
          actionUrl: `/e/${event.slug}/sessions/${row.session_id}`,
          data: { session_id: row.session_id, starting_soon: true },
        })
      })
    }
  })
}

/* ───────────────────────────── 5. organizer alerts ───────────────────────────── */

/** Sessions at or above this share of their room's capacity earn one alert. */
export const CAPACITY_ALERT_RATIO = 0.8

async function capacityAlerts(report: LifecycleJobReport, events: ClockEvent[]): Promise<void> {
  const open = events.filter((e) => e.status !== 'completed' && e.status !== 'archived')
  await forEachEvent(report, 'capacity', open, async (event) => {
    const rows = await sql<{ id: string; title: string; rsvp_count: number; capacity: number }[]>`
      select s.id, s.title, s.rsvp_count, v.capacity
      from sessions s join venues v on v.id = s.venue_id
      where s.event_id = ${event.id} and s.status = 'scheduled'
        and v.capacity is not null and v.capacity > 0
        and s.rsvp_count >= ceil(v.capacity::numeric * ${CAPACITY_ALERT_RATIO}::numeric)
      order by s.id
    `
    for (const row of rows) {
      report.alerts += await sql.begin(async (t: postgres.TransactionSql) => {
        if (!(await claimMark(t, event.id, 'capacity', row.id))) return 0
        const written = await notify(t, {
          eventId: event.id,
          userIds: await organizerIds(t, event.id),
          type: 'admin_announcement',
          title: `"${row.title}" is nearly full`,
          body: `${row.rsvp_count} of ${row.capacity} places are claimed. Consider a larger room, or a second sitting.`,
          actionUrl: `/e/${event.slug}/admin/schedule`,
          data: { session_id: row.id, alert: 'capacity' },
        })
        return written ? 1 : 0
      })
    }
  })
}

/**
 * Sessions people voted for that are still not on the schedule, once voting has closed.
 * Reads a CLOSED round only (`schedulingInputs` refuses an open one) and names sessions,
 * never counts.
 */
async function unscheduledAlerts(report: LifecycleJobReport, events: ClockEvent[]): Promise<void> {
  const scheduling = events.filter((e) => e.status === 'scheduling')
  await forEachEvent(report, 'unscheduled', scheduling, async (event) => {
    const [round] = await sql<{ id: string; finalized_at: string }[]>`
      select id, finalized_at from vote_rounds
      where event_id = ${event.id} and phase = 'pre-event' and finalized_at is not null
      order by finalized_at desc limit 1
    `
    // Give organizers an hour with the results before nagging them about them.
    if (!round || Date.parse(round.finalized_at) > Date.now() - HOUR_MS) return
    const inputs = await schedulingInputs(event.id, { roundId: round.id })
    if (inputs.bySession.size === 0) return
    const ranked = [...inputs.bySession.entries()].sort((a, b) => b[1].votes - a[1].votes || a[0].localeCompare(b[0]))
    const top = ranked.slice(0, 5).map(([sessionId]) => sessionId)
    const unplaced = await sql<{ id: string; title: string }[]>`
      select id, title from sessions
      where event_id = ${event.id} and id in ${sql(top)} and status <> 'scheduled'
      order by title
    `
    if (!unplaced.length) return
    const names = unplaced.map((s) => `"${s.title}"`).join(', ')
    report.alerts += await sql.begin(async (t: postgres.TransactionSql) => {
      if (!(await claimMark(t, event.id, 'unscheduled', round.id))) return 0
      const written = await notify(t, {
        eventId: event.id,
        userIds: await organizerIds(t, event.id),
        type: 'admin_announcement',
        title: unplaced.length === 1 ? 'A most-wanted session has no slot yet' : 'Most-wanted sessions have no slot yet',
        body: `${names} came out near the top of the vote and ${unplaced.length === 1 ? 'is' : 'are'} not on the schedule.`,
        actionUrl: `/e/${event.slug}/admin/schedule`,
        data: { alert: 'unscheduled', session_ids: unplaced.map((s) => s.id) },
      })
      return written ? 1 : 0
    })
  })
}

/**
 * Keep-apart pairs (design §9.2: ≥60 % of the smaller audience wanted both) that the draft
 * schedule has running at the same time. One notice per gathering per day — the gathering's
 * own day, not UTC's, so an organizer in Denver is not told twice on one working evening.
 */
async function conflictAlerts(report: LifecycleJobReport, events: ClockEvent[], now: Date): Promise<void> {
  const scheduling = events.filter((e) => e.status === 'scheduling')
  await forEachEvent(report, 'conflicts', scheduling, async (event) => {
    let pairs: Array<{ a: string; b: string }> = []
    try {
      const inputs = await schedulingInputs(event.id)
      if (inputs.bySession.size < 2) return
      const matrix = overlapMatrix(inputs.bySession, await eventK(event.id))
      pairs = keepApartPairs(matrix).map((p) => ({ a: p.a, b: p.b }))
    } catch {
      return // a round that is still open tells organizers nothing (spec §5.3)
    }
    if (!pairs.length) return

    const placed = await sql<{ id: string; title: string; starts: string; ends: string }[]>`
      select s.id, s.title,
             coalesce(ts.start_time, s.self_hosted_start_time) as starts,
             coalesce(ts.end_time, s.self_hosted_end_time,
                      coalesce(ts.start_time, s.self_hosted_start_time) + (coalesce(s.duration, 60) * interval '1 minute')) as ends
      from sessions s
      left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
      where s.event_id = ${event.id} and s.status = 'scheduled'
        and coalesce(ts.start_time, s.self_hosted_start_time) is not null
    `
    const byId = new Map(placed.map((p) => [p.id, p]))
    const clashes = pairs.filter(({ a, b }) => {
      const x = byId.get(a), y = byId.get(b)
      if (!x || !y) return false
      return Date.parse(x.starts) < Date.parse(y.ends) && Date.parse(y.starts) < Date.parse(x.ends)
    })
    if (!clashes.length) return

    const day = localDay(now, event.timezone)
    const first = clashes[0]
    const names = `"${byId.get(first.a)!.title}" and "${byId.get(first.b)!.title}"`
    report.alerts += await sql.begin(async (t: postgres.TransactionSql) => {
      if (!(await claimMark(t, event.id, 'conflicts', day))) return 0
      const written = await notify(t, {
        eventId: event.id,
        userIds: await organizerIds(t, event.id),
        type: 'admin_announcement',
        title: clashes.length === 1 ? 'Two sessions share an audience and a time' : 'Sessions that share an audience are running together',
        body: `${names}${clashes.length > 1 ? ` and ${clashes.length - 1} other pair${clashes.length > 2 ? 's' : ''}` : ''} were wanted by most of the same people and are scheduled at the same time.`,
        actionUrl: `/e/${event.slug}/admin/schedule`,
        data: { alert: 'conflicts', pairs: clashes.length },
      })
      return written ? 1 : 0
    })
  })
}

/* ───────────────────────────── the run ───────────────────────────── */

export interface LifecycleJobOptions {
  /** Restrict the run to these gatherings. Used by tests so a run never touches seeded data. */
  eventIds?: readonly string[]
  /** Skip the 90-day prune (tests that run inside their own fixtures). */
  skipPrune?: boolean
}

export async function runLifecycleJob(
  now: Date = new Date(),
  options: LifecycleJobOptions = {},
): Promise<LifecycleJobReport> {
  const report: LifecycleJobReport = {
    transitions: [],
    attendanceRoundsOpened: 0,
    reminders: 0,
    startingSoon: 0,
    alerts: 0,
    marksPruned: 0,
    stageErrors: Object.fromEntries(LIFECYCLE_STAGES.map((s) => [s, 0])) as Record<LifecycleStage, number>,
    errors: [],
  }
  const events = await clockEvents(options.eventIds)

  await stage(report, 'transitions', () => advancePhases(report, events, now))
  // Re-read: a gathering that just went live needs its new status for the steps below.
  const fresh = await clockEvents(options.eventIds)
  await stage(report, 'attendance', () => openDueAttendanceRounds(report, fresh, now))
  await stage(report, 'reminders', () => sendReminders(report, fresh, now))
  await stage(report, 'starting_soon', () => sendStartingSoon(report, fresh))
  await stage(report, 'capacity', () => capacityAlerts(report, fresh))
  await stage(report, 'unscheduled', () => unscheduledAlerts(report, fresh))
  await stage(report, 'conflicts', () => conflictAlerts(report, fresh, now))

  if (!options.skipPrune) {
    await stage(report, 'prune', async () => {
      const pruned = await sql`delete from notification_marks where created_at < now() - interval '90 days'`
      report.marksPruned = pruned.count
    })
  }

  const failed = Object.values(report.stageErrors).reduce((a, b) => a + b, 0)
  console.info(
    `[jobs:lifecycle] transitions=${report.transitions.length} attendance=${report.attendanceRoundsOpened} ` +
      `reminders=${report.reminders} starting_soon=${report.startingSoon} alerts=${report.alerts} ` +
      `marks_pruned=${report.marksPruned} errors=${failed}`,
  )
  return report
}
