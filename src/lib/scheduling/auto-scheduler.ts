/**
 * Auto-scheduling: greedy seed, then local search (release design §9.2).
 *
 * Places approved, unscheduled sessions into free time slots. Sessions are processed most
 * votes first, and each takes its highest-scoring free slot. That seed is then improved by
 * `hillClimb` (improve.ts) against the placement objective (objective.ts): audience
 * conflicts over ballot-token overlap, capacity, hard constraints (host blackouts, pinned
 * rooms, required features, room formats) and balance across time rows. Hand-placed
 * sessions are fixed. The result carries a quality report (quality.ts) and the five PRD
 * progress stages.
 *
 * Scoring (the original scorer, which spec §6 keeps, plus the hosts' availability windows):
 *   duration match      +8 (±15 min: +4, else +1)
 *   time preference     availability windows: inside a window +10 / +7 / +4 by preference, partly +2;
 *                       a host blackout overlapping the slot −20. Legacy half-day tags: +10 (same
 *                       day, other half: +3)
 *   venue features      +6 all present (one missing: +2; none required: +3)
 *   capacity fit        +5 comfortable, +3 tight, 0 over (unknown capacity: +2)
 *   track spread        +3 when no same-track session runs at that time (no track: +1)
 *   voter overlap       −4 (≥60%, the keep-apart line), −2 (≥30%), +2 (<10%, or not comparable)
 *   primary venue       +2 for sessions with more than 20 votes
 *
 * Voter overlap (spec §5.4) is the OVERLAP COEFFICIENT `|A∩B| / min(|A|,|B|)` over BALLOT
 * TOKENS, not people: after a round closes each vote row carries hmac(ballot_key, did)
 * computed once and the key is destroyed, so tokens link one participant's votes to each
 * other and to nobody. The seed reads it from the same k-filtered matrix the objective and
 * the clusters panel use (`clusters.ts`), so the greedy pass and the local search that
 * follows it rank pairs on one scale; a pair below k is "no data", never a penalty. The
 * inputs come from package C's `schedulingInputs`, which refuses while the round is open.
 * The overlap matrix never leaves the server; only the resulting assignments do.
 *
 * Pure: no I/O, safe to unit test.
 */

import { DEFAULT_POLICY_THRESHOLDS } from '@/lib/events/policy'
import { KEEP_APART_THRESHOLD, keepApartPairs, maxPairOverlap, overlapIndex, overlapMatrix, type OverlapPair } from './clusters'
import { hillClimb, type HillClimbStats } from './improve'
import { buildObjectiveContext, concurrentOverlaps, type Placement as SlotPlacement } from './objective'
import { qualityScore, type QualityReport } from './quality'

export interface SchedulerSession {
  id: string
  title: string
  duration: number | null
  expected_attendance: number | null
  status: 'pending' | 'approved' | 'rejected' | 'scheduled'
  time_slot_id: string | null
  track_id: string | null
  /** Legacy half-day preferences such as `friday_am`. */
  time_preferences: string[] | null
  required_features: string[] | null
  /** Session format (`talk`, `workshop`, ...); rooms may restrict formats. */
  format?: string | null
  /** Organizer pin: this session must be in this room (migration 0018). */
  pinned_venue_id?: string | null
  /** The host's availability (`time_preferences` table, spec §4.2): instants, preference 1 best. */
  windows?: ReadonlyArray<{ startsAt: string; endsAt: string; preference?: 1 | 2 | 3 }>
  blackouts?: ReadonlyArray<{ startsAt: string; endsAt: string }>
  /**
   * The people who must be in the room: the host plus every accepted co-host. Account ids,
   * compared only inside the scheduler (MT §12.18); never serialized into a response.
   */
  host_ids?: readonly string[] | null
  /** An accepted merger folded this proposal into another: the scheduler ignores it. */
  merged_into?: string | null
}

export interface SchedulerTimeSlot {
  id: string
  start_time: string
  end_time: string
  is_break: boolean
  venue_id: string | null
  day_date: string | null
  label?: string | null
}

