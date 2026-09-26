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

function compareName(a: MemberCardData, b: MemberCardData): number {
  return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' })
}

/**
 * `sharedCounts` is how many of the viewer's interests each person also lists, keyed by account
 * id — exactly what the route's `sharedInterests` says, so the sort and the "People who share
 * your interests" section can never disagree. Name breaks every tie, so the order is stable.
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
