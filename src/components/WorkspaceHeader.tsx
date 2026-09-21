'use client'

import Link from 'next/link'
import { ArrowRight, CalendarDays } from 'lucide-react'
import { useEvent } from '@/contexts/EventContext'
import { formatCalendarDate } from '@/lib/events/dates'

/**
 * The breadcrumb bar under the workspace shells ("{gathering} / {page}"). Compact on phones
 * (the mobile shells show only the gathering name in their fixed bar), full height on desktop
 * where its height is the `--workspace-header-h` sticky offset.
 */
export function WorkspaceHeader({ label }: { label: string }) {
  const event = useEvent()
  return (
    <div className="flex h-12 md:h-[76px] items-center justify-between gap-4 border-b px-4 md:px-8 lg:px-10 bg-card/70">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
        <span className="hidden sm:inline truncate max-w-[240px] text-muted-foreground">{event.name}</span>
        <span className="hidden sm:inline text-border" aria-hidden="true">/</span>
        <span className="truncate font-medium" aria-current="page">{label}</span>
      </nav>
      <div className="flex shrink-0 items-center gap-6">
        <span className="hidden xl:flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {formatCalendarDate(event.startDate, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <Link href={`/e/${event.slug}`} className="flex items-center gap-1.5 text-sm hover:text-primary">
          Gathering page <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  )
}
