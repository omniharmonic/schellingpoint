'use client'

import * as React from 'react'
import Link from 'next/link'
import { useEvent } from '@/contexts/EventContext'
import { Heart, Mic, Wrench, MessageSquare, Users, Monitor, Plus, Minus, MapPin, Clock, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RSVPIndicator } from '@/components/RSVPButton'
import { cn, votesToCredits, nextVoteCost, type VotingMechanism } from '@/lib/utils'

const formatIcons: Record<string, React.ReactNode> = {
  talk: <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />,
  workshop: <Wrench className="h-3.5 w-3.5" strokeWidth={1.5} />,
  discussion: <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} />,
  panel: <Users className="h-3.5 w-3.5" strokeWidth={1.5} />,
  demo: <Monitor className="h-3.5 w-3.5" strokeWidth={1.5} />,
}

function formatTime(isoString: string, timeZone: string): string {
  const date = new Date(isoString)
  return date.toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

interface SessionCardProps {
  session: {
    id: string
    title: string
    description: string | null
    format: string
    duration: number
    host_name: string | null
    topic_tags: string[] | null
    total_votes: number
    status: string
    venue?: { name: string; capacity?: number | null } | null
    time_slot?: { label: string; start_time: string } | null
    is_self_hosted?: boolean
    custom_location?: string | null
    self_hosted_start_time?: string | null
    self_hosted_end_time?: string | null
    track?: { id: string; name: string; color: string | null } | null
    cohosts?: { profile: { display_name: string | null } | null }[] | null
    rsvp_count?: number
    waitlist_count?: number
  }
  eventSlug: string
  userVotes?: number
  isFavorited?: boolean
  remainingCredits: number
  onVote?: (sessionId: string, newVoteCount: number) => void
  onToggleFavorite?: (sessionId: string) => void
  showVoting?: boolean
  isLoggedIn?: boolean
  userRsvpStatus?: 'confirmed' | 'waitlist' | null
  votingMechanism?: VotingMechanism
}

export function SessionCard({
  session,
  eventSlug,
  userVotes = 0,
  isFavorited = false,
  remainingCredits,
  onVote,
  onToggleFavorite,
  showVoting = true,
  isLoggedIn = false,
  userRsvpStatus,
  votingMechanism = 'quadratic',
}: SessionCardProps) {
  const event = useEvent()
  const eventIsOver = event.status === 'completed' || event.status === 'archived'
  const currentCredits = votesToCredits(userVotes, votingMechanism)
  const costToAdd = nextVoteCost(userVotes, votingMechanism)
  const canAddVote = remainingCredits >= costToAdd
  const isApproval = votingMechanism === 'approval'
  const showAddControl = !isApproval || userVotes === 0

  const handleAddVote = () => {
    if (canAddVote && onVote) {
      onVote(session.id, userVotes + 1)
    }
  }

  const handleRemoveVote = () => {
    if (userVotes > 0 && onVote) {
      onVote(session.id, userVotes - 1)
    }
  }

  const trackColor = session.track?.color || 'hsl(var(--signal))'

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
          {/* Header: format label + duration (monospace system layer) */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="flex items-center gap-1.5 text-[11px] tracking-wider">
                {formatIcons[session.format] || <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />}
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

            {/* Favorite */}
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

          {/* Title (human layer — display font) */}
          <Link href={`/e/${eventSlug}/sessions/${session.id}`} className="block">
            <h3 className="font-display font-semibold text-lg leading-snug line-clamp-2 group-hover:text-primary transition-colors">
              {session.title}
              <ChevronRight className="inline h-3.5 w-3.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity" />
            </h3>
          </Link>

          {/* Host */}
          {session.host_name && (() => {
            const cohostNames = (session.cohosts || [])
              .map(c => c.profile?.display_name)
              .filter(Boolean) as string[]
            let byLine = session.host_name
            if (cohostNames.length === 1) byLine += ` & ${cohostNames[0]}`
            else if (cohostNames.length > 1) byLine += ` & ${cohostNames.length} others`
            return (
              <p className="text-xs text-muted-foreground">
                {byLine}
              </p>
            )
          })()}

          {/* Description */}
          {session.description && (
            <Link href={`/e/${eventSlug}/sessions/${session.id}`} className="block">
              <p className="text-sm text-muted-foreground line-clamp-2 hover:text-foreground/80 transition-colors">
                {session.description}
              </p>
            </Link>
          )}

          {/* Tags — monospace diagram labels */}
          {session.topic_tags && session.topic_tags.length > 0 && (
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

          {/* Scheduled info */}
          {(session.venue || session.is_self_hosted || session.self_hosted_start_time) && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground bg-surface-2 rounded-md p-2.5">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" strokeWidth={1.5} />
                {session.is_self_hosted ? (
                  session.custom_location || 'Self-Hosted'
                ) : session.venue ? (
                  session.venue.name
                ) : null}
              </span>
              {(session.time_slot?.start_time || session.self_hosted_start_time) && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {formatTime(session.time_slot?.start_time || session.self_hosted_start_time!, event.timezone)}
                </span>
              )}
            </div>
          )}

          {/* Signal meter: vote count + controls */}
          <div className="flex items-center justify-between pt-3 border-t border-border/50">
            <div className="flex items-center gap-3">
              {/* Signal strength — vote count as monospace readout */}
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-bold text-primary tabular-nums">
                  {session.total_votes}
                </span>
                <span className="text-xs text-muted-foreground">
                  votes
                </span>
              </div>
              {/* RSVP indicator for scheduled sessions */}
              {session.status === 'scheduled' && session.venue?.capacity && (
                <RSVPIndicator
                  rsvpCount={session.rsvp_count || 0}
                  capacity={session.venue.capacity}
                  userStatus={userRsvpStatus}
                />
              )}
            </div>

            {/* Voting controls — precise instrument buttons */}
            {showVoting && !eventIsOver && isLoggedIn && onVote && (
              <div className="flex items-center gap-1.5">
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={`Remove a vote from ${session.title}`}
                  onClick={handleRemoveVote}
                  disabled={userVotes === 0}
                  className="rounded-lg"
                >
                  <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>

                <div className="min-w-[52px] text-center">
                  <div className="font-bold text-sm tabular-nums">{userVotes}</div>
                  <div className="text-xs text-muted-foreground tracking-wider">
                    {currentCredits} credits
                  </div>
                </div>

                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={`Add a vote to ${session.title} for ${costToAdd} credits`}
                  onClick={handleAddVote}
                  disabled={!canAddVote || !showAddControl}
                  title={isApproval && userVotes > 0 ? 'Already approved' : undefined}
                  className="rounded-lg"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
