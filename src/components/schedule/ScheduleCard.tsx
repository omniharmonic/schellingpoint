'use client'

/**
 * The one schedule card (mobile shell design §4), with a `size` prop instead of the two
 * hand-maintained cards the Schedule and My schedule pages each had. Small on the three-column
 * program grid, medium on the two-column saved list; `dashed` is the "Not yet scheduled" tail.
 *
 * No vote counts, ever (spec §5.3): the card shows what a session is, who is hosting it, when and
 * where — never how many people chose it.
 */

import * as React from 'react'
import Link from 'next/link'
import { Clock, Heart, MapPin, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { formatLabel } from '@/lib/sessions/constants'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import { cn } from '@/lib/utils'
import type { ScheduleSession } from './useSchedule'

export interface ScheduleCardProps {
  session: ScheduleSession
  eventSlug: string
  timeZone: string
  signedIn: boolean
  isFavorited: boolean
  toggling: boolean
  onToggleFavorite: (sessionId: string) => void
  /** Which secondary details to show under the title. */
  show?: { time?: boolean; venue?: boolean; track?: boolean; duration?: boolean }
  size?: 'sm' | 'md'
  /** The dashed treatment for a saved session that has no time yet. */
  dashed?: boolean
}

export function formatTime(isoString: string, timeZone: string): string {
  return new Date(isoString).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
}

export function ScheduleCard({
  session,
  eventSlug,
  timeZone,
  signedIn,
  isFavorited,
  toggling,
  onToggleFavorite,
  show = {},
  size = 'sm',
  dashed,
}: ScheduleCardProps) {
  const href = `/e/${eventSlug}/sessions/${session.id}`
  const startsAt = session.when?.start_time ?? null
  return (
    <Card
      className={cn(
        'card-hover h-full',
        dashed && 'border-dashed',
        session.is_self_hosted
          ? 'border-signal-amber/30 hover:border-signal-amber/50'
          : 'schedule-session hover:border-primary/50',
      )}
      style={
        session.is_self_hosted
          ? undefined
          : ({ '--session-color': session.track?.color || 'hsl(var(--primary))' } as React.CSSProperties)
      }
    >
      <CardContent className={cn('space-y-1.5', size === 'sm' ? 'p-3 pt-3' : 'p-4 pt-4')}>
        <div className="flex items-start justify-between gap-2">
          <Link
            href={href}
            className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <h3 className={cn('line-clamp-2 font-semibold leading-snug', size === 'sm' ? 'text-sm' : 'text-base')}>
              {session.title}
            </h3>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            {session.is_self_hosted ? (
              <Badge variant="amber">Self-hosted</Badge>
            ) : (
              <Badge variant={dashed ? 'outline' : 'secondary'}>{formatLabel(session.format)}</Badge>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onToggleFavorite(session.id)}
              loading={toggling}
              className={cn(
                '-my-2 -mr-2',
                isFavorited ? 'text-favorite hover:text-favorite' : 'text-muted-foreground hover:text-favorite',
              )}
              aria-pressed={isFavorited}
              aria-label={
                isFavorited ? `Remove ${session.title} from my schedule` : `Save ${session.title} to my schedule`
              }
              title={
                isFavorited
                  ? 'Remove from my schedule'
                  : signedIn
                    ? 'Save to my schedule'
                    : 'Sign in to save this session'
              }
            >
              {!toggling && <Heart className={cn('h-4 w-4', isFavorited && 'fill-favorite')} aria-hidden />}
            </Button>
          </div>
        </div>

        <Link href={href} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {show.time && startsAt && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 shrink-0" aria-hidden />
                {formatTime(startsAt, timeZone)}
              </span>
            )}
            {show.duration && session.duration != null && <span>{session.duration} min</span>}
            <span className="flex min-w-0 items-center gap-1">
              <User className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{hostByline(session)}</span>
            </span>
            {show.venue && (session.venue || session.is_self_hosted) && (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{session.is_self_hosted ? 'Self-hosted' : session.venue?.name}</span>
              </span>
            )}
            {show.track && session.track && (
              <span className="flex min-w-0 items-center gap-1">
                {session.track.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: session.track.color }}
                    aria-hidden
                  />
                )}
                <span className="truncate">{session.track.name}</span>
              </span>
            )}
          </div>
        </Link>
      </CardContent>
    </Card>
  )
}
