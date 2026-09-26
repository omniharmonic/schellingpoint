'use client'

import Link from 'next/link'
import * as React from 'react'
import { ArrowLeft, ArrowRight, CalendarDays } from 'lucide-react'
import { useEvent } from '@/contexts/EventContext'
import { formatCalendarDate } from '@/lib/events/dates'

export interface WorkspaceBack {
  href: string
  label: string
}

/**
 * The context row under the workspace shells.
 *
 * On a phone it is one 44px line and nothing more (design §2.3): where back goes on the left —
 * "← Sessions" on a session page, otherwise just the name of the page you are on — and
 * "Gathering page →" on the right. It used to take two rows to say that.
 *
 * On desktop it is unchanged: the "{gathering} / {page}" breadcrumb, the date, and the same
 * gathering link, at the `--workspace-header-h` height the sticky offsets are measured against.
 *
 * `right` is a slot beside the gathering link for page-level actions that belong in the row
 * rather than in the content (the session page's save and share, design §5.1).
 */
export function WorkspaceHeader({
  label,
  back,
  right,
}: {
  label: string
  /** A back link shown instead of the page title on mobile. */
  back?: WorkspaceBack | null
  right?: React.ReactNode
}) {
  const event = useEvent()
  return (
    <div
      data-testid="workspace-context"
      className="flex h-11 md:h-[76px] items-center justify-between gap-2 border-b px-4 md:px-8 lg:px-10 bg-card/70"
    >
      {back ? (
        <Link
          href={back.href}
          className="-ml-2 inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium hover:text-primary md:hidden"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{back.label}</span>
        </Link>
      ) : (
        <span className="min-w-0 truncate text-sm font-medium md:hidden" aria-current="page">
          {label}
        </span>
      )}
      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-2 text-sm md:flex">
        <span className="truncate max-w-[240px] text-muted-foreground">{event.name}</span>
        <span className="text-border" aria-hidden="true">/</span>
        <span className="truncate font-medium" aria-current="page">{label}</span>
      </nav>
      <div className="flex shrink-0 items-center gap-1 md:gap-6">
        {right}
        <span className="hidden xl:flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {formatCalendarDate(event.startDate, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <Link
          href={`/e/${event.slug}`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm hover:text-primary md:min-h-0 md:px-0"
        >
          Gathering page <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}
