import 'server-only'
/**
 * "Download my data" (MT §12.6, spec §9).
 *
 * Everything this app holds *about the account*, as one JSON document the person can read
 * without a tool. Two deliberate absences, both stated in the export itself so nobody has to
 * guess:
 *
 *   · **Ballot entries are not here, and cannot be.** At close the round's key is destroyed
 *     and each entry becomes a token with no author (spec §5.3–§5.4). There is no query that
 *     returns "this person's votes"; building one would mean keeping the link that the whole
 *     voting design exists to destroy. The same holds for post-session feedback.
 *   · **Records in the person's own repo are not copied here.** They are already theirs and
 *     already portable: `com.atproto.sync.getRepo` hands back the whole repository as a CAR
 *     file. The export points at it rather than making a second, staler copy.
 *
 * Secrets never appear: no wrapped password, no token hash, no session id. Token *metadata*
 * does, because "what is connected to my account" is a question this is meant to answer.
 */
import { sql } from '@/lib/db'

export interface AccountExport {
  exported_at: string
  format: 'unconference.account-export/1'
  about: {
    not_included: string[]
    your_repository: { did: string; pds: string | null; how: string }
  }
  account: Record<string, unknown>
  profile: Record<string, unknown> | null
  memberships: Record<string, unknown>[]
  proposals: Record<string, unknown>[]
  cohosting: Record<string, unknown>[]
  rsvps: Record<string, unknown>[]
  favorites: Record<string, unknown>[]
  tickets: Record<string, unknown>[]
  transcripts_uploaded: Record<string, unknown>[]
  session_resources_added: Record<string, unknown>[]
  notifications: Record<string, unknown>[]
  notification_preferences: Record<string, unknown>[]
  assistant_tokens: Record<string, unknown>[]
  calendar_feeds: Record<string, unknown>[]
  reports_filed: Record<string, unknown>[]
}

const NOT_INCLUDED = [
  'Your votes. When a voting round closes, its key is destroyed and every entry becomes an unlinkable token — there is no longer anything in this database that says which entries were yours, and re-creating that link is exactly what the design prevents.',
  'Your session feedback, for the same reason: it runs on the same ballot machinery and is anonymous even to organizers.',
  'The records you wrote to your own repository on the network (proposals, endorsements, public RSVPs). They are already yours; export the whole repository with com.atproto.sync.getRepo.',
  'Other people. Nothing here names another member, except where they appear in a session you host.',
]

