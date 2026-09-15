import 'server-only'
/**
 * Account and identity state of the repos we index (`at_repo_status`, migration 0011).
 *
 * ACCOUNT STATUS (relay `#account` frames, PDS `getRepoStatus`)
 *   A repo is HIDDEN when it is not active for a reason that makes its content unavailable:
 *   `takendown`, `suspended`, `deactivated`, `deleted`, `not-found`, or no/unknown reason.
 *   `desynchronized` / `throttled` are relay-side sync states — recorded, never hidden (the generated
 *   `at_repo_status.hidden` column encodes this once, for every query).
 *   While hidden:
 *     - its `at_records` rows are filtered out of every read that serves them (`visibleRepoSql`)
 *     - sessions it proposed/hosts get `author_inactive_at` (hidden from the organiser queue and
 *       public reads; the published schedule shows no `host`), its co-host pairings
 *       `cohost_inactive_at` — app rows are flagged, never deleted
 *     - organisers of affected approved/scheduled sessions get `proposal_changed` once
 *   `deleted` additionally purges its index rows as withdrawals (`ingest.ts` does that).
 *   Becoming active clears the flags; `ingest.ts` then reconciles the repo.
 *
 *   Precedence: OUR PDS is authoritative for the repos it hosts. For a foreign repo the relay's
 *   moderation (`takendown`, `suspended`) stands until the relay reports the repo active again —
 *   a PDS saying "active" does not lift a relay takedown; any other relay-reported status is
 *   superseded by what the repo's own PDS says.
 *
 * IDENTITY (relay `#identity` frames)
 *   Every cache holding the DID is evicted, the handle is re-verified BOTH ways (DID document
 *   claims it → it resolves back to the DID) and stored on `at_repo_status.handle`,
 *   `accounts.handle`, `profiles.atproto_handle` and `events.actor_handle` for that DID. An
 *   unverified handle is stored as NULL — display falls back to the DID.
 */
import { sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { evictGatheringActor } from './actors'
import { forgetIdentity, verifyHandleForDid, type HandleVerifier } from './identity'
import { skillsAuthorityDid } from './skills'
import { forgetPdsAgent } from './write'

export type StatusSource = 'relay' | 'pds'

/** Relay-level moderation a PDS's "active" does not lift. */
const RELAY_MODERATION = new Set(['takendown', 'suspended'])
const NON_HIDING = new Set(['desynchronized', 'throttled'])

export function hidesRepo(active: boolean, status: string | null | undefined): boolean {
  return !active && !NON_HIDING.has(status ?? '')
}

/** `and <col> is not from a hidden repo` — for every read that serves `at_records` rows. */
export function visibleRepoSql(didColumn: string) {
  return sql`not exists (select 1 from at_repo_status rs_hidden where rs_hidden.did = ${sql(didColumn)} and rs_hidden.hidden)`
}

export interface RepoStatusRow {
  did: string
  active: boolean
  status: string | null
  status_source: StatusSource
  handle: string | null
  hidden: boolean
}

export async function repoStatus(did: string): Promise<RepoStatusRow | null> {
  const [row] = await sql<RepoStatusRow[]>`select did, active, status, status_source, handle, hidden from at_repo_status where did = ${did}`
  return row ?? null
}

/** Is this a repo we follow or hold anything from? Frames about anyone else are ignored. */
export async function isTrackedDid(did: string): Promise<boolean> {
  if (!did.startsWith('did:')) return false
  if (did === skillsAuthorityDid()) return true
  const [hit] = await sql<{ yes: boolean }[]>`
    select exists (select 1 from accounts where did = ${did})
        or exists (select 1 from events where actor_did = ${did})
        or exists (select 1 from peers where peer_did = ${did})
        or exists (select 1 from at_repo_status where did = ${did})
        or exists (select 1 from sessions where host_did = ${did})
        or exists (select 1 from at_records where did = ${did})
      as yes
  `
  return hit?.yes === true
}

export interface ApplyStatusInput {
  did: string
  active: boolean
  status?: string | null
  source: StatusSource
  /** True when the reporting PDS is OUR PDS: authoritative, overrides any relay-reported status. */
  authoritative?: boolean
}

export interface ApplyStatusResult {
  did: string
  hidden: boolean
  changed: 'hidden' | 'restored' | 'unchanged' | 'kept-relay-moderation'
  sessionsFlagged: number
  sessionsRestored: number
  organisersNotified: number
}

/**
 * Record a status report and apply its visibility effects (idempotent). Returns what changed.
 * Does not purge index rows for `deleted` and does not reconcile — `ingest.ts` orchestrates those.
 */
export async function applyRepoStatus(input: ApplyStatusInput): Promise<ApplyStatusResult> {
  const status = input.active ? null : (input.status ?? null)
  const current = await repoStatus(input.did)
  const out: ApplyStatusResult = { did: input.did, hidden: hidesRepo(input.active, status), changed: 'unchanged', sessionsFlagged: 0, sessionsRestored: 0, organisersNotified: 0 }

  // A PDS saying "active" does not lift a relay takedown/suspension of a foreign repo.
  if (input.source === 'pds' && !input.authoritative && input.active && current?.hidden && current.status_source === 'relay' && RELAY_MODERATION.has(current.status ?? '')) {
    out.hidden = true
    out.changed = 'kept-relay-moderation'
    return out
  }

  await sql`
    insert into at_repo_status (did, active, status, status_source, updated_at)
    values (${input.did}, ${input.active}, ${status}, ${input.source}, now())
    on conflict (did) do update set active = excluded.active, status = excluded.status, status_source = excluded.status_source, updated_at = now()
  `
  const wasHidden = current?.hidden === true
  if (out.hidden) {
    const flagged = await flagRepoInactive(input.did, status)
    out.sessionsFlagged = flagged.sessions
    out.organisersNotified = flagged.notified
    out.changed = wasHidden && flagged.sessions === 0 ? 'unchanged' : 'hidden'
  } else {
    out.sessionsRestored = await clearRepoInactive(input.did)
    out.changed = wasHidden || out.sessionsRestored > 0 ? 'restored' : 'unchanged'
  }
  return out
}

interface FlaggedRow {
  id: string
  event_id: string
  title: string
  status: string | null
  slot_uri: string | null
  slug: string
}

/** Flag the repo's sessions and co-host pairings; notify organisers of affected approved/scheduled sessions. */
async function flagRepoInactive(did: string, status: string | null): Promise<{ sessions: number; notified: number }> {
  return sql.begin(async (t) => {
    const flagged = await t<FlaggedRow[]>`
      update sessions s set author_inactive_at = now()
      from events e
      where e.id = s.event_id and s.author_inactive_at is null
        and (s.host_did = ${did}
             or starts_with(s.proposal_uri, ${`at://${did}/`})
             or s.host_id in (select id from accounts where did = ${did}))
      returning s.id, s.event_id, s.title, s.status, s.slot_uri, e.slug
    `
    await t`
      update session_cohosts set cohost_inactive_at = now()
      where cohost_inactive_at is null and user_id in (select id from accounts where did = ${did})
    `
    let notified = 0
    const affected = flagged.filter((s) => s.slot_uri || s.status === 'scheduled' || s.status === 'approved')
    const byEvent = new Map<string, FlaggedRow[]>()
    for (const s of affected) byEvent.set(s.event_id, [...(byEvent.get(s.event_id) ?? []), s])
    for (const [eventId, rows] of byEvent) {
      const organisers = await t<{ user_id: string }[]>`
        select user_id from event_members where event_id = ${eventId} and role in ('owner', 'admin')
      `
      if (!organisers.length) continue
      for (const s of rows) {
        try {
          await t.savepoint((sp) =>
            notify(sp, {
              eventId,
              userIds: organisers.map((o) => o.user_id),
              type: 'proposal_changed',
              title: `The proposer of “${s.title.slice(0, 120)}” is no longer active on the network`,
              body: 'Their account was taken down, suspended, deactivated or deleted, so their records are hidden. The schedule was not changed: cancel the session or give its slot to another proposal.',
              actionUrl: `/e/${s.slug}/admin/atproto#drift`,
              data: { sessionId: s.id, kind: 'author-inactive', status },
            }),
          )
          notified++
        } catch {
          // a notification failure never blocks hiding the records
        }
      }
    }
    return { sessions: flagged.length, notified }
  })
}