export interface SchedulerVenue {
  id: string
  name: string
  capacity: number | null
  is_primary: boolean
  features: string[] | null
  /** Formats this room may host; null or empty = all (migration 0018). */
  allowed_formats?: string[] | null
}

/** Per session: total votes and the ballot tokens that named it (from `schedulingInputs`). */
export type BallotInputs = ReadonlyMap<string, { votes: number; tokens: ReadonlySet<string> }>

export interface ScheduleAssignment {
  sessionId: string
  sessionTitle: string
  slotId: string
  venueId: string
  score: number
  warnings: string[]
}

/** The five stages the PRD's progress view shows (§4.7 step 5). Computed synchronously. */
export interface SchedulerStage {
  key: 'clusters' | 'venues' | 'slots' | 'conflicts' | 'validation'
  name: string
  status: 'done'
  detail: string
}

export const SCHEDULER_STAGE_NAMES: ReadonlyArray<{ key: SchedulerStage['key']; name: string }> = [
  { key: 'clusters', name: 'Analyzing voter clusters' },
  { key: 'venues', name: 'Calculating venue requirements' },
  { key: 'slots', name: 'Optimizing time slot assignments' },
  { key: 'conflicts', name: 'Resolving conflicts' },
  { key: 'validation', name: 'Final validation' },
]

export interface AutoScheduleResult {
  assignments: ScheduleAssignment[]
  unassigned: { sessionId: string; sessionTitle: string; reason: string }[]
  stats: {
    totalSessions: number
    assigned: number
    unassigned: number
    averageScore: number
    /** Whether closed-round ballots informed ordering, capacity and overlap. */
    usedBallots: boolean
    /** The k-threshold applied to overlap pairs. */
    k: number
    /** Comparable pairs at or above the keep-apart line, across the whole gathering. */
    keepApartPairs: number
  }
  /** Quality of the proposed schedule including sessions already placed by hand. */
  quality: QualityReport
  improvement: HillClimbStats
  stages: SchedulerStage[]
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function minutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 60_000)
}

function dayName(dayDate: string): string {
  return DAY_NAMES[new Date(`${dayDate}T12:00:00Z`).getUTCDay()]
}

/** Morning or afternoon of an instant, in the event's own timezone. */
function halfOfDay(iso: string, timezone: string): '_am' | '_pm' {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)),
  )
  return hour < 12 ? '_am' : '_pm'
}

interface Placement {
  occupied: Set<string>
  tracksAtTime: Map<string, Set<string>>
  sessionsAtTime: Map<string, string[]>
}

