'use client'

import * as React from 'react'
import Link from 'next/link'
import { useEvent } from '@/contexts/EventContext'
import { Heart, Mic, Wrench, MessageSquare, Users, Monitor, MapPin, Clock, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { RSVPIndicator } from '@/components/RSVPButton'
import { VoteControl } from '@/components/VoteControl'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'


const formatIcons: Record<string, React.ReactNode> = {
  talk: <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />,
  workshop: <Wrench className="h-3.5 w-3.5" strokeWidth={1.5} />,
  discussion: <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} />,
  panel: <Users className="h-3.5 w-3.5" strokeWidth={1.5} />,
  demo: <Monitor className="h-3.5 w-3.5" strokeWidth={1.5} />,
}

function formatTime(isoString: string, timeZone: string): string {
  return new Date(isoString).toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** Save or unsave a session in the viewer's personal schedule. */
export async function setFavorite(eventSlug: string, sessionId: string, favorite: boolean): Promise<void> {
  await apiFetch(`/api/v1/events/${encodeURIComponent(eventSlug)}/favorites/${sessionId}`, {
    method: favorite ? 'PUT' : 'DELETE',
  })
}

interface SessionCardProps {
  session: SessionView
  eventSlug: string
  isFavorited?: boolean
  onToggleFavorite?: (sessionId: string) => void
  /** Render the ballot control (C) for this session. */
  showVoting?: boolean
  isLoggedIn?: boolean
}

export function SessionCard({
  session,
  eventSlug,
  isFavorited = false,
  onToggleFavorite,
  showVoting = true,
  isLoggedIn = false,
}: SessionCardProps) {
  const event = useEvent()
  const eventIsOver = event.status === 'completed' || event.status === 'archived'
  const trackColor = session.track?.color || 'hsl(var(--signal))'
  const startsAt = session.time_slot?.start_time || (session.is_self_hosted ? session.self_hosted_start_time : null)

  return (
    <Card
      accent="top"
      accentColor={trackColor}
      className={cn(
        'overflow-hidden group border-t-4 transition-all duration-200',
        'hover:border-[hsl(var(--signal)_/_0.3)]',
        'hover:shadow-[0_6px_0_hsl(var(--foreground)/.06)]',
      )}
      style={{ '--tw-shadow-color': trackColor } as React.CSSProperties}
    >
      <CardContent className="p-3.5 sm:p-5">
        <div className="space-y-2.5 sm:space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="flex items-center gap-1.5 text-[11px] tracking-wider">
                {formatIcons[session.format ?? ''] || <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />}
                {session.format}
              </span>
              <span className="text-border">·</span>
              <span className="text-[11px] tracking-wider">{session.duration} min</span>
              {session.track && (
                <>
                  <span className="text-border hidden sm:inline">·</span>
                  <span className="hidden sm:flex items-center gap-1.5 text-xs">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: session.track.color || undefined }}
                    />
                    {session.track.name}
                  </span>
                </>
              )}
            </div>

            {onToggleFavorite && isLoggedIn && (
              <button
                aria-label={isFavorited ? `Unsave ${session.title}` : `Save ${session.title}`}
                aria-pressed={isFavorited}
                onClick={() => onToggleFavorite(session.id)}
                title={isFavorited ? 'Remove from My Schedule' : 'Save to My Schedule'}
                className={cn(
                  'p-2 rounded-md transition-colors',
                  isFavorited
                    ? 'text-red-500 bg-red-500/10 hover:bg-red-500/20'
                    : 'text-muted-foreground hover:text-red-500 hover:bg-muted'
                )}
              >
                <Heart className={cn('h-4 w-4', isFavorited && 'fill-current')} />
              </button>
            )}
          </div>

          <Link href={`/e/${eventSlug}/sessions/${session.id}`} className="block">
            <h3 className="font-display font-semibold text-lg leading-snug line-clamp-2 group-hover:text-primary transition-colors">
              {session.title}
              <ChevronRight className="inline h-3.5 w-3.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity" />
            </h3>
          </Link>

          <p className={cn('text-xs', session.host ? 'text-muted-foreground' : 'text-muted-foreground italic')}>
            {hostByline(session)}
          </p>

          {session.description && (
            <Link href={`/e/${eventSlug}/sessions/${session.id}`} className="block">
              <p className="text-sm text-muted-foreground line-clamp-2 hover:text-foreground/80 transition-colors">
                {session.description}
              </p>
            </Link>
          )}

          {session.topic_tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {session.topic_tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-sm border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {(session.venue || session.is_self_hosted) && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground bg-surface-2 rounded-md p-2.5">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" strokeWidth={1.5} />
                {session.is_self_hosted ? 'Self-hosted' : session.venue?.name}
              </span>
              {startsAt && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {formatTime(startsAt, event.timezone)}
                </span>
              )}
            </div>
          )}

          {((session.status === 'scheduled' && session.venue?.capacity) || (showVoting && !eventIsOver)) && (
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-border/50">
              <div className="flex items-center gap-3">
                {session.status === 'scheduled' && session.venue?.capacity ? (
                  <RSVPIndicator
                    rsvpCount={session.rsvp_count}
                    capacity={session.venue.capacity}
                    userStatus={session.my_rsvp?.status ?? null}
                  />
                ) : null}
              </div>
              {showVoting && !eventIsOver && (
                <VoteControl eventSlug={eventSlug} sessionId={session.id} sessionTitle={session.title} compact />
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
