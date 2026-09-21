/**
 * Local search over a seed schedule (release design §9.2 "Search").
 *
 * Starting from the greedy seed, repeatedly try (a) moving one movable session into any free
 * slot and (b) swapping two movable sessions; accept a candidate only when the objective
 * strictly improves. Stop after a full pass without improvement, after `maxPasses`, or when
 * the time budget runs out. Hand-placed sessions (`ctx.fixed`) are never moved. The visiting
 * order is fixed (ids and slot order), so the result is deterministic given the inputs and
 * enough budget.
 *
 * Pure: no I/O.
 */
import { placementCost, type AssignmentMap, type CostBreakdown, type ObjectiveContext, type Placement } from './objective'

export interface HillClimbOptions {
  /** Wall-clock budget; the search stops between candidates once it is spent (default 2000). */
  budgetMs?: number
  /** Hard cap on passes (default 50). */
  maxPasses?: number
  /** Clock, for tests. */
  now?: () => number
}

export interface HillClimbStats {
  passes: number
  evaluations: number
  moves: number
  swaps: number
  elapsedMs: number
  stoppedBy: 'converged' | 'budget' | 'maxPasses' | 'nothingToMove'
  seedCost: CostBreakdown
  finalCost: CostBreakdown
}

export interface HillClimbResult {
  assignments: Map<string, Placement>
  cost: CostBreakdown
  stats: HillClimbStats
}

const EPSILON = 1e-9
const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

export function hillClimb(seed: AssignmentMap, ctx: ObjectiveContext, options: HillClimbOptions = {}): HillClimbResult {
  const budgetMs = options.budgetMs ?? 2000
  const maxPasses = options.maxPasses ?? 50
  const now = options.now ?? (() => Date.now())
  const startedAt = now()

  const current = new Map<string, Placement>(seed)
  let cost = placementCost(current, ctx)
  const seedCost = cost
  const stats: HillClimbStats = { passes: 0, evaluations: 1, moves: 0, swaps: 0, elapsedMs: 0, stoppedBy: 'converged', seedCost, finalCost: cost }

  const movable = [...current.keys()].filter((id) => !ctx.fixed.has(id)).sort(byId)
  const finish = (stoppedBy: HillClimbStats['stoppedBy']): HillClimbResult => {
    stats.stoppedBy = stoppedBy
    stats.finalCost = cost
    stats.elapsedMs = now() - startedAt
    return { assignments: current, cost, stats }
  }
  if (movable.length === 0) return finish('nothingToMove')

  const slotVenue = new Map(ctx.candidateSlots.map((s) => [s.id, s.venue_id!]))
  const overBudget = () => now() - startedAt >= budgetMs

  const evaluate = (candidate: AssignmentMap): CostBreakdown => {
    stats.evaluations++
    return placementCost(candidate, ctx)
  }

  while (stats.passes < maxPasses) {
    stats.passes++
    let improved = false

    // (a) Single moves into free candidate slots.
    for (const id of movable) {
      let mine = current.get(id)!
      const occupied = new Set([...current.values()].map((p) => p.slotId))
      for (const slot of ctx.candidateSlots) {
        if (overBudget()) return finish('budget')
        if (slot.id === mine.slotId || occupied.has(slot.id)) continue
        const next: Placement = { slotId: slot.id, venueId: slotVenue.get(slot.id)! }
        current.set(id, next)
        const candidate = evaluate(current)
        if (candidate.total < cost.total - EPSILON) {
          cost = candidate
          improved = true
          stats.moves++
          occupied.delete(mine.slotId)
          occupied.add(slot.id)
          mine = next
        } else {
          current.set(id, mine)
        }
      }
    }

    // (b) Pairwise swaps between movable sessions.
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < movable.length; j++) {
        if (overBudget()) return finish('budget')
        const a = movable[i]
        const b = movable[j]
        const pa = current.get(a)!
        const pb = current.get(b)!
        if (pa.slotId === pb.slotId) continue
        current.set(a, pb)
        current.set(b, pa)
        const candidate = evaluate(current)
        if (candidate.total < cost.total - EPSILON) {
          cost = candidate
          improved = true
          stats.swaps++
        } else {
          current.set(a, pa)
          current.set(b, pb)
        }
      }
    }

    if (!improved) return finish('converged')
  }
  return finish('maxPasses')
}
