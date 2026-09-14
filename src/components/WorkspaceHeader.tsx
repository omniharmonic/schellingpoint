'use client'

import Link from 'next/link'
import { ArrowUpRight, CalendarDays } from 'lucide-react'
import { useEvent } from '@/contexts/EventContext'
import { formatCalendarDate } from '@/lib/events/dates'

export function WorkspaceHeader({ label }: { label: string }) {
  const event = useEvent()
  return <div className="hidden md:flex h-[76px] items-center justify-between gap-4 border-b px-8 lg:px-10 bg-card/70">
    <div className="flex items-center gap-3 text-sm"><span className="text-muted-foreground truncate max-w-[240px]">{event.name}</span><span className="text-border">/</span><span className="font-medium">{label}</span></div>
    <div className="flex items-center gap-6">
      <span className="hidden xl:flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays className="h-4 w-4" />{formatCalendarDate(event.startDate, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      <Link href={`/e/${event.slug}`} className="flex items-center gap-2 text-sm hover:text-primary">Event page <ArrowUpRight className="h-4 w-4" /></Link>
    </div>
  </div>
}
