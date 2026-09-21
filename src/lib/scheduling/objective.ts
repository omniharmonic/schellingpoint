/**
 * The placement objective (release design §9.2).
 *
 *   cost = Σ over concurrent comparable pairs  |A∩B| × (2 if overlap ≥ 0.6 else 1)
 *        + Σ max(0, demand − capacity)                     demand = expected attendance, else votes
 *        + constraint violations × 1000                     host blackout, pinned room, missing
 *                                                           feature, room format, broken placement
 *        + variance of per-time-key total votes × 0.1       balance high-demand sessions across time
 *
 * "Concurrent" is real interval overlap between two slots, not just an identical time key.
 * Pairs where either session has fewer than k ballot tokens are not constrained (clusters.ts).
 *
 * Pure: no I/O. Everything the search needs is precomputed once in `buildObjectiveContext`.
 */
import type { BallotInputs, SchedulerSession, SchedulerTimeSlot, SchedulerVenue } from './auto-scheduler'
import { KEEP_APART_THRESHOLD, overlapIndex, overlapMatrix, pairKey, type OverlapMatrix, type OverlapPair } from './clusters'

export interface Placement {
  slotId: string
  venueId: string
}

export type AssignmentMap = ReadonlyMap<string, Placement>

export const COST_WEIGHTS = Object.freeze({
  keepApart: 2,
  violation: 1000,
  imbalance: 0.1,
})

export interface ObjectiveContext {
  sessions: ReadonlyMap<string, SchedulerSession>
  slots: ReadonlyMap<string, SchedulerTimeSlot>
  venues: ReadonlyMap<string, SchedulerVenue>
  ballots: BallotInputs
  k: number
  timezone: string
  matrix: OverlapMatrix
  /** Comparable pairs by `pairKey(a, b)`. */
  overlap: ReadonlyMap<string, OverlapPair>
  /** Sessions already placed by hand (`time_slot_id` set): the search never moves them. */
  fixed: ReadonlyMap<string, Placement>
  /** Slots that may hold a session: not a break, with a room that exists. */
  candidateSlots: readonly SchedulerTimeSlot[]
  /** Distinct time keys of the candidate slots, sorted. */
  timeKeys: readonly string[]
  /** For each candidate slot, the other candidate slots whose interval overlaps it. */
  concurrentSlots: ReadonlyMap<string, readonly string[]>
}

export function timeKeyOf(slot: Pick<SchedulerTimeSlot, 'start_time' | 'end_time'>): string {
  return `${slot.start_time}|${slot.end_time}`
}

export function slotsConcurrent(a: Pick<SchedulerTimeSlot, 'start_time' | 'end_time'>, b: Pick<SchedulerTimeSlot, 'start_time' | 'end_time'>): boolean {
  return Date.parse(a.start_time) < Date.parse(b.end_time) && Date.parse(b.start_time) < Date.parse(a.end_time)
}

/** Expected attendance if the host gave one, else the closed round's votes, else 0. */
export function demandOf(session: Pick<SchedulerSession, 'id' | 'expected_attendance'>, ballots: BallotInputs): number {
  return session.expected_attendance ?? ballots.get(session.id)?.votes ?? 0
}

export function votesOf(sessionId: string, ballots: BallotInputs): number {
  return ballots.get(sessionId)?.votes ?? 0
}

const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

export function buildObjectiveContext(
  sessions: readonly SchedulerSession[],
  timeSlots: readonly SchedulerTimeSlot[],
  venues: readonly SchedulerVenue[],
  options: { ballots?: BallotInputs; k: number; timezone: string },
): ObjectiveContext {
  const ballots: BallotInputs = options.ballots ?? new Map()
  const venueById = new Map(venues.map((v) => [v.id, v]))
  const slotById = new Map(timeSlots.map((t) => [t.id, t]))
  const candidateSlots = timeSlots
    .filter((t) => !t.is_break && t.venue_id && venueById.has(t.venue_id))
    .sort((x, y) => Date.parse(x.start_time) - Date.parse(y.start_time) || byId(x.venue_id!, y.venue_id!) || byId(x.id, y.id))
  const concurrentSlots = new Map<string, string[]>()
  for (const a of candidateSlots) {
    const others: string[] = []
    for (const b of candidateSlots) if (a.id !== b.id && slotsConcurrent(a, b)) others.push(b.id)
    concurrentSlots.set(a.id, others)
  }
  const fixed = new Map<string, Placement>()
  for (const s of sessions) {
    const slot = s.time_slot_id ? slotById.get(s.time_slot_id) : undefined
    if (slot && slot.venue_id) fixed.set(s.id, { slotId: slot.id, venueId: slot.venue_id })
  }
  const matrix = overlapMatrix(ballots, options.k)
  return {
    sessions: new Map(sessions.map((s) => [s.id, s])),
    slots: slotById,
    venues: venueById,
    ballots,
    k: matrix.k,
    timezone: options.timezone,
    matrix,
    overlap: overlapIndex(matrix),
    fixed,
    candidateSlots,
    timeKeys: [...new Set(candidateSlots.map(timeKeyOf))].sort(),
    concurrentSlots,
  }
}

