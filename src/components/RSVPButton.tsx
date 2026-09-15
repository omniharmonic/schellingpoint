'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserCheck, UserPlus, Clock, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'

type RsvpStatus = 'confirmed' | 'waitlist'

interface RsvpResponse {
  my_rsvp: { status: RsvpStatus; waitlist_position: number | null; public: boolean } | null
  rsvp_count: number
  waitlist_count: number
}

interface RSVPButtonProps {
  sessionId: string
  /** Current confirmed RSVP count */
  rsvpCount: number
  /** Current waitlist count */
  waitlistCount: number
  /** Venue capacity (null = unlimited) */
  capacity: number | null
  /** Initial user RSVP status */
  initialStatus?: RsvpStatus | null
  /** Initial waitlist position (if on waitlist) */
  initialWaitlistPosition?: number | null
  /** Button variant */
  variant?: 'default' | 'outline' | 'ghost'
  /** Button size */
  size?: 'default' | 'sm' | 'lg'
  /** Show capacity info */
  showCapacity?: boolean
  /** Callback when RSVP changes */
  onRSVPChange?: (status: RsvpStatus | null) => void
}

/**
 * RSVP for a scheduled session. The RSVP stays inside the gathering (spec §10); the server
 * decides confirmed vs waitlist from venue capacity. Cancelling also retracts a public RSVP
 * record if the attendee had chosen to publish one.
 */
export function RSVPButton({
  sessionId,
  rsvpCount,
  waitlistCount,
  capacity,
  initialStatus = null,
  initialWaitlistPosition = null,
  variant = 'default',
  size = 'default',
  showCapacity = true,
  onRSVPChange,
}: RSVPButtonProps) {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()

  const [status, setStatus] = React.useState<RsvpStatus | null>(initialStatus)
  const [waitlistPosition, setWaitlistPosition] = React.useState<number | null>(initialWaitlistPosition)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [localRsvpCount, setLocalRsvpCount] = React.useState(rsvpCount)
  const [localWaitlistCount, setLocalWaitlistCount] = React.useState(waitlistCount)

  React.useEffect(() => {
    setStatus(initialStatus)
    setWaitlistPosition(initialWaitlistPosition)
  }, [initialStatus, initialWaitlistPosition])

  React.useEffect(() => {
    setLocalRsvpCount(rsvpCount)
    setLocalWaitlistCount(waitlistCount)
  }, [rsvpCount, waitlistCount])

  const hasRoom = capacity === null || localRsvpCount < capacity
  const spotsLeft = capacity !== null ? Math.max(0, capacity - localRsvpCount) : null

  const handleRSVP = async () => {
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions/${sessionId}`)}`)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const result = await apiFetch<RsvpResponse>(
        `/api/v1/events/${encodeURIComponent(event.slug)}/rsvps/${sessionId}`,
        { method: status ? 'DELETE' : 'PUT', ...(status ? {} : { json: {} }) },
      )
      setStatus(result.my_rsvp?.status ?? null)
      setWaitlistPosition(result.my_rsvp?.waitlist_position ?? null)
      setLocalRsvpCount(result.rsvp_count)
      setLocalWaitlistCount(result.waitlist_count)
      onRSVPChange?.(result.my_rsvp?.status ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your RSVP could not be saved. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  // Render different states
  const renderButtonContent = () => {
    if (isLoading) {
      return (
        <>
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          <span>Loading...</span>
        </>
      )
    }

    if (status === 'confirmed') {
      return (
        <>
          <UserCheck className="h-4 w-4 mr-2" />
          <span>You&apos;re going</span>
        </>
      )
    }

    if (status === 'waitlist') {
      return (
        <>
          <Clock className="h-4 w-4 mr-2" />
          <span>On waitlist{waitlistPosition ? ` (#${waitlistPosition})` : ''}</span>
        </>
      )
    }

    if (!hasRoom) {
      return (
        <>
          <Clock className="h-4 w-4 mr-2" />
          <span>Join waitlist</span>
        </>
      )
    }

    return (
      <>
        <UserPlus className="h-4 w-4 mr-2" />
        <span>RSVP</span>
      </>
    )
  }

  const buttonVariant = status ? 'default' : (hasRoom ? variant : 'outline')

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant={buttonVariant}
        size={size}
        onClick={handleRSVP}
        disabled={isLoading}
        className={cn(
          status === 'confirmed' && 'bg-green-600 hover:bg-green-700 text-white',
          status === 'waitlist' && 'bg-amber-500 hover:bg-amber-600 text-white'
        )}
      >
        {renderButtonContent()}
      </Button>

      {error && <p role="alert" className="text-xs text-destructive text-center">{error}</p>}

      {showCapacity && (
        <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3 w-3" />
          {capacity !== null ? (
            <span>
              {localRsvpCount}/{capacity} spots
              {spotsLeft !== null && spotsLeft <= 5 && spotsLeft > 0 && (
                <span className="text-amber-500 ml-1">({spotsLeft} left)</span>
              )}
              {spotsLeft === 0 && (
                <span className="text-red-500 ml-1">(Full)</span>
              )}
            </span>
          ) : (
            <span>{localRsvpCount} attending</span>
          )}
          {localWaitlistCount > 0 && (
            <span className="text-muted-foreground">
              + {localWaitlistCount} waitlisted
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Compact RSVP indicator for session cards
 */
export function RSVPIndicator({
  rsvpCount,
  capacity,
  userStatus,
}: {
  rsvpCount: number
  capacity: number | null
  userStatus?: 'confirmed' | 'waitlist' | null
}) {
  const spotsLeft = capacity !== null ? capacity - rsvpCount : null
  const isFull = spotsLeft !== null && spotsLeft <= 0

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <Users className="h-4 w-4 text-muted-foreground" />
      <span className={cn(
        isFull && 'text-red-500',
        spotsLeft !== null && spotsLeft <= 3 && spotsLeft > 0 && 'text-amber-500'
      )}>
        {capacity !== null ? `${rsvpCount}/${capacity}` : rsvpCount}
      </span>
      {userStatus === 'confirmed' && (
        <span className="text-green-600 text-xs font-medium">(Going)</span>
      )}
      {userStatus === 'waitlist' && (
        <span className="text-amber-500 text-xs font-medium">(Waitlist)</span>
      )}
    </div>
  )
}
