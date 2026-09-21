/**
 * Audience clusters (release design §9.2, PRD §4.7 step 3).
 *
 * Overlap between two sessions is the overlap coefficient over BALLOT TOKENS (spec §5.4):
 * `|A∩B| / min(|A|, |B|)` — the PRD's "shared voters" reading — with `|A∩B|` kept as the
 * weight (people who wanted both). Tokens link one participant's votes to each other and to
 * nobody; even so, nothing here ever returns a token or a token set, only counts and ratios,
 * and pairs where either side has fewer than `k` tokens (the gathering's `feedbackK`) are
 * neither shown nor constrained.
 *
 * Pure: no I/O.
 */
import type { BallotInputs } from './auto-scheduler'

/** ≥ this coefficient: "must be in different time slots" (PRD: HIGH OVERLAP, >60%). */
export const KEEP_APART_THRESHOLD = 0.6
/** < this coefficient: "can safely run at the same time" (PRD: GOOD PARALLEL OPTIONS, <20%). */
export const FINE_TOGETHER_THRESHOLD = 0.2

export interface OverlapPair {
  /** Session ids, `a < b` lexically. */
  a: string
  b: string
  /** People (tokens) who voted for both. */
  shared: number
  /** `shared / min(|A|, |B|)`, 0..1. */
  coefficient: number
}

export interface OverlapMatrix {
  /** Every comparable pair (both sides ≥ k tokens), including pairs with no shared voters. */
  pairs: OverlapPair[]
  /** Sessions with ≥ k tokens. */
  comparableSessions: string[]
  /** Pairs of voted-for sessions where at least one side has fewer than k tokens. */
  suppressedCount: number
  /** Voted-for sessions with fewer than k tokens. */
  suppressedSessions: number
  k: number
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** `{ shared, coefficient }` of two token sets; 0 when either is empty. */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): { shared: number; coefficient: number } {
  if (a.size === 0 || b.size === 0) return { shared: 0, coefficient: 0 }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const token of small) if (large.has(token)) shared++
  return { shared, coefficient: shared / small.size }
}

/**
 * Pairwise overlap for every pair of sessions that both have at least `k` tokens.
 * Deterministic: sessions are visited in id order.
 */
export function overlapMatrix(ballots: BallotInputs, k: number): OverlapMatrix {
  const threshold = Math.max(1, Math.floor(k))
  const voted = [...ballots.entries()].filter(([, v]) => v.tokens.size > 0).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  const comparable = voted.filter(([, v]) => v.tokens.size >= threshold)
  const suppressedSessions = voted.length - comparable.length
  const pairs: OverlapPair[] = []
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const [a, va] = comparable[i]
      const [b, vb] = comparable[j]
      pairs.push({ a, b, ...overlapCoefficient(va.tokens, vb.tokens) })
    }
  }
  const allPairs = (voted.length * (voted.length - 1)) / 2
  return {
    pairs,
    comparableSessions: comparable.map(([id]) => id),
    suppressedCount: allPairs - pairs.length,
    suppressedSessions,
    k: threshold,
  }
}

/** Index of comparable pairs by `pairKey`. */
export function overlapIndex(matrix: OverlapMatrix): Map<string, OverlapPair> {
  return new Map(matrix.pairs.map((p) => [pairKey(p.a, p.b), p]))
}

/** Pairs at or above the keep-apart line, strongest first. */
export function keepApartPairs(matrix: OverlapMatrix, threshold = KEEP_APART_THRESHOLD): OverlapPair[] {
  return matrix.pairs
    .filter((p) => p.coefficient >= threshold)
    .sort((x, y) => y.coefficient - x.coefficient || y.shared - x.shared || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : 1))
}

export interface FineTogetherSet {
  sessionIds: string[]
  /** The largest pairwise coefficient inside the set (always < threshold). */
  maxCoefficient: number
}

/**
 * Greedy grouping of comparable sessions whose pairwise overlap is all below the
 * fine-together line. Each session lands in the first group it fits; groups of one are
 * dropped. Sessions are visited most-voted first (then by id) so the biggest audiences seed
 * the groups.
 */
export function fineTogetherSets(matrix: OverlapMatrix, ballots: BallotInputs, threshold = FINE_TOGETHER_THRESHOLD): FineTogetherSet[] {
  const index = overlapIndex(matrix)
  const order = [...matrix.comparableSessions].sort((x, y) => {
    const vx = ballots.get(x)?.tokens.size ?? 0
    const vy = ballots.get(y)?.tokens.size ?? 0
    return vy - vx || (x < y ? -1 : x > y ? 1 : 0)
  })
  const groups: Array<{ ids: string[]; max: number }> = []
  for (const id of order) {
    let placed = false
    for (const g of groups) {
      let max = g.max
      let fits = true
      for (const other of g.ids) {
        const pair = index.get(pairKey(id, other))
        if (!pair || pair.coefficient >= threshold) {
          fits = false
          break
        }
        max = Math.max(max, pair.coefficient)
      }
      if (fits) {
        g.ids.push(id)
        g.max = max
        placed = true
        break
      }
    }
    if (!placed) groups.push({ ids: [id], max: 0 })
  }
  return groups.filter((g) => g.ids.length >= 2).map((g) => ({ sessionIds: g.ids, maxCoefficient: g.max }))
}

export interface AudienceClusters {
  k: number
  keepApart: OverlapPair[]
  fineTogether: FineTogetherSet[]
  comparableSessions: number
  suppressedCount: number
  suppressedSessions: number
}

/** The organizer's pre-run view (percentages and counts only; never tokens). */
export function audienceClusters(ballots: BallotInputs, k: number): AudienceClusters {
  const matrix = overlapMatrix(ballots, k)
  return {
    k: matrix.k,
    keepApart: keepApartPairs(matrix),
    fineTogether: fineTogetherSets(matrix, ballots),
    comparableSessions: matrix.comparableSessions.length,
    suppressedCount: matrix.suppressedCount,
    suppressedSessions: matrix.suppressedSessions,
  }
}
