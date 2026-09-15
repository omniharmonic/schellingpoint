import 'server-only'
/**
 * A gathering's own network identity (spec §8, plan §6 item 5): a DID minted on our PDS at
 * creation, handle `<slug>.<PDS_HANDLE_DOMAIN>` when the slug fits, credential wrapped into
 * `at_credentials`. Records are written later, by `publishGathering`, when the gathering
 * leaves `draft`.
 *
 * The handle namespace and the gathering namespace are one namespace (`src/lib/auth/handles.ts`),
 * so a slug that is a reserved label or an existing member's handle label is refused outright.
 */
import { sql } from '@/lib/db'
import { mintGatheringAccount } from '@/lib/auth/custody'
import { deleteAccount, PdsError, resolveHandleOnPds } from '@/lib/auth/pds'
import { handleDomain, isStaticReservedLabel, isValidGatheringLabel } from '@/lib/auth/handles'

/** The reference PDS refuses a first handle label longer than this ("Handle too long"). */
export const PDS_HANDLE_LABEL_MAX = 18

export interface GatheringHandlePreview {
  /** `<slug>.<domain>` when the gathering can hold it; null when a generated handle will be used. */
  handle: string | null
  domain: string
  generated: boolean
  reason: 'too-long' | null
}

/** What handle a gathering with this slug will get. No I/O beyond reading env. */
export function previewGatheringHandle(slug: string): GatheringHandlePreview {
  const domain = handleDomain()
  const label = slug.trim().toLowerCase()
  if (label.length > PDS_HANDLE_LABEL_MAX) return { handle: null, domain, generated: true, reason: 'too-long' }
  return { handle: `${label}.${domain}`, domain, generated: false, reason: null }
}

export type SlugLabelProblem = { error: string; code: 'ReservedLabel' | 'InvalidLabel' | 'HandleTaken' }

/**
 * Refuse a slug that cannot be a gathering subdomain: not a DNS label we accept, a reserved
 * label, or the label of an existing member handle (ours in Postgres, or anything our PDS
 * vouches for). `checkPds: false` skips the network lookup (slug-as-you-type validation).
 */
export async function slugLabelProblem(slug: string, opts: { checkPds?: boolean } = {}): Promise<SlugLabelProblem | null> {
  const label = slug.trim().toLowerCase()
  if (!isValidGatheringLabel(label)) {
    return { error: 'Use 3–32 lowercase letters, numbers and hyphens for the event URL.', code: 'InvalidLabel' }
  }
  if (isStaticReservedLabel(label)) return { error: 'That URL is reserved. Choose another.', code: 'ReservedLabel' }
  const handle = `${label}.${handleDomain()}`
  const owned = await sql`select 1 from accounts where lower(handle) = ${handle} limit 1`
  if (owned.length > 0) return { error: 'That name already belongs to someone on the network. Choose another URL.', code: 'HandleTaken' }
  if (opts.checkPds !== false) {
    try {
      const did = await resolveHandleOnPds(handle)
      if (did) {
        // A gathering we already hold keeps its own label (retrying the identity of an existing event).
        const ours = await sql`select 1 from events where actor_did = ${did} limit 1`
        if (ours.length === 0) {
          return { error: 'That name already belongs to someone on the network. Choose another URL.', code: 'HandleTaken' }
        }
      }
    } catch (e) {
      // "could not ask" is not "taken": creation still refuses a taken handle at mint time,
      // where the PDS draws a generated handle instead of colliding.
      console.warn('[events/identity] PDS handle lookup failed:', e instanceof Error ? e.message : e)
    }
  }
  return null
}

export class GatheringIdentityError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'GatheringIdentityError'
  }
}

/**
 * Mint the gathering's DID once and store it on the event (`events.actor_did/actor_handle`).
 * Idempotent: an event that already has an identity returns it untouched. Serialised per
 * event by a row lock, so two retries cannot mint two accounts.
 *
 * Plan §7.2 names this `mintGatheringActor` (package F). Until F's actor layer lands on
 * Postgres, this is the implementation A calls; it uses only the shared W0 identity module.
 */
export async function mintGatheringIdentity(eventId: string, callerUserId: string): Promise<{ did: string; handle: string; minted: boolean }> {
  return sql.begin(async (t) => {
    const [event] = await t<{ id: string; slug: string; name: string; actor_did: string | null; actor_handle: string | null }[]>`
      select id, slug, name, actor_did, actor_handle from events where id = ${eventId} for update
    `
    if (!event) throw new GatheringIdentityError('Event not found', 404, 'NotFound')
    if (event.actor_did) return { did: event.actor_did, handle: event.actor_handle ?? '', minted: false }

    let account: { did: string; handle: string }
    try {
      account = await mintGatheringAccount({ slug: event.slug, name: event.name, createdBy: callerUserId })
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unknown error'
      throw new GatheringIdentityError(`The gathering's network identity could not be created: ${detail}`, 502, 'IdentityMintFailed')
    }
    try {
      await t`update events set actor_did = ${account.did}, actor_handle = ${account.handle}, updated_at = now() where id = ${eventId}`
      await t`
        insert into at_audit (event_id, actor_did, caller_user_id, action, decision, reason)
        values (${eventId}, ${account.did}, ${callerUserId}, 'mint-identity', 'allow', ${`gathering identity minted for "${event.name.slice(0, 80)}"`})
      `
    } catch (e) {
      // Never leave a minted account nobody points at.
      await deleteGatheringIdentity(account.did).catch(() => {})
      throw e
    }
    return { ...account, minted: true }
  })
}

/**
 * Remove a never-published gathering's PDS account and its wrapped credential. "Account not
 * found" counts as done. Throws anything else, so the caller can keep its own rows.
 */
export async function deleteGatheringIdentity(did: string): Promise<void> {
  try {
    await deleteAccount(did)
  } catch (e) {
    const gone = e instanceof PdsError && (e.status === 400 || e.status === 404) && /not found|could not find|no account/i.test(e.message)
    if (!gone) throw e
  }
  await sql`delete from at_credentials where did = ${did}`
}