async function clearRepoInactive(did: string): Promise<number> {
  return sql.begin(async (t) => {
    const restored = await t<{ id: string }[]>`
      update sessions set author_inactive_at = null
      where author_inactive_at is not null
        and (host_did = ${did} or starts_with(proposal_uri, ${`at://${did}/`}) or host_id in (select id from accounts where did = ${did}))
      returning id
    `
    await t`
      update session_cohosts set cohost_inactive_at = null
      where cohost_inactive_at is not null and user_id in (select id from accounts where did = ${did})
    `
    return restored.length
  })
}

/* ───────────────────────────── identity ───────────────────────────── */

export interface IdentityChangeResult {
  did: string
  handle: string | null
  state: 'verified' | 'invalid' | 'unresolvable'
  updated: { accounts: number; profiles: number; events: number }
}

/** Every in-process cache that holds this DID. */
export async function evictDidCaches(did: string): Promise<void> {
  await forgetIdentity(did)
  forgetPdsAgent(did)
  const events = await sql<{ id: string }[]>`select id from events where actor_did = ${did}`
  for (const e of events) evictGatheringActor(e.id)
}

/**
 * A relay `#identity` event: evict, re-resolve, verify the handle both ways, store it (NULL when
 * invalid). An unreadable DID document leaves stored handles alone (a PLC outage must not blank
 * everyone's name); the next event or reconcile tries again.
 */
export async function applyIdentityChange(did: string, verifier?: HandleVerifier): Promise<IdentityChangeResult> {
  await evictDidCaches(did)
  const verified = await verifyHandleForDid(did, verifier)
  const out: IdentityChangeResult = { did, handle: null, state: verified.state, updated: { accounts: 0, profiles: 0, events: 0 } }
  if (verified.state === 'unresolvable') return out
  const handle = verified.state === 'verified' ? verified.handle : null
  out.handle = handle
  await sql.begin(async (t) => {
    await t`
      insert into at_repo_status (did, active, handle, handle_verified_at, updated_at)
      values (${did}, true, ${handle}, ${handle ? new Date() : null}, now())
      on conflict (did) do update set handle = excluded.handle, handle_verified_at = excluded.handle_verified_at, updated_at = now()
    `
    const a = await t`update accounts set handle = ${handle} where did = ${did} and handle is distinct from ${handle} returning id`
    const p = await t`
      update profiles set atproto_handle = ${handle}
      where id in (select id from accounts where did = ${did}) and atproto_handle is distinct from ${handle}
      returning id
    `
    const e = await t`update events set actor_handle = ${handle} where actor_did = ${did} and actor_handle is distinct from ${handle} returning id`
    out.updated = { accounts: a.length, profiles: p.length, events: e.length }
  })
  return out
}