/** Everything the app holds about `accountId`, as a plain JSON object. */
export async function buildAccountExport(accountId: string): Promise<AccountExport | null> {
  const [account] = await sql<{ id: string; did: string; handle: string | null; email: string | null; kind: string; owned_at: string | null; email_verified_at: string | null; created_at: string }[]>`
    select id, did, handle, email, kind, owned_at, email_verified_at, created_at from accounts where id = ${accountId}
  `
  if (!account) return null

  const [pds] = await sql<{ pds_url: string | null }[]>`
    select pds_url from at_credentials where identifier = ${account.did} or did = ${account.did} limit 1
  `

  const [profile] = await sql<Record<string, unknown>[]>`
    select display_name, bio, avatar_url, affiliation, building, telegram, interests, looking_for,
           ens, ens_verified_at, show_ens, onboarding_completed, publish_proposals, publish_profile,
           profile_record_uri, profile_synced_at, synced_fields, created_at
    from profiles where id = ${accountId}
  `

  const [
    memberships, proposals, cohosting, rsvps, favorites, tickets,
    transcripts, resources, notifications, preferences, tokens, feeds, reports,
  ] = await Promise.all([
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, e.name as gathering_name, m.role, m.joined_at, m.vote_credits,
             m.directory_listing, m.public_role, m.mention_in_posts, m.conduct_accepted_at
      from event_members m join events e on e.id = m.event_id
      where m.user_id = ${accountId} order by m.joined_at asc nulls last`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, s.id, s.title, s.description, s.format, s.duration, s.topic_tags,
             s.status, s.proposal_uri, s.created_at, s.updated_at, s.author_left_at, s.hidden_by_moderation
      from sessions s join events e on e.id = s.event_id
      where s.host_id = ${accountId} order by s.created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, s.id as session_id, s.title, c.added_at, c.cohost_uri
      from session_cohosts c join sessions s on s.id = c.session_id join events e on e.id = s.event_id
      where c.user_id = ${accountId} order by c.added_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, r.session_id, s.title, r.status, r.waitlist_position, r.rsvp_uri, r.created_at
      from session_rsvps r join sessions s on s.id = r.session_id join events e on e.id = r.event_id
      where r.user_id = ${accountId} order by r.created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, f.session_id, s.title, f.created_at
      from favorites f join sessions s on s.id = f.session_id join events e on e.id = f.event_id
      where f.user_id = ${accountId} order by f.created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, t.id, tt.name as tier, t.status, t.amount_paid_cents, t.paid_currency,
             t.payment_confirmed_at, t.checked_in_at, t.created_at
      from tickets t join events e on e.id = t.event_id left join ticket_tiers tt on tt.id = t.tier_id
      where t.user_id = ${accountId} order by t.created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, tr.session_id, s.title, tr.source, tr.format, tr.char_count,
             tr.language, tr.visibility, tr.status, tr.consent_confirmed_at, tr.created_at
      from session_transcripts tr join sessions s on s.id = tr.session_id join events e on e.id = tr.event_id
      where tr.uploaded_by = ${accountId} order by tr.created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, r.session_id, r.title, r.url, r.kind, r.created_at
      from session_resources r join events e on e.id = r.event_id
      where r.added_by = ${accountId} order by r.created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, n.type, n.title, n.body, n.action_url, n.created_at, n.read_at
      from notifications n left join events e on e.id = n.event_id
      where n.user_id = ${accountId} order by n.created_at desc limit 2000`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, p.category, p.email_enabled, p.in_app_enabled, p.push_enabled
      from notification_preferences p left join events e on e.id = p.event_id
      where p.user_id = ${accountId}`,
    sql<Record<string, unknown>[]>`
      select name, scopes, created_at, last_used_at, expires_at, revoked_at
      from assistant_tokens where account_id = ${accountId} order by created_at asc`,
    sql<Record<string, unknown>[]>`
      select created_at, last_used_at, revoked_at from calendar_feed_tokens where account_id = ${accountId} order by created_at asc`,
    sql<Record<string, unknown>[]>`
      select e.slug as gathering, r.subject_kind, r.reason, r.status, r.created_at, r.resolved_at
      from moderation_reports r join events e on e.id = r.event_id
      where r.reporter_account_id = ${accountId} order by r.created_at desc`,
  ])

  return {
    exported_at: new Date().toISOString(),
    format: 'unconference.account-export/1',
    about: {
      not_included: NOT_INCLUDED,
      your_repository: {
        did: account.did,
        pds: pds?.pds_url ?? null,
        how: `GET <your PDS>/xrpc/com.atproto.sync.getRepo?did=${account.did} returns your whole repository as a CAR file.`,
      },
    },
    account: {
      did: account.did,
      handle: account.handle,
      email: account.email,
      kind: account.kind,
      custodial: account.kind === 'custodial' && !account.owned_at,
      owned_at: account.owned_at,
      email_verified_at: account.email_verified_at,
      created_at: account.created_at,
    },
    profile: profile ?? null,
    memberships,
    proposals,
    cohosting,
    rsvps,
    favorites,
    tickets,
    transcripts_uploaded: transcripts,
    session_resources_added: resources,
    notifications,
    notification_preferences: preferences,
    assistant_tokens: tokens,
    calendar_feeds: feeds,
    reports_filed: reports,
  }
}
