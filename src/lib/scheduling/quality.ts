/**
 * Quality score of a schedule (release design §9.2):
 *
 *   100 − 60 · (conflict people / total voter-session pairs)
 *       − 25 · (over-capacity people / total demand)
 *       − 15 · (any constraint violation ? 1 : 0),  clamped to 0..100.
 *
 * Plus the checks and warnings the PRD's review screen shows (§4.7 step 6): "no keep-apart
 * conflicts", "constraints met", over-capacity rooms, empty rooms in a time row that has
 * sessions, and near-misses (concurrent pairs just under the keep-apart line).
 *
 * Pure: no I/O. Works on any draft, including the builder's drag-drop state.
 */
import { KEEP_APART_THRESHOLD } from './clusters'
import {
  concurrentOverlaps,
  constraintViolations,
  demandOf,
  placementCost,
  timeKeyOf,
  type AssignmentMap,
  type CostBreakdown,
  type ObjectiveContext,
} from './objective'

/** Concurrent pairs from here up to the keep-apart line are reported as near-misses. */
export const NEAR_MISS_THRESHOLD = 0.4

export interface QualityReport {
  /** 0..100 */
  score: number
  /** People who wanted two sessions that run at the same time (comparable pairs only). */
  conflictPeople: number
  /** Σ over sessions of their voter count: the denominator of the conflict ratio. */
  totalVoterSessionPairs: number
  /** Σ max(0, demand − capacity) over placed sessions. */
  overCapacityPeople: number
  /** Σ demand over placed sessions. */
  totalDemand: number
  violations: string[]
  warnings: string[]
  keepApartConflicts: number
  /** Concurrent comparable pairs at or above the near-miss line, by session id (for the builder's cells). */
  conflicts: Array<{ a: string; b: string; overlapPercent: number; kind: 'keepApart' | 'nearMiss' }>
  checks: { noKeepApartConflicts: boolean; constraintsMet: boolean }
  cost: CostBreakdown
  placed: number
}

function percent(v: number): string {
  return `${Math.round(v * 100)}%`
}

function slotLabel(slotId: string, ctx: ObjectiveContext): string {
  const slot = ctx.slots.get(slotId)
  if (!slot) return 'an unknown time'
  if (slot.label) return slot.label
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: ctx.timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(slot.start_time))
  } catch {
    return slot.start_time
  }
}

function titleOf(sessionId: string, ctx: ObjectiveContext): string {
  return `"${ctx.sessions.get(sessionId)?.title ?? 'Untitled session'}"`
}

export function qualityScore(assignments: AssignmentMap, ctx: ObjectiveContext): QualityReport {
  const cost = placementCost(assignments, ctx)
  const violations: string[] = []
  const warnings: string[] = []

  // Constraints.
  const slotUse = new Map<string, string[]>()
  for (const [sessionId, p] of [...assignments].sort(([x], [y]) => (x < y ? -1 : 1))) {
    violations.push(...constraintViolations(sessionId, p, ctx))
    slotUse.set(p.slotId, [...(slotUse.get(p.slotId) ?? []), sessionId])
  }
  for (const [slotId, ids] of slotUse) {
    if (ids.length > 1) violations.push(`${ids.map((id) => titleOf(id, ctx)).join(' and ')} are both in the same slot (${slotLabel(slotId, ctx)})`)
  }

  // Audience conflicts.
  let conflictPeople = 0
  let keepApartConflicts = 0
  const conflicts: QualityReport['conflicts'] = []
  for (const { a, b, pair } of concurrentOverlaps(assignments, ctx)) {
    conflictPeople += pair.shared
    if (pair.coefficient >= NEAR_MISS_THRESHOLD) {
      conflicts.push({ a, b, overlapPercent: Math.round(pair.coefficient * 100), kind: pair.coefficient >= KEEP_APART_THRESHOLD ? 'keepApart' : 'nearMiss' })
    }
    if (pair.coefficient >= KEEP_APART_THRESHOLD) {
      keepApartConflicts++
      warnings.push(`Keep apart: ${titleOf(a, ctx)} and ${titleOf(b, ctx)} share ${percent(pair.coefficient)} of their voters but run at the same time`)
    } else if (pair.coefficient >= NEAR_MISS_THRESHOLD) {
      warnings.push(`Near miss: ${titleOf(a, ctx)} and ${titleOf(b, ctx)} share ${percent(pair.coefficient)} of their voters and run at the same time`)
    }
  }
  let totalVoterSessionPairs = 0
  for (const v of ctx.ballots.values()) totalVoterSessionPairs += v.tokens.size

  // Capacity.
  let overCapacityPeople = 0
  let totalDemand = 0
  for (const [sessionId, p] of assignments) {
    const session = ctx.sessions.get(sessionId)
    const venue = ctx.venues.get(p.venueId)
    if (!session || !venue) continue
    const demand = demandOf(session, ctx.ballots)
    totalDemand += demand
    if (venue.capacity && demand > venue.capacity) {
      overCapacityPeople += demand - venue.capacity
      warnings.push(`Over capacity: ${titleOf(sessionId, ctx)} (~${demand} expected) is in ${venue.name} (capacity ${venue.capacity})`)
    }
  }

  // Empty rooms in time rows that do have sessions ("consider combining rooms").
  const usedTimeKeys = new Set<string>()
  for (const p of assignments.values()) {
    const slot = ctx.slots.get(p.slotId)
    if (slot) usedTimeKeys.add(timeKeyOf(slot))
  }
  for (const slot of ctx.candidateSlots) {
    if (!usedTimeKeys.has(timeKeyOf(slot)) || slotUse.has(slot.id)) continue
    const venue = ctx.venues.get(slot.venue_id!)
    warnings.push(`Empty room: ${venue?.name ?? 'a room'} has nothing at ${slotLabel(slot.id, ctx)}`)
  }

  const conflictRatio = totalVoterSessionPairs > 0 ? conflictPeople / totalVoterSessionPairs : 0
  const capacityRatio = totalDemand > 0 ? overCapacityPeople / totalDemand : 0
  const raw = 100 - 60 * conflictRatio - 25 * capacityRatio - (violations.length > 0 ? 15 : 0)
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  return {
    score,
    conflictPeople,
    totalVoterSessionPairs,
    overCapacityPeople,
    totalDemand,
    violations,
    warnings,
    keepApartConflicts,
    conflicts,
    checks: { noKeepApartConflicts: keepApartConflicts === 0, constraintsMet: violations.length === 0 },
    cost,
    placed: assignments.size,
  }
}
