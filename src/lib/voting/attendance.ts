import 'server-only'
/**
 * Attendance voting (design §11, PRD §2.3): the second ballot-key round of a gathering.
 *
 * It reuses every piece of the pre-event machinery — `openRound` / `setAllocation` /
 * `closeRound` with `phase = 'attendance'` — and adds only the rules that make it
 * "during the event":
 *
 *   openAttendanceRound   opened when the gathering goes live (settings route) or when an
 *                         organizer switches it on while live; fresh credits
 *                         (`events.attendance_credits`), closes at the gathering's end + 1 h
 *   sessionsHappeningNow  the scheduled sessions whose slot ± 15 min contains `now`: the only
 *                         sessions an attendance vote may name (enforced in `setAllocation`)
 *   attendanceWindow      what a reader may know: is the round open, which sessions are
 *                         votable right now. Never a count.
 */
import { sql, type Sql } from '@/lib/db'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import type postgres from 'postgres'
import { ATTENDANCE_GRACE_MINUTES } from './mechanism'
import { isUuid, openRound, roundState, WRITABLE_STATUS, type RoundInfo } from './rounds'

/**
 * When the attendance round closes: one hour after the last day of the gathering ends in
 * its own timezone (PRD §2.3 "Event end + 1 hour"). A gathering that goes live late — or
 * after its end date — still gets at least an hour of voting.
 */
export function attendanceClosesAt(endDate: string, timezone: string, now: Date = new Date()): Date {
  const floor = new Date(now.getTime() + 60 * 60_000)
  const day = /^\d{4}-\d{2}-\d{2}/.exec(endDate)?.[0]
  if (!day) return floor
  const [y, m, d] = day.split('-').map(Number)
  const nextDay = new Date(Date.UTC(y, m - 1, d) + 86_400_000).toISOString().slice(0, 10)
  let endOfDay: Date
  try {
    endOfDay = parseTimeInTimezone('00:00', nextDay, timezone)
  } catch {
    endOfDay = new Date(`${nextDay}T00:00:00Z`)
  }
  const closes = new Date(endOfDay.getTime() + 60 * 60_000)
  return closes.getTime() > floor.getTime() ? closes : floor
}

/** SQL fragment: a session's slot (or self-hosted time) ± the grace period contains now(). */
function happeningNow(db: Sql) {
  const grace = `${ATTENDANCE_GRACE_MINUTES} minutes`
  return db`
    s.status = 'scheduled' and s.is_votable
    and coalesce(ts.start_time, case when s.is_self_hosted then s.self_hosted_start_time end) is not null
    and coalesce(ts.start_time, case when s.is_self_hosted then s.self_hosted_start_time end) - ${grace}::interval <= now()
    and coalesce(ts.end_time, case when s.is_self_hosted then s.self_hosted_end_time end,
                 coalesce(ts.start_time, s.self_hosted_start_time) + (coalesce(s.duration, 60) * interval '1 minute')) + ${grace}::interval > now()
  `
}

/** Ids of the event's sessions that may take an attendance vote right now. */
export async function sessionsHappeningNow(db: Sql, eventId: string): Promise<string[]> {
  if (!isUuid(eventId)) return []
  const rows = await db<{ id: string }[]>`
    select s.id from sessions s
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    where s.event_id = ${eventId} and ${happeningNow(db)}
    order by coalesce(ts.start_time, s.self_hosted_start_time), s.id
  `
  return rows.map((r) => r.id)
}

/** Whether one session is inside its attendance window right now. */
export async function isHappeningNow(db: Sql, eventId: string, sessionId: string): Promise<boolean> {
  const [row] = await db<{ ok: boolean }[]>`
    select exists (
      select 1 from sessions s
      left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
      where s.event_id = ${eventId} and s.id = ${sessionId} and ${happeningNow(db)}
    ) as ok
  `
  return !!row?.ok
}

/**
 * Open the gathering's attendance round with fresh credits, inside the caller's transaction
 * (the lifecycle transition into `live`). Returns null — and opens nothing — when the
 * gathering has not opted in. Idempotent through `openRound`.
 */
export async function openAttendanceRound(t: postgres.TransactionSql, eventId: string): Promise<RoundInfo | null> {
  const [event] = await t<{ enabled: boolean; credits: number; end_date: string; timezone: string; now: string }[]>`
    select attendance_voting_enabled as enabled, attendance_credits as credits, end_date::text as end_date, timezone, now() as now
    from events where id = ${eventId}
  `
  if (!event?.enabled) return null
  const now = new Date(event.now)
  return openRound(
    eventId,
    { phase: 'attendance', credits: event.credits, opensAt: now, closesAt: attendanceClosesAt(event.end_date, event.timezone, now) },
    t,
  )
}

export interface AttendanceWindow {
  /** The attendance round accepts votes right now (round open and the gathering live). */
  open: boolean
  /** Rules and window of the attendance round, when one exists; never a count. */
  round: RoundInfo | null
  /** Sessions inside their slot ± grace right now; empty unless `open`. */
  votable_now: string[]
}

/** The reader's view of the attendance round: open or not, and which sessions are votable now. */
export async function attendanceWindow(eventId: string): Promise<AttendanceWindow> {
  const state = await roundState(eventId, 'attendance')
  if (state.status !== 'open' || !state.round) return { open: false, round: state.round, votable_now: [] }
  const [event] = await sql<{ status: string }[]>`select status from events where id = ${eventId}`
  const open = event?.status === WRITABLE_STATUS.attendance
  return { open, round: state.round, votable_now: open ? await sessionsHappeningNow(sql, eventId) : [] }
}
