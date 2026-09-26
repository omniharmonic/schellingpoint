'use client'

import * as React from 'react'
import Link from 'next/link'
import { Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Event } from '@/types/event'

// Brand glyphs are used only for Bluesky and X (social links contract); everything else gets
// its label and a generic link icon.
const XIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
)

const BlueskyIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z" />
  </svg>
)

/** One displayable link, whatever key it was stored under. */
export interface FooterLink {
  label: string
  url: string
  glyph: 'bluesky' | 'x' | null
}

const MAX_LINKS = 8

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

function glyphFor(label: string, url: string): FooterLink['glyph'] {
  const key = label.trim().toLowerCase()
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    host = ''
  }
  if (key === 'bluesky' || host === 'bsky.app' || host.endsWith('.bsky.app')) return 'bluesky'
  if (key === 'x' || key === 'twitter' || host === 'x.com' || host === 'twitter.com') return 'x'
  return null
}

/**
 * Merge the legacy `theme.social.{twitter,telegram,discord,website}` keys and the repeatable
 * `theme.social.links` into one list for display (social links contract). Legacy keys first,
 * in a stable order; invalid or non-http URLs are dropped; at most eight links.
 */
type SocialInput = NonNullable<NonNullable<Event['theme']>['social']>

export function socialLinksOf(social: SocialInput | null | undefined): FooterLink[] {
  if (!social) return []
  const out: FooterLink[] = []
  const push = (label: string, url: unknown) => {
    const trimmed = label.trim()
    if (!trimmed || !isHttpUrl(url) || out.length >= MAX_LINKS) return
    if (out.some((l) => l.url === url)) return
    out.push({ label: trimmed, url, glyph: glyphFor(trimmed, url) })
  }
  push('X', social.twitter)
  push('Telegram', social.telegram)
  push('Discord', social.discord)
  push('Website', social.website)
  for (const link of social.links ?? []) {
    if (link && typeof link === 'object') push(String(link.label ?? ''), link.url)
  }
  return out
}

function SocialLinks({ links, className }: { links: FooterLink[]; className?: string }) {
  if (links.length === 0) return null
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)} aria-label="Gathering links">
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            {link.glyph === 'bluesky' ? (
              <BlueskyIcon className="h-4 w-4" />
            ) : link.glyph === 'x' ? (
              <XIcon className="h-3.5 w-3.5" />
            ) : (
              <Link2 className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            )}
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  )
}

interface FooterProps {
  className?: string
  variant?: 'default' | 'minimal'
  /** When set, the footer carries the gathering's branding: "{name} · Powered by unconference.events". */
  event?: (Pick<Event, 'name' | 'logoUrl' | 'tagline' | 'theme'> & { slug?: string }) | null
}

export function Footer({ className, variant = 'default', event }: FooterProps) {
  const isMinimal = variant === 'minimal'
  const links = socialLinksOf(event?.theme?.social)

  return (
    <footer className={cn('border-t bg-background', className)}>
      <div className={cn('container mx-auto px-5', isMinimal ? 'py-6' : 'py-10')}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {event ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {event.logoUrl && <img src={event.logoUrl} alt="" className="h-6 w-6 rounded object-contain" />}
                {event.slug ? (
                  <Link href={`/e/${event.slug}`} className="font-semibold tracking-tight hover:text-primary">{event.name}</Link>
                ) : (
                  <span className="font-semibold tracking-tight">{event.name}</span>
                )}
                <span className="whitespace-nowrap text-muted-foreground">
                  <span aria-hidden="true">· </span>
                  <Link href="/" className="hover:text-foreground">Powered by unconference.events</Link>
                </span>
              </p>
            ) : (
              <Link href="/" className="font-semibold tracking-tight">unconference</Link>
            )}
            {!isMinimal && (
              <p className="mt-1 text-sm text-muted-foreground">
                {event?.tagline || 'A little structure. A lot of possibility.'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <SocialLinks links={links} />
            <Link href="/help" className="hover:text-foreground">Help</Link>
            <Link href="/codeofconduct" className="hover:text-foreground">Code of conduct</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