/** Human-readable constraint violations of one placement (empty when it is fine). */
export function constraintViolations(sessionId: string, placement: Placement, ctx: ObjectiveContext): string[] {
  const out: string[] = []
  const session = ctx.sessions.get(sessionId)
  const slot = ctx.slots.get(placement.slotId)
  const venue = ctx.venues.get(placement.venueId)
  const title = session ? `"${session.title}"` : 'A session'
  if (!session) out.push(`${title} is not part of this gathering`)
  if (!slot) {
    out.push(`${title}: unknown time slot`)
    return out
  }
  if (slot.is_break || !slot.venue_id) out.push(`${title} is placed in a break`)
  else if (slot.venue_id !== placement.venueId) out.push(`${title}: that time slot belongs to another room`)
  if (!venue) {
    out.push(`${title}: unknown room`)
    return out
  }
  if (!session) return out
  const slotStart = Date.parse(slot.start_time)
  const slotEnd = Date.parse(slot.end_time)
  if ((session.blackouts ?? []).some((w) => Date.parse(w.startsAt) < slotEnd && slotStart < Date.parse(w.endsAt))) {
    out.push(`${title}: the host is unavailable at this time`)
  }
  if (session.pinned_venue_id && session.pinned_venue_id !== placement.venueId) {
    const pinned = ctx.venues.get(session.pinned_venue_id)
    out.push(`${title} is pinned to ${pinned ? pinned.name : 'another room'}`)
  }
  const required = session.required_features ?? []
  if (required.length > 0) {
    const have = new Set(venue.features ?? [])
    const missing = required.filter((f) => !have.has(f))
    if (missing.length > 0) out.push(`${title} needs ${missing.join(', ')}; ${venue.name} has no ${missing.length === 1 ? missing[0] : 'such features'}`)
  }
  const allowed = venue.allowed_formats ?? []
  if (allowed.length > 0 && session.format && !allowed.includes(session.format)) {
    out.push(`${title} is a ${session.format}; ${venue.name} only hosts ${allowed.join(', ')}`)
  }
  return out
}

export interface ConcurrentPair {
  a: string
  b: string
  pair: OverlapPair
}

/**
 * Comparable session pairs that run at the same time under `assignments`. Each pair once,
 * in (a, b) id order.
 */
export function concurrentOverlaps(assignments: AssignmentMap, ctx: ObjectiveContext): ConcurrentPair[] {
  const sessionAtSlot = new Map<string, string[]>()
  for (const [sessionId, p] of assignments) {
    sessionAtSlot.set(p.slotId, [...(sessionAtSlot.get(p.slotId) ?? []), sessionId])
  }
  const out: ConcurrentPair[] = []
  const seen = new Set<string>()
  const ids = [...assignments.keys()].sort(byId)
  for (const a of ids) {
    const slotId = assignments.get(a)!.slotId
    const neighbours = [...(sessionAtSlot.get(slotId) ?? []), ...(ctx.concurrentSlots.get(slotId) ?? []).flatMap((s) => sessionAtSlot.get(s) ?? [])]
    for (const b of neighbours) {
      if (a === b) continue
      const key = pairKey(a, b)
      if (seen.has(key)) continue
      seen.add(key)
      const pair = ctx.overlap.get(key)
      if (pair) out.push(a < b ? { a, b, pair } : { a: b, b: a, pair })
    }
  }
  return out.sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b))
}

export interface CostBreakdown {
  total: number
  conflict: number
  capacity: number
  violations: number
  imbalance: number
  violationCount: number
}

export function placementCost(assignments: AssignmentMap, ctx: ObjectiveContext): CostBreakdown {
  // 1. Audience conflicts.
  let conflict = 0
  for (const { pair } of concurrentOverlaps(assignments, ctx)) {
    conflict += pair.shared * (pair.coefficient >= KEEP_APART_THRESHOLD ? COST_WEIGHTS.keepApart : 1)
  }

  // 2. Capacity, 3. constraints, 4. balance — one pass over the placements.
  let capacity = 0
  let violationCount = 0
  const votesAtTime = new Map<string, number>(ctx.timeKeys.map((k) => [k, 0]))
  const slotUse = new Map<string, number>()
  for (const [sessionId, p] of assignments) {
    violationCount += constraintViolations(sessionId, p, ctx).length
    slotUse.set(p.slotId, (slotUse.get(p.slotId) ?? 0) + 1)
    const session = ctx.sessions.get(sessionId)
    const venue = ctx.venues.get(p.venueId)
    if (session && venue && venue.capacity) capacity += Math.max(0, demandOf(session, ctx.ballots) - venue.capacity)
    const slot = ctx.slots.get(p.slotId)
    if (slot) {
      const key = timeKeyOf(slot)
      votesAtTime.set(key, (votesAtTime.get(key) ?? 0) + votesOf(sessionId, ctx.ballots))
    }
  }
  for (const n of slotUse.values()) if (n > 1) violationCount += n - 1
  const totals = [...votesAtTime.values()]
  let imbalance = 0
  if (totals.length > 1) {
    const mean = totals.reduce((s, v) => s + v, 0) / totals.length
    imbalance = totals.reduce((s, v) => s + (v - mean) ** 2, 0) / totals.length
  }

  const violations = violationCount * COST_WEIGHTS.violation
  const balance = imbalance * COST_WEIGHTS.imbalance
  return { total: conflict + capacity + violations + balance, conflict, capacity, violations, imbalance: balance, violationCount }
}