function scoreSlot(
  session: SchedulerSession,
  slot: SchedulerTimeSlot,
  venue: SchedulerVenue,
  placement: Placement,
  ballots: BallotInputs,
  timezone: string,
  overlap: ReadonlyMap<string, OverlapPair>,
): { score: number; warnings: string[] } {
  const warnings: string[] = []
  let score = 0
  const votes = ballots.get(session.id)?.votes ?? 0

  // 1. Duration
  const slotMinutes = minutesBetween(slot.start_time, slot.end_time)
  const duration = session.duration ?? slotMinutes
  if (duration === slotMinutes) score += 8
  else {
    score += Math.abs(duration - slotMinutes) <= 15 ? 4 : 1
    warnings.push(`Duration mismatch: session is ${duration} min, slot is ${slotMinutes} min`)
  }

  // 2. Time preference
  const slotStart = Date.parse(slot.start_time)
  const slotEnd = Date.parse(slot.end_time)
  const overlapsRange = (w: { startsAt: string; endsAt: string }) => Date.parse(w.startsAt) < slotEnd && slotStart < Date.parse(w.endsAt)
  const blackout = (session.blackouts ?? []).some(overlapsRange)
  if (blackout) {
    score -= 20
    warnings.push('The host marked this time as unavailable')
  }
  const prefs = session.time_preferences ?? []
  const windows = session.windows ?? []
  if (windows.length > 0) {
    const inside = windows
      .filter((w) => Date.parse(w.startsAt) <= slotStart && slotEnd <= Date.parse(w.endsAt))
      .map((w) => w.preference ?? 1)
    if (inside.length > 0) {
      const best = Math.min(...inside)
      score += best === 1 ? 10 : best === 2 ? 7 : 4
    } else if (windows.some(overlapsRange)) {
      score += 2
      warnings.push('Only partly inside the host’s preferred times')
    }
  } else if (prefs.length > 0 && slot.day_date) {
    const day = dayName(slot.day_date)
    const half = halfOfDay(slot.start_time, timezone)
    if (prefs.includes(`${day}${half}`)) score += 10
    else if (prefs.some((p) => p.replace(/_(am|pm)$/, '') === day)) score += 3
  }

  // 3. Venue features
  const required = session.required_features ?? []
  if (required.length > 0) {
    const have = new Set(venue.features ?? [])
    const missing = required.filter((f) => !have.has(f))
    if (missing.length === 0) score += 6
    else {
      if (missing.length === 1) score += 2
      warnings.push(`Missing ${missing.length === 1 ? 'feature' : 'features'}: ${missing.join(', ')}`)
    }
  } else {
    score += 3
  }

  // 4. Capacity (expected attendance, or closed-round votes as a proxy)
  const estimate = session.expected_attendance ?? votes
  if (venue.capacity) {
    if (estimate <= venue.capacity * 0.7) score += 5
    else if (estimate <= venue.capacity) {
      score += 3
      warnings.push(`Room may be tight: ~${estimate} expected, capacity ${venue.capacity}`)
    } else {
      warnings.push(`Over capacity: ~${estimate} expected, capacity ${venue.capacity}`)
    }
  } else {
    score += 2
  }

  // 5. Track spread
  const timeKey = `${slot.start_time}|${slot.end_time}`
  if (session.track_id) {
    if (placement.tracksAtTime.get(timeKey)?.has(session.track_id)) {
      warnings.push('Track conflict: same track at the same time')
    } else {
      score += 3
    }
  } else {
    score += 1
  }

  // 6. Ballot-token overlap with sessions already placed at the same time. One metric, one
  //    k-filter: `clusters.ts`, exactly as objective.ts and the clusters panel read it.
  const concurrent = placement.sessionsAtTime.get(timeKey) ?? []
  const worst = concurrent.length > 0 ? maxPairOverlap(overlap, session.id, concurrent) : null
  if (worst) {
    const max = worst.coefficient
    if (max >= KEEP_APART_THRESHOLD) {
      score -= 4
      warnings.push(`High voter overlap (${Math.round(max * 100)}%) with a session at the same time`)
    } else if (max >= 0.3) {
      score -= 2
      warnings.push(`Moderate voter overlap (${Math.round(max * 100)}%) with a session at the same time`)
    } else if (max < 0.1) {
      score += 2
    }
  } else {
    score += 2
  }

  // 7. Primary venue for sessions many people voted for
  if (venue.is_primary && votes > 20) score += 2

  // 8. Hard constraints the organizer set (objective.ts charges these ×1000; the greedy
  //    seed simply avoids them).
  if (session.pinned_venue_id && session.pinned_venue_id !== venue.id) {
    score -= 50
    warnings.push('Pinned to another room')
  }
  const allowed = venue.allowed_formats ?? []
  if (allowed.length > 0 && session.format && !allowed.includes(session.format)) {
    score -= 50
    warnings.push(`${venue.name} does not host ${session.format} sessions`)
  }

  return { score, warnings }
}

export interface AutoScheduleOptions {
  ballots?: BallotInputs
  timezone: string
  /** The gathering's `feedbackK`; pairs with fewer tokens on either side are not constrained. */
  k?: number
  /** Local-search settings, or `false` to return the greedy seed only. */
  improve?: false | { budgetMs?: number; maxPasses?: number }
}

