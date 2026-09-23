import 'server-only'
/**
 * "Delete my account" (MT §12.6, spec §9).
 *
 * What is deleted, what is anonymised, and what is deliberately left alone:
 *
 *   deleted     profile, memberships, RSVPs, favourites, notifications and their preferences,
 *               time preferences, credit-ledger rows, role claims, sessions (browser), magic
 *               links, assistant tokens, calendar feeds, free tickets. The `accounts` row goes
 *               last and takes all of it with it by foreign key.
 *   anonymised  paid tickets and checkout references keep their amount, fee and currency and
 *               lose their holder (spec §9: "payment identifiers reduced at archival"; the
 *               gathering's books must not change because someone exercised a right).
 *               Moderation reports they filed keep the case and lose the reporter.
 *   kept        their proposals. A proposal is the proposer's own record in their own repo and
 *               the gathering has no authority over it (spec §8); the app-side row survives
 *               with no host, marked `author_left_at`, so the schedule does not develop holes.
 *   untouchable ballot entries. After close they are tokens with no author — there is nothing
 *               left to delete, and deleting "their" votes would mean re-linking them first.
 *
 * On the network side:
 *   custodial, still in custody  the PDS account is DEACTIVATED with the person's own
 *                                credential — never deleted. PLC history is permanent by
 *                                design; see `deactivateAccountAs` for why that is the honest
 *                                outcome rather than a worse one dressed up as deletion.
 *   custodial, owned             we no longer hold the password. Nothing we can do on the PDS;
 *                                the person deactivates or migrates it themselves.
 *   oauth                        only the app-side linkage goes. Their account was never ours.
 *
 * Refused while they are the last owner of a gathering that is still running: a gathering with
 * no owner cannot be administered, and the fix is to hand it over, not to orphan it.
 */
import { sql, tx, type Sql } from '@/lib/db'
import { custodialPassword } from '@/lib/auth/custody'
import { deactivateAccountAs } from '@/lib/auth/pds'

export type PdsOutcome = 'deactivated' | 'not-ours' | 'owned-by-you' | 'failed' | 'none'

export interface DeleteBlockedByOwnership {
  ok: false
  reason: 'last-owner'
  gatherings: Array<{ slug: string; name: string }>
}

export interface DeleteDone {
  ok: true
  /** Counts only, never identifiers. */
  removed: { memberships: number; rsvps: number; favorites: number; notifications: number; freeTickets: number }
  anonymised: { paidTickets: number; checkoutReferences: number; reports: number; proposals: number; auditRows: number }
  pds: PdsOutcome
  did: string
}

export type DeleteResult = DeleteDone | DeleteBlockedByOwnership

/**
 * Gatherings this account is the only owner of, and which are not archived — the read used by
 * the preview (`GET /api/me/delete`). The delete path repeats this check under a row lock; this
 * one is advisory and deliberately lock-free, because a preview must not block anybody.
 */
export async function blockingOwnerships(accountId: string): Promise<Array<{ slug: string; name: string }>> {
  return sql<{ slug: string; name: string }[]>`
    select e.slug, e.name
    from event_members m
    join events e on e.id = m.event_id
    where m.user_id = ${accountId} and m.role = 'owner' and e.status <> 'archived'
      and (select count(*) from event_members o where o.event_id = m.event_id and o.role = 'owner') = 1
    order by e.name
  `
}

/**
 * The same check, inside the caller's transaction, with every relevant owner row locked.
 *
 * Without the lock two co-owners of the same gathering can delete their accounts at the same
 * instant: each reads two owners, each passes, and the gathering ends up with none. Locking
 * every owner row of every gathering this account owns serialises that pair, exactly as
 * `leaveGatheringIn` does for one gathering.
 */
