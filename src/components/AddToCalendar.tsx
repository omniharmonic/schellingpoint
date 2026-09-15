'use client'

import * as React from 'react'
import { Calendar, ChevronDown, Download, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  /** Variant: 'default' for full button, 'icon' for icon-only */
  variant?: 'default' | 'icon' | 'outline'
  /** Size of the button */
  size?: 'default' | 'sm' | 'lg' | 'icon'
}

export function AddToCalendar({
  session,
  eventSlug,
  eventLocation,
  variant = 'default',
  size = 'default',
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

  const handleGoogleCalendar = () => {
    const url = generateGoogleCalendarURL(icsEvent)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleOutlookCalendar = () => {
    const url = generateOutlookCalendarURL(icsEvent)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleYahooCalendar = () => {
    const url = generateYahooCalendarURL(icsEvent)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleDownloadICS = () => {
    const icsUrl = `/api/v1/events/${eventSlug}/sessions/${session.id}/calendar`
    window.location.href = icsUrl
  }

  const buttonVariant = variant === 'outline' ? 'outline' : 'ghost'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={buttonVariant} size={size}>
          <Calendar className="h-4 w-4" />
          {variant !== 'icon' && (
            <>
              <span className="ml-2 hidden sm:inline">Add to Calendar</span>
              <ChevronDown className="h-4 w-4 ml-1 hidden sm:inline" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={handleGoogleCalendar}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Google Calendar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleOutlookCalendar}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Outlook
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleYahooCalendar}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Yahoo Calendar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleDownloadICS}>
          <Download className="h-4 w-4 mr-2" />
          Download .ics
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ExportScheduleButtonProps {
  eventSlug: string
  eventName: string
  /** Whether to export favorites only */
  favoritesOnly?: boolean
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
}

export function ExportScheduleButton({
  eventSlug,
  eventName,
  favoritesOnly = false,
  variant = 'outline',
  size = 'default',
}: ExportScheduleButtonProps) {
  const handleDownload = () => {
    const params = favoritesOnly ? '?favorites=true' : ''
    window.location.href = `/api/v1/events/${eventSlug}/calendar${params}`
  }

  return (
    <Button variant={variant} size={size} onClick={handleDownload}>
      <Download className="h-4 w-4 mr-2" />
      {favoritesOnly ? 'Export My Schedule' : 'Export Full Schedule'}
    </Button>
  )
}
