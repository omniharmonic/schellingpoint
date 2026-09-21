import 'server-only'
/**
 * Everything the scheduler, the audience-clusters view and the quality check read, loaded
 * once per request and filtered by the resolved event id.
 *
 * Ballots come from `schedulingInputs` (spec §5.4): tokens, not people, and only after the
 * round closed — `RoundOpenError` while it is open, which routes answer with 409.
 */
import { sql } from '@/lib/db'
import { eventK, RoundOpenError, schedulingInputs } from '@/lib/voting'
import type { BallotInputs, SchedulerSession, SchedulerTimeSlot, SchedulerVenue } from './auto-scheduler'
import { fail } from './admin-api'
import { loadEvent, type AdminEvent } from './program'

export interface SchedulingContext {
  event: AdminEvent
  sessions: SchedulerSession[]
  timeSlots: SchedulerTimeSlot[]
  venues: SchedulerVenue[]
  ballots: BallotInputs
  roundId: string | null
  k: number
}

export { RoundOpenError }

export function roundOpenResponse(): Response {
  return fail(409, 'Voting is still open. Audience overlap uses ballots, which stay sealed until the round closes — try again after voting ends, or place sessions by hand.', {
    code: 'RoundOpen',
  })
}

export async function loadSchedulingContext(eventId: string): Promise<SchedulingContext> {
  const inputs = await schedulingInputs(eventId)
  const [event, k, rows, timeSlots, venues, availability] = await Promise.all([
    loadEvent(eventId),
    eventK(eventId),
    sql<{
      id: string; title: string; duration: number | null; expected_attendance: number | null
      status: 'pending' | 'approved' | 'rejected' | 'scheduled'; time_slot_id: string | null
      track_id: string | null; time_preferences: string[] | null; required_features: string[] | null
      format: string | null; pinned_venue_id: string | null
    }[]>`
      select id, title, duration, expected_attendance, status, time_slot_id, track_id, time_preferences,
             required_features, format, pinned_venue_id
      from sessions where event_id = ${eventId}
      order by created_at
    `,
    sql<{ id: string; start_time: string; end_time: string; is_break: boolean; venue_id: string | null; day_date: string | null; label: string | null }[]>`
      select id, start_time, end_time, coalesce(is_break, false) as is_break, venue_id, day_date, label
      from time_slots where event_id = ${eventId}
    `,
    sql<{ id: string; name: string; capacity: number | null; is_primary: boolean; features: string[] | null; allowed_formats: string[] | null }[]>`
      select id, name, capacity, coalesce(is_primary, false) as is_primary, features, allowed_formats
      from venues where event_id = ${eventId}
    `,
    // The host's own availability for their session (app-side; package B saves it).
    sql<{ session_id: string; windows: Array<{ startsAt: string; endsAt: string; preference?: 1 | 2 | 3 }>; blackouts: Array<{ startsAt: string; endsAt: string }> }[]>`
      select tp.session_id, tp.windows, tp.blackouts
      from time_preferences tp
      join sessions s on s.id = tp.session_id and s.event_id = tp.event_id and s.host_id = tp.account_id
      where tp.event_id = ${eventId}
    `,
  ])
  const bySession = new Map(availability.map((a) => [a.session_id, a]))
  const sessions: SchedulerSession[] = rows.map((s) => ({
    ...s,
    windows: Array.isArray(bySession.get(s.id)?.windows) ? bySession.get(s.id)!.windows : [],
    blackouts: Array.isArray(bySession.get(s.id)?.blackouts) ? bySession.get(s.id)!.blackouts : [],
  }))
  return { event, sessions, timeSlots, venues, ballots: inputs.bySession, roundId: inputs.roundId, k }
}
