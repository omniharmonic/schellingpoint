'use client'

import * as React from 'react'
import Link from 'next/link'
import { useEvent } from '@/contexts/EventContext'
import { Heart, Mic, Wrench, MessageSquare, Users, Monitor, MapPin, Clock, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RSVPIndicator } from '@/components/RSVPButton'
import { VoteControl } from '@/components/VoteControl'
import { apiFetch } from '@/lib/api/client'
import { formatLabel } from '@/lib/sessions/constants'
import { cn } from '@/lib/utils'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import { profileHref } from '@/app/e/[slug]/people/shared'

const formatIcons: Record<string, React.ReactNode> = {
  talk: <Mic className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />,
  workshop: <Wrench className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />,
  discussion: <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />,
  panel: <Users className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />,
  demo: <Monitor className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />,
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
  /** Called for signed-out viewers too; the page decides whether to send them to sign in. */
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
  const trackColor = session.track?.color || undefined
  const startsAt = session.time_slot?.start_time || (session.is_self_hosted ? session.self_hosted_start_time : null)
  const href = `/e/${eventSlug}/sessions/${session.id}`
  // Handles are optional on the API payload; show one under the byline when present.
  const hostHandle = session.host?.handle ?? null
  const showFooter = (session.status === 'scheduled' && !!session.venue?.capacity) || (showVoting && !eventIsOver)

  return (
    <Card
      accent={trackColor ? 'top' : undefined}
      accentColor={trackColor}
      className={cn(
        'group overflow-hidden transition-all duration-200',
        'hover:border-primary/30 hover:shadow-[0_6px_0_hsl(var(--foreground)/.06)]'
      )}
    >
      <CardContent className="p-4 pt-4 sm:p-6 sm:pt-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                {formatIcons[session.format ?? ''] || <Mic className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />}
                {formatLabel(session.format)}
              </span>
              {session.duration != null && (
                <>
                  <span className="text-border" aria-hidden>·</span>
                  <span>{session.duration} min</span>
                </>
              )}
              {session.track && (
                <>
                  <span className="hidden text-border sm:inline" aria-hidden>·</span>
                  <span className="hidden items-center gap-1.5 sm:flex">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: session.track.color || undefined }} aria-hidden />
                    {session.track.name}
                  </span>
                </>
              )}
            </div>

            {onToggleFavorite && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={isFavorited ? `Remove ${session.title} from my schedule` : `Save ${session.title} to my schedule`}
                aria-pressed={isFavorited}
                onClick={() => onToggleFavorite(session.id)}
                title={isFavorited ? 'Remove from my schedule' : isLoggedIn ? 'Save to my schedule' : 'Sign in to save this session'}
                className={cn('-mr-2 -mt-1 shrink-0', isFavorited ? 'text-favorite hover:text-favorite' : 'text-muted-foreground hover:text-favorite')}
              >
                <Heart className={cn('h-4 w-4', isFavorited && 'fill-favorite')} aria-hidden />
              </Button>
            )}
          </div>

          <Link href={href} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <h3 className="line-clamp-2 break-anywhere font-display text-lg font-semibold leading-snug transition-colors group-hover:text-primary">
              {session.title}
              <ChevronRight className="ml-1 inline h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </h3>
          </Link>

          {/* The byline links to the host's profile in this gathering when we know their DID —
              the read model sends it to members only, so a public card stays plain text
              (design §3.2). */}
          {/* A display name and a handle are both single unbreakable words as far as the browser
              is concerned, so they need `anywhere` rather than `break-word` to stay in the card. */}
          <p className={cn('break-anywhere text-xs text-muted-foreground', !session.host && 'italic')}>
            {session.host?.did ? (
              <Link href={profileHref(eventSlug, session.host.did)} className="not-italic hover:text-primary hover:underline">
                {hostByline(session)}
              </Link>
            ) : (
              hostByline(session)
            )}
            {hostHandle && <span className="ml-1.5 not-italic">@{hostHandle}</span>}
          </p>

          {session.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{session.description}</p>
          )}

          {session.topic_tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {session.topic_tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="muted">{tag}</Badge>
              ))}
            </div>
          )}

          {(session.venue || session.is_self_hosted) && (
            <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-2.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                {session.is_self_hosted ? 'Self-hosted' : session.venue?.name}
              </span>
              {startsAt && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  {formatTime(startsAt, event.timezone)}
                </span>
              )}
            </div>
          )}

          {showFooter && (
            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
              {session.status === 'scheduled' && session.venue?.capacity ? (
                <RSVPIndicator
                  rsvpCount={session.rsvp_count}
                  capacity={session.venue.capacity}
                  userStatus={session.my_rsvp?.status ?? null}
                />
              ) : (
                <span />
              )}
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