export function autoSchedule(
  sessions: readonly SchedulerSession[],
  timeSlots: readonly SchedulerTimeSlot[],
  venues: readonly SchedulerVenue[],
  options: AutoScheduleOptions,
): AutoScheduleResult {
  const ballots: BallotInputs = options.ballots ?? new Map()
  const k = options.k ?? DEFAULT_POLICY_THRESHOLDS.feedbackK
  // One k-filtered overlap lookup for the seed, the objective and the report (design §9.2).
  const overlap = overlapIndex(overlapMatrix(ballots, k))
  const votesOf = (id: string) => ballots.get(id)?.votes ?? 0
  const queue = sessions
    .filter((s) => s.status === 'approved' && !s.time_slot_id && !s.merged_into)
    .map((s, index) => ({ s, index }))
    .sort((a, b) => votesOf(b.s.id) - votesOf(a.s.id) || a.index - b.index)
    .map(({ s }) => s)

  const venueById = new Map(venues.map((v) => [v.id, v]))
  const placement: Placement = {
    // Slots already holding a session (scheduled by hand) are not free.
    occupied: new Set(sessions.filter((s) => s.time_slot_id).map((s) => s.time_slot_id!)),
    tracksAtTime: new Map(),
    sessionsAtTime: new Map(),
  }
  const slotById = new Map(timeSlots.map((t) => [t.id, t]))
  for (const s of sessions) {
    const slot = s.time_slot_id ? slotById.get(s.time_slot_id) : undefined
    if (!slot) continue
    const key = `${slot.start_time}|${slot.end_time}`
    placement.sessionsAtTime.set(key, [...(placement.sessionsAtTime.get(key) ?? []), s.id])
    if (s.track_id) placement.tracksAtTime.set(key, new Set([...(placement.tracksAtTime.get(key) ?? []), s.track_id]))
  }

  const candidates = timeSlots.filter((t) => !t.is_break && t.venue_id && venueById.has(t.venue_id))
  const assignments: ScheduleAssignment[] = []
  const unassigned: AutoScheduleResult['unassigned'] = []

  for (const session of queue) {
    let best: { slot: SchedulerTimeSlot; venue: SchedulerVenue; score: number; warnings: string[] } | null = null
    for (const slot of candidates) {
      if (placement.occupied.has(slot.id)) continue
      const venue = venueById.get(slot.venue_id!)!
      const { score, warnings } = scoreSlot(session, slot, venue, placement, ballots, options.timezone, overlap)
      if (!best || score > best.score) best = { slot, venue, score, warnings }
    }
    if (!best || best.score < 0) {
      unassigned.push({ sessionId: session.id, sessionTitle: session.title, reason: 'No free slot fits this session' })
      continue
    }
    placement.occupied.add(best.slot.id)
    const key = `${best.slot.start_time}|${best.slot.end_time}`
    placement.sessionsAtTime.set(key, [...(placement.sessionsAtTime.get(key) ?? []), session.id])
    if (session.track_id) {
      placement.tracksAtTime.set(key, new Set([...(placement.tracksAtTime.get(key) ?? []), session.track_id]))
    }
    assignments.push({
      sessionId: session.id,
      sessionTitle: session.title,
      slotId: best.slot.id,
      venueId: best.venue.id,
      score: best.score,
      warnings: best.warnings,
    })
  }

  // Local search over the greedy seed, with hand-placed sessions fixed.
  const ctx = buildObjectiveContext(sessions, timeSlots, venues, { ballots, k, timezone: options.timezone })
  const seed = new Map<string, SlotPlacement>(ctx.fixed)
  for (const a of assignments) seed.set(a.sessionId, { slotId: a.slotId, venueId: a.venueId })
  const improved = options.improve === false
    ? hillClimb(seed, ctx, { budgetMs: 0, maxPasses: 0 })
    : hillClimb(seed, ctx, { budgetMs: options.improve?.budgetMs ?? 2000, maxPasses: options.improve?.maxPasses })

  // Re-score every proposed placement where it ended up, against everything else placed.
  const final = improved.assignments
  const sessionById = new Map(sessions.map((s) => [s.id, s]))
  const keepApartNotes = new Map<string, string[]>()
  for (const { a, b, pair } of concurrentOverlaps(final, ctx)) {
    if (pair.coefficient < KEEP_APART_THRESHOLD) continue
    const pct = Math.round(pair.coefficient * 100)
    keepApartNotes.set(a, [...(keepApartNotes.get(a) ?? []), `Keep apart: ${pct}% voter overlap with "${sessionById.get(b)?.title ?? 'a session'}" at the same time`])
    keepApartNotes.set(b, [...(keepApartNotes.get(b) ?? []), `Keep apart: ${pct}% voter overlap with "${sessionById.get(a)?.title ?? 'a session'}" at the same time`])
  }
  const rescored: ScheduleAssignment[] = []
  for (const a of assignments) {
    const p = final.get(a.sessionId)!
    const slot = slotById.get(p.slotId)!
    const venue = venueById.get(p.venueId)!
    const others: Placement = { occupied: new Set(), tracksAtTime: new Map(), sessionsAtTime: new Map() }
    for (const [otherId, op] of final) {
      if (otherId === a.sessionId) continue
      const os = slotById.get(op.slotId)
      if (!os) continue
      const key = `${os.start_time}|${os.end_time}`
      others.sessionsAtTime.set(key, [...(others.sessionsAtTime.get(key) ?? []), otherId])
      const track = sessionById.get(otherId)?.track_id
      if (track) others.tracksAtTime.set(key, new Set([...(others.tracksAtTime.get(key) ?? []), track]))
    }
    const { score, warnings } = scoreSlot(sessionById.get(a.sessionId)!, slot, venue, others, ballots, options.timezone, overlap)
    rescored.push({
      sessionId: a.sessionId,
      sessionTitle: a.sessionTitle,
      slotId: p.slotId,
      venueId: p.venueId,
      score,
      warnings: [...warnings, ...(keepApartNotes.get(a.sessionId) ?? [])],
    })
  }

  const quality = qualityScore(final, ctx)
  const keepApart = keepApartPairs(ctx.matrix).length
  const freeSlots = candidates.length - ctx.fixed.size
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const stages: SchedulerStage[] = [
    {
      ...SCHEDULER_STAGE_NAMES[0], status: 'done',
      detail: `${ctx.matrix.comparableSessions.length} sessions compared, ${keepApart} keep-apart pair${keepApart === 1 ? '' : 's'}, ${ctx.matrix.suppressedCount} pair${ctx.matrix.suppressedCount === 1 ? '' : 's'} below k=${k}`,
    },
    {
      ...SCHEDULER_STAGE_NAMES[1], status: 'done',
      detail: `${queue.length} session${queue.length === 1 ? '' : 's'} to place, ${venues.length} room${venues.length === 1 ? '' : 's'}, ${freeSlots} open slot${freeSlots === 1 ? '' : 's'}`,
    },
    {
      ...SCHEDULER_STAGE_NAMES[2], status: 'done',
      detail: `Seed placed ${assignments.length} of ${queue.length}${unassigned.length ? `; ${unassigned.length} left unplaced` : ''}`,
    },
    {
      ...SCHEDULER_STAGE_NAMES[3], status: 'done',
      detail: `${improved.stats.moves} move${improved.stats.moves === 1 ? '' : 's'} and ${improved.stats.swaps} swap${improved.stats.swaps === 1 ? '' : 's'} in ${improved.stats.passes} pass${improved.stats.passes === 1 ? '' : 'es'} (cost ${fmt(improved.stats.seedCost.total)} → ${fmt(improved.cost.total)}, ${improved.stats.stoppedBy})`,
    },
    {
      ...SCHEDULER_STAGE_NAMES[4], status: 'done',
      detail: `Quality ${quality.score}/100, ${quality.keepApartConflicts} keep-apart conflict${quality.keepApartConflicts === 1 ? '' : 's'}, ${quality.violations.length} violation${quality.violations.length === 1 ? '' : 's'}, ${quality.warnings.length} warning${quality.warnings.length === 1 ? '' : 's'}`,
    },
  ]

  const average = rescored.length ? rescored.reduce((sum, a) => sum + a.score, 0) / rescored.length : 0
  return {
    assignments: rescored,
    unassigned,
    stats: {
      totalSessions: queue.length,
      assigned: rescored.length,
      unassigned: unassigned.length,
      averageScore: Math.round(average * 100) / 100,
      usedBallots: ballots.size > 0,
      k,
      keepApartPairs: keepApart,
    },
    quality,
    improvement: improved.stats,
    stages,
  }
}
