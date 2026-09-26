/**
 * How the People directory can be ordered (design §3.4).
 *
 * Pure: no React, no `server-only`, so the ordering is testable on its own.
 *
 * Sorting happens in the browser. `GET /api/v1/events/[slug]/participants` is not paged — it
 * returns the whole roster of one gathering in one response — so there is nothing to order
 * server-side that the client cannot, and the route keeps its single deterministic order.
 */

import { MEMBER_ROLE } from '@/lib/labels'
import { nameOf, type MemberCardData } from './shared'

/**
 * "Shares most interests with you" is the default when the viewer lists interests of their own:
 * it is the ordering that answers "who should I talk to". Without interests it would be
 * arbitrary, so Name takes over (`defaultSort`).
 */
export const SORTS = {
  shared: 'Shares most interests with you',
  name: 'Name',
  joined: 'Recently joined',
  role: 'Role',
} as const

export type SortKey = keyof typeof SORTS

export function isSortKey(value: string | null | undefined): value is SortKey {
  return !!value && Object.prototype.hasOwnProperty.call(SORTS, value)
}

export function defaultSort(viewerHasInterests: boolean): SortKey {
  return viewerHasInterests ? 'shared' : 'name'
}

/** Organizers first, then the other roles in the order the vocabulary lists them. */
const ROLE_ORDER = Object.keys(MEMBER_ROLE)

/** An interest as two spellings of it compare: trimmed, case-folded. */
function interestKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * How many of the viewer's interests each person also lists, keyed by account id.
 *
 * Computed here rather than read from the route's `sharedInterests`, which is truncated to the
 * six people it suggests on the card strip — sorting a roster of fifty by a list of six would put
 * the other forty-four in a tie. The payload already carries everyone's interests, so the full
 * overlap costs one pass. Matching is case- and whitespace-insensitive, like the route's.
 */
export function overlapCounts(participants: readonly MemberCardData[]): Map<string, number> {
  const mine = new Set((participants.find((p) => p.is_self)?.interests ?? []).map(interestKey))
  mine.delete('')
  const counts = new Map<string, number>()
  if (!mine.size) return counts
  for (const person of participants) {
    if (person.is_self || !person.interests?.length) continue
    let n = 0
    const seen = new Set<string>()
    for (const interest of person.interests) {
      const key = interestKey(interest)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (mine.has(key)) n += 1
    }
    if (n) counts.set(person.id, n)
  }
  return counts
}

/** Whether the viewer lists any interest of their own — what `defaultSort` turns on. */
export function hasOwnInterests(participants: readonly MemberCardData[]): boolean {
  return (participants.find((p) => p.is_self)?.interests ?? []).some((i) => interestKey(i) !== '')
}

function compareName(a: MemberCardData, b: MemberCardData): number {
  return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' })
}

/**
 * `sharedCounts` is how many of the viewer's interests each person also lists, keyed by account
 * id — `overlapCounts` over the whole roster, not the route's six suggestions. Name breaks every
 * tie, so the order is stable.
 */
export function sortParticipants<T extends MemberCardData>(
  list: readonly T[],
  sort: SortKey,
  sharedCounts: Map<string, number>,
): T[] {
  const out = [...list]
  if (sort === 'name') return out.sort(compareName)
  if (sort === 'joined') {
    return out.sort((a, b) => {
      const at = a.joined_at ? Date.parse(a.joined_at) : 0
      const bt = b.joined_at ? Date.parse(b.joined_at) : 0
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at) || compareName(a, b)
    })
  }
  if (sort === 'role') {
    return out.sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role)
      const bi = ROLE_ORDER.indexOf(b.role)
      return (ai < 0 ? ROLE_ORDER.length : ai) - (bi < 0 ? ROLE_ORDER.length : bi) || compareName(a, b)
    })
  }
  return out.sort((a, b) => (sharedCounts.get(b.id) ?? 0) - (sharedCounts.get(a.id) ?? 0) || compareName(a, b))
}
