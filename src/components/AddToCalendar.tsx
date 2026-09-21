'use client'

import * as React from 'react'
import { Calendar, ChevronDown, Download, ExternalLink } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  generateGoogleCalendarURL,
  generateOutlookCalendarURL,
  generateYahooCalendarURL,
  sessionToICSEvent,
} from '@/lib/calendar/ics'

interface AddToCalendarProps {
  /** Session data for the calendar entry */
  session: {
    id: string
    title: string
    description?: string | null
    /** A linked host's own display name (never a name someone else typed). */
    hostLabel?: string | null
    is_self_hosted?: boolean
    self_hosted_start_time?: string | null
    self_hosted_end_time?: string | null
    time_slot?: { start_time: string; end_time: string } | null
    venue?: { name: string; address?: string | null } | null
  }
  /** Event slug for ICS download URL */
  eventSlug: string
  /** Event location fallback */
  eventLocation?: string | null
  /** 'icon' renders an icon-only trigger (with an accessible name); any Button variant otherwise. */
  variant?: NonNullable<ButtonProps['variant']> | 'icon'
  size?: ButtonProps['size']
  className?: string
}

export function AddToCalendar({
  session,
  eventSlug,
  eventLocation,
  variant = 'ghost',
  size = 'default',
  className,
}: AddToCalendarProps) {
  const start = session.time_slot?.start_time ?? (session.is_self_hosted ? session.self_hosted_start_time : null)
  const end = session.time_slot?.end_time ?? (session.is_self_hosted ? session.self_hosted_end_time : null)
  if (!start || !end) return null

  const location = session.is_self_hosted
    ? 'Self-hosted — see the session page'
    : [session.venue?.name || eventLocation, session.venue?.address].filter(Boolean).join(', ')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const icsEvent = sessionToICSEvent({
    id: session.id,
    title: session.title,
    description: session.description,
    hostLabel: session.hostLabel,
    startTime: start,
    endTime: end,
    location,
    eventSlug,
  }, origin)

  const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

  const handleDownloadICS = () => {
    window.location.href = `/api/v1/events/${eventSlug}/sessions/${session.id}/calendar`
  }

  const iconOnly = variant === 'icon'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={iconOnly ? 'ghost' : variant}
          size={iconOnly ? 'icon-sm' : size}
          className={className}
          aria-label={iconOnly ? 'Add to calendar' : undefined}
          title={iconOnly ? 'Add to calendar' : undefined}
        >
          <Calendar className="h-4 w-4" aria-hidden />
          {!iconOnly && (
            <>
              <span className="ml-2">Add to calendar</span>
              <ChevronDown className="ml-auto h-4 w-4 opacity-60" aria-hidden />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => open(generateGoogleCalendarURL(icsEvent))}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
          Google Calendar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(generateOutlookCalendarURL(icsEvent))}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
          Outlook
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(generateYahooCalendarURL(icsEvent))}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
          Yahoo Calendar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleDownloadICS}>
          <Download className="mr-2 h-4 w-4" aria-hidden />
          Download .ics
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ExportScheduleButtonProps extends Pick<ButtonProps, 'variant' | 'size' | 'className'> {
  eventSlug: string
  eventName: string
  /** Whether to export favorites only */
  favoritesOnly?: boolean
}

export function ExportScheduleButton({
  eventSlug,
  eventName,
  favoritesOnly = false,
  variant = 'outline',
  size = 'default',
  className,
}: ExportScheduleButtonProps) {
  const handleDownload = () => {
    const params = favoritesOnly ? '?favorites=true' : ''
    window.location.href = `/api/v1/events/${eventSlug}/calendar${params}`
  }

  return (
    <Button variant={variant} size={size} className={className} onClick={handleDownload} title={`Download the ${eventName} schedule as .ics`}>
      <Download className="mr-2 h-4 w-4" aria-hidden />
      {favoritesOnly ? 'Export my schedule' : 'Export full schedule'}
    </Button>
  )
}