async function blockingOwnershipsLocked(t: Sql, accountId: string): Promise<Array<{ slug: string; name: string }>> {
  const owners = await t<{ event_id: string; user_id: string; slug: string; name: string; status: string }[]>`
    select m.event_id, m.user_id, e.slug, e.name, e.status
    from event_members m
    join events e on e.id = m.event_id
    where m.role = 'owner'
      and m.event_id in (select event_id from event_members where user_id = ${accountId} and role = 'owner')
    order by m.event_id, m.user_id
    for update of m
  `
  const byEvent = new Map<string, { slug: string; name: string; status: string; owners: string[] }>()
  for (const row of owners) {
    const entry = byEvent.get(row.event_id) ?? { slug: row.slug, name: row.name, status: row.status, owners: [] }
    entry.owners.push(row.user_id)
    byEvent.set(row.event_id, entry)
  }
  return [...byEvent.values()]
    .filter((e) => e.status !== 'archived' && e.owners.length === 1 && e.owners[0] === accountId)
    .map((e) => ({ slug: e.slug, name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Delete `accountId`. The ownership check and every row change happen in one transaction, with
 * the owner rows locked; the PDS deactivation runs afterwards and its failure is reported, not
 * thrown — an account the person asked to delete must not be left half-deleted because a remote
 * host was down.
 */
export async function deleteAccount(accountId: string): Promise<DeleteResult> {
  const [account] = await sql<{ did: string; handle: string | null; kind: string; owned_at: string | null }[]>`
    select did, handle, kind, owned_at from accounts where id = ${accountId}
  `
  if (!account) return { ok: false, reason: 'last-owner', gatherings: [] }

  // The password has to be read before the row is gone; it never leaves this function.
  const password = account.kind === 'custodial' && !account.owned_at ? await custodialPassword(accountId) : null

  type Committed =
    | { blocked: Array<{ slug: string; name: string }> }
    | { blocked?: undefined; removed: DeleteDone['removed']; anonymised: DeleteDone['anonymised'] }

  const result = await tx<Committed>(async (t) => {
    const blocking = await blockingOwnershipsLocked(t, accountId)
    if (blocking.length) return { blocked: blocking }

    // Money facts keep no holder. A paid ticket stays as an amount; a free one has no fact to
    // keep, so it goes and its seat goes back to the room.
    const paidTickets = await t`
      update tickets set user_id = null
      where user_id = ${accountId}
        and (payment_intent_id is not null or coalesce(amount_paid_cents, 0) > 0 or coalesce(quoted_price_cents, 0) > 0)
    `
    const freeTickets = await t`delete from tickets where user_id = ${accountId}`
    const checkoutReferences = await t`
      update checkout_references set holder_account_id = null where holder_account_id = ${accountId}
    `
    const reports = await t`
      update moderation_reports set reporter_account_id = null where reporter_account_id = ${accountId}
    `
    // Proposals survive their author. Mark them so organizers see nobody is answering.
    const proposals = await t`
      update sessions set author_left_at = coalesce(author_left_at, now())
      where host_id = ${accountId}
    `
    const memberships = await t`select 1 from event_members where user_id = ${accountId}`
    const rsvps = await t`select 1 from session_rsvps where user_id = ${accountId}`
    const favorites = await t`select 1 from favorites where user_id = ${accountId}`
    const notifications = await t`select 1 from notifications where user_id = ${accountId}`

    // Explicit before the cascade, so the intent is legible and so a future FK change cannot
    // silently leave a live credential behind.
    await t`update assistant_tokens set revoked_at = now() where account_id = ${accountId} and revoked_at is null`
    await t`update calendar_feed_tokens set revoked_at = now() where account_id = ${accountId} and revoked_at is null`
    await t`delete from at_sessions where user_id = ${accountId}`
    await t`delete from auth_email_tokens where account_id = ${accountId}`

    // Credentials: THIS PERSON'S OWN, and nothing else.
    //
    // `at_credentials` is keyed by the DID it belongs to; `created_by` is merely the organizer
    // who connected it. Deleting by `created_by` would take every gathering credential this
    // person ever set up with them — a founder deleting their account would silently stop four
    // gatherings publishing. Their own rows are the ones whose subject is their DID: the repo
    // credential itself, and any pending take-ownership reveal, which carries the DID in
    // `identifier`. Everything else only forgets who connected it.
    await t`delete from at_credentials where did = ${account.did} or identifier = ${account.did}`
    await t`update at_credentials set created_by = null where created_by = ${accountId}`

    // The audit trail is kept (spec §9: "audit retained"); the caller is forgotten.
    const audit = await t`update at_audit set caller_user_id = null where caller_user_id = ${accountId}`
    // Geocoding is a per-account rate-limit ledger with no foreign key of its own.
    await t`delete from geocode_requests where account_id = ${accountId}`

    await t`delete from at_repo_state where did = ${account.did}`
    await t`delete from at_records where did = ${account.did}`

    // Everything else hangs off `accounts` (and `profiles`, which is keyed to it) by foreign
    // key: memberships, favourites, RSVPs, notifications, preferences, ledgers, role claims.
    // Gatherings they founded and tracks they led survive with no author (migration 0035).
    await t`delete from accounts where id = ${accountId}`

    return {
      removed: {
        memberships: memberships.count,
        rsvps: rsvps.count,
        favorites: favorites.count,
        notifications: notifications.count,
        freeTickets: freeTickets.count,
      },
      anonymised: {
        paidTickets: paidTickets.count,
        checkoutReferences: checkoutReferences.count,
        reports: reports.count,
        proposals: proposals.count,
        auditRows: audit.count,
      },
    }
  })

  if (result.blocked) return { ok: false, reason: 'last-owner', gatherings: result.blocked }

  let pds: PdsOutcome = 'none'
  if (account.kind !== 'custodial') pds = 'not-ours'
  else if (account.owned_at) pds = 'owned-by-you'
  else if (!password) pds = 'failed'
  else {
    try {
      await deactivateAccountAs(account.handle || account.did, password)
      pds = 'deactivated'
    } catch (e) {
      console.error('[account] PDS deactivation failed after deletion:', e instanceof Error ? e.name : 'error')
      pds = 'failed'
    }
  }

  console.info(`[account] account deleted (pds=${pds})`)
  return { ok: true, removed: result.removed, anonymised: result.anonymised, pds, did: account.did }
}

/** The sentence the person is shown about their network identity, after the fact. */
export const PDS_OUTCOME_SENTENCE: Record<PdsOutcome, string> = {
  deactivated:
    'Your repository on our PDS has been deactivated: it is no longer served, and the relay has been told. It was not deleted, because a DID\u2019s history in the PLC directory is permanent by design \u2014 it is public, append-only and mirrored, and destroying your copy of your records would not unpublish any of it. If you ever want the identity back, it can be reactivated or moved to another provider.',
  'owned-by-you':
    'You took ownership of your network identity, so we no longer hold its password and cannot act on it. Sign in to your PDS to deactivate or migrate it yourself. Note that a DID\u2019s history in the PLC directory is permanent by design and cannot be withdrawn by anyone.',
  'not-ours':
    'You signed in with your own ATProto account, so there was nothing on the network for us to change: only the link between it and this app has been removed. Everything you published stays in your repository, under your control.',
  failed:
    'Your data here is gone, but we could not reach the PDS to deactivate your repository. Ask an operator to deactivate it, or sign in and do it yourself.',
  none: 'No network identity was attached to this account.',
}
