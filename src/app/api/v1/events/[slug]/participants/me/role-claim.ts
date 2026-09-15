import 'server-only'
/**
 * The one call from package G into package F's role-claim writer (plan §7.2, checklist item 20):
 * `setRoleClaimOptIn(accountId, eventId, on)` from `@/lib/atproto/role-claims`.
 *
 * F writes the subject gate (`event_members.public_role`, 0008) and then applies the other two
 * gates (policy `publishRoles`, derived role ≥ Host), writing or deleting the
 * `coop.lexicon.membership` record. Turning the switch off retracts immediately.
 *
 * The opt-in column is written before any network call, so a PDS failure never loses the
 * person's choice; the outcome is reported so the UI can say what happened.
 */
import { RoleClaimError, setRoleClaimOptIn, type RoleClaimOutcome as FOutcome } from '@/lib/atproto/role-claims'

export interface RoleClaimOutcome {
  status: FOutcome | 'error'
  uri?: string | null
  error?: string
}

export async function applyRoleClaimOptIn(input: { eventId: string; accountId: string; optIn: boolean }): Promise<RoleClaimOutcome> {
  try {
    const result = await setRoleClaimOptIn(input.accountId, input.eventId, input.optIn)
    return { status: result.outcome, uri: result.uri ?? null }
  } catch (e) {
    if (e instanceof RoleClaimError) return { status: 'error', error: e.message }
    console.error('[participants] role claim failed:', e instanceof Error ? e.message : e)
    return { status: 'error', error: 'Your choice is saved, but the public listing could not be updated yet.' }
  }
}
