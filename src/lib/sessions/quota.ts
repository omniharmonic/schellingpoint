import 'server-only'
/**
 * The per-person proposal cap, made visible (inventory 3.5 / P2-12).
 *
 * The rule itself lives in `enforce_event_proposal_rules` (migration 0001): a person may host
 * at most `events.max_proposals_per_user` sessions in one gathering, whatever their status.
 * The trigger is still the authority — this module only lets the propose page say "2 of 5
 * proposals used" and lets the API answer a clear 409 instead of a bare 23514.
 *
 * A cap of 0 (or NULL) means "no limit", exactly as the trigger reads it — and so does being an
 * owner or admin, because `enforce_event_proposal_rules` returns early for them ("Organizers can
 * curate the program throughout setup and scheduling"). The quota has to agree with the database
 * it is describing: telling an owner they are at their limit when the database would happily
 * accept the insert is worse than not showing a quota at all.
 */
import { sql, type Sql } from '@/lib/db'
import type { EventRoleName } from '@/types/event'

/** Roles `enforce_event_proposal_rules` waves through before it ever counts (migration 0001). */
export const UNCAPPED_ROLES: readonly EventRoleName[] = ['owner', 'admin']

export function isUncappedRole(role: EventRoleName | null | undefined): boolean {
  return !!role && UNCAPPED_ROLES.includes(role)
}

export interface ProposalQuota {
  used: number
  /** null when the gathering sets no cap. */
  limit: number | null
  remaining: number | null
  atLimit: boolean
}

export function quotaOf(
  used: number,
  cap: number | null | undefined,
  role?: EventRoleName | null,
): ProposalQuota {
  const limit = isUncappedRole(role) || !(typeof cap === 'number' && cap > 0) ? null : cap
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    atLimit: limit !== null && used >= limit,
  }
}

/** The viewer's standing against one gathering's cap. Counts the same rows the trigger counts. */
export async function proposalQuota(
  eventId: string,
  accountId: string,
  cap: number | null | undefined,
  role?: EventRoleName | null,
  db: Sql = sql,
): Promise<ProposalQuota> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from sessions where event_id = ${eventId} and host_id = ${accountId}
  `
  return quotaOf(row?.n ?? 0, cap, role)
}

/** The message shown on the form and returned by the API when the cap is reached. */
export function proposalLimitMessage(quota: ProposalQuota): string {
  return `You have used all ${quota.limit} of your proposals for this gathering. Withdraw one to propose something else, or ask an organizer.`
}
