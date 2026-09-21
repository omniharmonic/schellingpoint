import 'server-only'
/**
 * The members-only projection of a person (spec §8, §10), shared by the gathering directory
 * (`GET /api/v1/events/[slug]/participants`) and `GET /api/v1/members/[did]`.
 *
 * Never included: email, account password material, vote data, tickets, `publish_proposals`,
 * or an ENS name that is unverified or that its holder has not chosen to show. Telegram is
 * included because every reader of this projection is a fellow member (callers enforce that).
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
  telegram: string | null
  /** Present only when verified and opted in (`show_ens`). */
  ens: string | null
}

export interface Participant extends MemberCard {
  role: string
  is_self: boolean
}

/** Column fragment for `accounts a join profiles p`. Kept in one place so both routes agree. */
export function memberCardColumns() {
  return sql`
    a.id, a.did, a.handle,
    p.display_name, p.avatar_url, p.affiliation, p.bio, p.building, p.interests, p.looking_for, p.telegram,
    case when p.show_ens and p.ens_verified_at is not null then p.ens end as ens
  `
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

/** did:plc and did:web only — the methods this AppView resolves. */
export function isDid(value: string): boolean {
  return /^did:plc:[a-z2-7]{24}$/.test(value) || /^did:web:[a-zA-Z0-9.%-]+(?::[a-zA-Z0-9._%-]+)*$/.test(value)
}
