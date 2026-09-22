import 'server-only'
/**
 * Member-scoped gathering access for the MCP server.
 *
 * The browser resolves a gathering through `loadEventAccess(request, slug)`, which reads the
 * session cookie. An assistant has no cookie: it presents a token that resolves to an account id.
 * `gatheringFor(accountId, slug)` builds the same `EventAccess` value from that account id, so
 * every read model in `src/app/api/v1/sessions/_lib/read.ts` behaves exactly as it does for the
 * browser — same visibility, same attendee-detail tiers, same organizer extras.
 *
 * One deliberate narrowing: an assistant sees ONLY gatherings the account is an appointed member
 * of. A public gathering the member has never joined is "not found" here, even though the website
 * would show it to them (and to anyone). Assistants are for your own gatherings; the public
 * schedule is already on the open web.
 */
import { sql } from '@/lib/db'
import type { EventRoleName } from '@/types/event'
import type { Viewer } from '@/lib/auth/viewer'
import { ORGANIZER_ROLES, type AccessEvent, type EventAccess } from '@/app/api/v1/sessions/_lib/access'
import { readTier, type ReadTier } from '@/lib/knowledge/store'

export interface GatheringContext {
  access: EventAccess
  role: EventRoleName
  /** The transcript reading tier for this role: 'organizers' or 'members'. Never null. */
  tier: ReadTier
  isOrganizer: boolean
  /** The gathering's default transcript tier (`events.transcripts_visibility`). */
  transcriptsVisibility: 'members' | 'organizers'
  transcriptsEnabled: boolean
}

export interface MyGathering {
  slug: string
  name: string
  role: EventRoleName
  status: string
  visibility: string
  timezone: string
  start_date: string
  end_date: string
}

/** Every gathering the account is an appointed member of, soonest first. */
export async function myGatherings(accountId: string): Promise<MyGathering[]> {
  return sql<MyGathering[]>`
    select e.slug, e.name, m.role, e.status, e.visibility, e.timezone,
           e.start_date::text as start_date, e.end_date::text as end_date
    from event_members m join events e on e.id = m.event_id
    where m.user_id = ${accountId}
    order by e.start_date desc, e.name asc
  `
}

/**
 * Resolve `slug` for the account, or null when there is no such gathering, the account is not a
 * member of it, or it is a draft the account may not see (mirroring `can_read_event`).
 */
export async function gatheringFor(accountId: string, slug: string): Promise<GatheringContext | null> {
  const rows = await sql<(AccessEvent & {
    transcripts_visibility: 'members' | 'organizers'
    transcripts_enabled: boolean
    role: EventRoleName | null
  })[]>`
    select e.id, e.slug, e.name, e.status, e.visibility, e.timezone, e.location_name, e.location_address,
           e.require_proposal_approval, e.gathering_uri, e.actor_did,
           e.transcripts_visibility, e.transcripts_enabled,
           (select role from event_members m where m.event_id = e.id and m.user_id = ${accountId}) as role
    from events e where e.slug = ${slug}
  `
  const row = rows[0]
  if (!row) return null
  const role = row.role
  if (!role) return null
  if (row.status === 'draft' && role !== 'owner' && role !== 'admin') return null

  const accounts = await sql<{ id: string; did: string; handle: string | null; email: string | null; kind: 'custodial' | 'oauth' }[]>`
    select id, did, handle, email, kind from accounts where id = ${accountId}
  `
  const account = accounts[0]
  if (!account) return null
  // The read models use `viewer.accountId` only; the rest is filled in for shape, and `sessionId`
  // is empty on purpose — a token is not a session and must never be mistaken for one.
  const viewer: Viewer = {
    accountId: account.id,
    did: account.did,
    handle: account.handle,
    email: account.email,
    kind: account.kind,
    sessionId: '',
  }
  const {
    transcripts_visibility: transcriptsVisibility,
    transcripts_enabled: transcriptsEnabled,
    role: _role,
    ...event
  } = row
  const isOrganizer = ORGANIZER_ROLES.includes(role)
  return {
    access: { event: event as AccessEvent, viewer, role, isOrganizer },
    role,
    tier: readTier(role)!,
    isOrganizer,
    transcriptsVisibility,
    transcriptsEnabled,
  }
}
