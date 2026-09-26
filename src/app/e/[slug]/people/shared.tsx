'use client'

/**
 * The pieces the People directory and the profile page at `/e/[slug]/people/[did]` share
 * (design §3): the member card shape both read, how a person is named, the avatar, the Bluesky
 * glyph, and the links between the two pages.
 *
 * Nothing here fetches: both pages own their own loading, so the rules about who may see what
 * stay with the routes (`participants/people.ts`).
 */

import * as React from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { ORGANIZER_ROLES } from '@/lib/labels'

/** Shape of a member card from GET /api/v1/events/[slug]/participants (and …/participants/[did]). */
export interface MemberCardData {
  id: string
  did: string
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  affiliation: string | null
  bio: string | null
  building: string | null
  interests: string[] | null
  /** "What I'm looking for" (release design §6). */
  looking_for?: string | null
  /** The messaging handle, present only where they share it in this gathering. */
  telegram: string | null
  /** Present only where they turned on email sharing for this gathering (design §3.3). */
  email?: string | null
  ens: string | null
  /** Whether they can be looked up on Bluesky (OAuth account, or a published profile record). */
  bluesky?: boolean
  role: string
  is_self: boolean
  /** When they joined this gathering. */
  joined_at?: string | null
}

/** Display name → @handle → "Member" (release design §5.3). */
export function nameOf(p: Pick<MemberCardData, 'display_name' | 'handle'>): string {
  return p.display_name?.trim() || (p.handle ? `@${p.handle}` : 'Member')
}

/** Avatar fallback: first letter of the name, else of the handle, else "M". */
export function initialOf(p: Pick<MemberCardData, 'display_name' | 'handle'>): string {
  return (p.display_name?.trim() || p.handle || 'Member').replace(/^@/, '').charAt(0).toUpperCase() || 'M'
}

/** This gathering's profile page for a person. Members-only, like every gathering page. */
export function profileHref(slug: string, did: string): string {
  return `/e/${encodeURIComponent(slug)}/people/${encodeURIComponent(did)}`
}

/** The People page, optionally filtered to one interest (design §3.1: interests are links). */
export function peopleHref(slug: string, opts: { interest?: string; sort?: string } = {}): string {
  const params = new URLSearchParams()
  if (opts.interest) params.set('interest', opts.interest)
  if (opts.sort) params.set('sort', opts.sort)
  const query = params.toString()
  return `/e/${encodeURIComponent(slug)}/participants${query ? `?${query}` : ''}`
}

/**
 * Where a person can be looked up on the network, for people who can be: an account that signed
 * in with its own ATProto identity, or a custodial account that opted into publishing a profile
 * record. `null` otherwise — a glyph pointing at an empty page is worse than no glyph, and
 * publishing is theirs to decide (design §3.5).
 */
export function blueskyHref(p: Pick<MemberCardData, 'did' | 'bluesky'>): string | null {
  return p.bluesky ? `https://bsky.app/profile/${encodeURIComponent(p.did)}` : null
}

/**
 * The messaging handle is free text (Telegram, Signal, Matrix…). It becomes a link only when it
 * parses as a Telegram username or an http(s) URL; otherwise it is shown as plain text.
 */
export function messagingLink(value: string): { href: string | null; label: string } {
  const trimmed = value.trim()
  const telegram = /^@?([A-Za-z0-9_]{5,32})$/.exec(trimmed)
  if (telegram) return { href: `https://t.me/${encodeURIComponent(telegram[1])}`, label: `@${telegram[1]}` }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return { href: url.toString(), label: `${url.hostname}${url.pathname === '/' ? '' : url.pathname}` }
    } catch {
      return { href: null, label: trimmed }
    }
  }
  return { href: null, label: trimmed }
}

/** The butterfly, drawn inline: the icon set has no Bluesky glyph and no CDN is reachable. */
export function BlueskyGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 568 501" className={cn('h-3.5 w-3.5', className)} fill="currentColor" aria-hidden="true">
      <path d="M123.121 33.6637C188.241 82.5526 258.281 144.634 283.9 177.94C309.519 144.634 379.559 82.5526 444.679 33.6637C491.674 -1.61183 568 -28.9064 568 58.1477C568 75.5637 558.016 204.583 552.16 225.527C531.808 298.336 457.567 316.902 391.53 305.665C506.947 325.312 536.203 390.365 472.793 455.418C352.365 578.988 300.163 424.464 286.783 384.858C284.34 377.617 283.203 374.229 283.9 377.109C284.597 374.229 283.46 377.617 281.017 384.858C267.637 424.464 215.435 578.988 95.0074 455.418C31.5977 390.365 60.8534 325.312 176.271 305.665C110.233 316.902 35.9929 298.336 15.6409 225.527C9.78492 204.583 -0.199234 75.5637 -0.199234 58.1477C-0.199234 -28.9064 76.1265 -1.61183 123.121 33.6637Z" />
    </svg>
  )
}

/** A small "on Bluesky" link, used on cards and on the profile page header. */
export function BlueskyLink({ person, className }: { person: Pick<MemberCardData, 'did' | 'bluesky'>; className?: string }) {
  const href = blueskyHref(person)
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="View on Bluesky"
      aria-label="View on Bluesky"
      className={cn('inline-flex items-center text-muted-foreground transition-colors hover:text-primary', className)}
      onClick={(e) => e.stopPropagation()}
    >
      <BlueskyGlyph />
    </a>
  )
}

export function MemberAvatar({
  person,
  size,
  className,
}: {
  person: Pick<MemberCardData, 'display_name' | 'handle' | 'avatar_url' | 'role'>
  size: 'sm' | 'lg'
  className?: string
}) {
  const [failed, setFailed] = React.useState(false)
  const dims = size === 'sm' ? 'h-12 w-12 text-lg' : 'h-20 w-20 border-2 border-border text-2xl'
  const organizer = ORGANIZER_ROLES.includes(person.role)
  return (
    <div
      className={cn('rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0', dims, className)}
      aria-hidden="true"
    >
      {person.avatar_url && !failed ? (
        <img
          src={person.avatar_url}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={cn('font-medium', organizer ? 'text-primary' : 'text-muted-foreground')}>{initialOf(person)}</span>
      )}
    </div>
  )
}

/** "View full profile" — the link that turns a name into a page (design §3.2). */
export function ViewProfileLink({
  slug,
  did,
  className,
  children = 'View profile',
}: {
  slug: string
  did: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <Link href={profileHref(slug, did)} className={cn('text-sm font-medium text-primary hover:underline', className)}>
      {children}
    </Link>
  )
}
