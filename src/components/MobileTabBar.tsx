'use client'

/**
 * The floating utility bar at the bottom of every page inside a gathering, on phones only
 * (design §1, §2.2).
 *
 * Four destinations and a way to everything else: Home, Sessions, Schedule, Map, More. It is
 * inset from three edges rather than full-bleed, sits on `--surface-1` with a pill radius, and
 * keeps clear of the home indicator. Labels are always visible — an icon alone cannot say
 * "My votes" or "People", and the same is true of "Schedule" next to "Map".
 *
 * Schedule is one tab: `/schedule` and `/my-schedule` are two views of the same thing
 * (design §4), so both light it up.
 */

import * as React from 'react'
import Link from 'next/link'
import { Calendar, MapPin, MoreHorizontal, Presentation, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MobileTabBarProps {
  eventSlug: string
  /** The current pathname, so the bar and the shell agree on what is active. */
  pathname: string | null
  /** Opens the More sheet. */
  onMore: () => void
  /** Whether the More sheet is open, for the button's own state. */
  moreOpen?: boolean
}

export function MobileTabBar({ eventSlug, pathname, onMore, moreOpen = false }: MobileTabBarProps) {
  const base = `/e/${eventSlug}`
  const at = (...paths: string[]) => paths.some((p) => pathname === p || pathname?.startsWith(`${p}/`))

  const tabs = [
    { href: `${base}/dashboard`, label: 'Home', icon: BarChart3, active: at(`${base}/dashboard`) },
    { href: `${base}/sessions`, label: 'Sessions', icon: Presentation, active: at(`${base}/sessions`) },
    // One tab, two views (design §4): the program and the viewer's own saved sessions.
    { href: `${base}/schedule`, label: 'Schedule', icon: Calendar, active: at(`${base}/schedule`, `${base}/my-schedule`) },
    { href: `${base}/map`, label: 'Map', icon: MapPin, active: at(`${base}/map`) },
  ]

  const itemClass =
    'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[11px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <nav
      aria-label="Gathering"
      data-testid="mobile-tab-bar"
      className="mobile-bar fixed z-40 flex items-stretch gap-0.5 rounded-full border border-border bg-surface-1 px-1.5 shadow-[0_6px_24px_hsl(var(--foreground)/.12)] md:hidden"
      style={{ height: 'var(--mobile-bar-h)' }}
    >
      {tabs.map(({ href, label, icon: Icon, active }) => (
        <Link
          key={href}
          href={href}
          aria-current={active ? 'page' : undefined}
          className={cn(itemClass, active ? 'font-semibold text-primary' : 'text-muted-foreground')}
        >
          <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
      <button
        type="button"
        onClick={onMore}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        className={cn(itemClass, moreOpen ? 'font-semibold text-primary' : 'text-muted-foreground')}
      >
        <MoreHorizontal className="h-5 w-5" strokeWidth={moreOpen ? 2 : 1.5} aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  )
}
