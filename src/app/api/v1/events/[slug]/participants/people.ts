import 'server-only'
/**
 * The members-only projection of a person (spec §8, §10), shared by the gathering directory
 * (`GET /api/v1/events/[slug]/participants`), one member in one gathering
 * (`GET /api/v1/events/[slug]/participants/[did]`) and `GET /api/v1/members/[did]`.
 *
 * Never included: account password material, vote data, tickets, `publish_proposals`, or an ENS
 * name that is unverified or that its holder has not chosen to show.
 *
 * Two fields are the member's own per-gathering choice (design §3.3, migration 0038):
 *   - `telegram` (the messaging handle) only where `event_members.share_contact` is true — on by
 *     default, which is the tier the handle already had;
 *   - `email` only where `event_members.share_email` is true — OFF by default. The `main`
 *     behaviour (email always visible to fellow members) is not restored.
 * Both reach only fellow members of the gathering the switch belongs to (callers enforce that),
 * and neither ever reaches a record: nothing in `src/lib/atproto/publish.ts` reads this module.
 *
 * The gates apply to the viewer's own card too. A person looking at their own card is looking at
 * what fellow members see, and the profile page says exactly that — showing them an address they
 * have not shared would be a lie about their own settings.
 */
import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

export interface MemberCard {
  /** accounts.id — stable within this app, used for `?highlight=` links. */
  id: string
  did: string
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  affiliation: string | null
  bio: string | null
  building: string | null
  interests: string[] | null
  /** "What I'm looking for" (release design §6); members-only like everything here. */
  looking_for: string | null
  /** The messaging handle, and only where the person shares it in this gathering. */
  telegram: string | null
  /** Present only where the person shares it in THIS gathering (`share_email`); off by default. */
  email: string | null
  /** Present only when verified and opted in (`show_ens`). */
  ens: string | null
  /**
   * Whether this person can be looked up on Bluesky: an account that signed in with its own
   * ATProto identity, or a custodial account that opted into publishing a profile record
   * (design §3.5). False for a custodial account that published nothing — the glyph would link
   * to an empty page, and the opt-in is theirs to make.
   */
  bluesky: boolean
}

export interface Participant extends MemberCard {
  role: string
  is_self: boolean
  /** When they joined this gathering — the "Recently joined" sort. */
  joined_at: string | null
}

/**
 * A piece of SQL interpolated into another tagged template. postgres.js types a fragment as the
 * pending query its own tag returns, parameterised by the row type it would produce — irrelevant
 * for a fragment, so this widens it to whatever the caller's `sql\`…\`` produced.
 */
export type SqlFragment = ReturnType<typeof sql<any>>

/**
 * Column fragment for `accounts a join profiles p`, with the two sharing gates applied.
 *
 * The gates are SQL, not booleans, so the directory can read `m.share_contact` from the
 * `event_members` row it is already joined to, while `GET /api/v1/members/[did]` — which spans
 * every gathering the two people share — can ask "in any of them" without a second query.
 *
 * There is no exception for the viewer's own card: a person looking at themselves is looking at
 * what fellow members see, and both call sites pass the same gate for every row.
 */
export function memberCardColumns(shareContact: SqlFragment, shareEmail: SqlFragment) {
  return sql`
    a.id, a.did, a.handle,
    p.display_name, p.avatar_url, p.affiliation, p.bio, p.building, p.interests, p.looking_for,
    case when ${shareContact} then p.telegram end as telegram,
    case when ${shareEmail} then a.email end as email,
    case when p.show_ens and p.ens_verified_at is not null then p.ens end as ens,
    (a.kind = 'oauth' or coalesce(p.publish_profile, false)) as bluesky
  `
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

/** did:plc and did:web only — the methods this AppView resolves. */
export function isDid(value: string): boolean {
  return /^did:plc:[a-z2-7]{24}$/.test(value) || /^did:web:[a-zA-Z0-9.%-]+(?::[a-zA-Z0-9._%-]+)*$/.test(value)
}

/**
 * Next decodes the `[did]` segment already; a client that double-encoded `did%3Aplc%3A…` still
 * resolves. Returns the raw value unchanged when it cannot be decoded.
 */
export function decodeDidParam(raw: string): string {
  try {
    return /^did%3a/i.test(raw) ? decodeURIComponent(raw) : raw
  } catch {
    return raw
  }
}
