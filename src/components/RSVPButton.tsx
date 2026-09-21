'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { UserCheck, UserPlus, Clock, Users } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

type RsvpStatus = 'confirmed' | 'waitlist'

interface RsvpResponse {
  my_rsvp: { status: RsvpStatus; waitlist_position: number | null; public: boolean } | null
  rsvp_count: number
  waitlist_count: number
}

interface RSVPButtonProps extends Pick<ButtonProps, 'variant' | 'size' | 'className'> {
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
  className,
  showCapacity = true,
  onRSVPChange,
}: RSVPButtonProps) {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()
  const { toast } = useToast()

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
      const next = result.my_rsvp?.status ?? null
      setStatus(next)
      setWaitlistPosition(result.my_rsvp?.waitlist_position ?? null)
      setLocalRsvpCount(result.rsvp_count)
      setLocalWaitlistCount(result.waitlist_count)
      onRSVPChange?.(next)
      if (next === 'confirmed') toast({ title: 'You’re going', description: 'This session is on your RSVP list.', variant: 'success' })
      else if (next === 'waitlist') toast({ title: 'You’re on the waitlist', description: 'We’ll move you in if a spot opens.', variant: 'success' })
      else toast({ title: 'RSVP cancelled', variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your RSVP could not be saved. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  let icon: React.ReactNode
  let label: string
  if (status === 'confirmed') {
    icon = <UserCheck className="mr-2 h-4 w-4" aria-hidden />
    label = 'You’re going'
  } else if (status === 'waitlist') {
    icon = <Clock className="mr-2 h-4 w-4" aria-hidden />
    label = `On the waitlist${waitlistPosition ? ` (#${waitlistPosition})` : ''}`
  } else if (!hasRoom) {
    icon = <Clock className="mr-2 h-4 w-4" aria-hidden />
    label = 'Join the waitlist'
  } else {
    icon = <UserPlus className="mr-2 h-4 w-4" aria-hidden />
    label = 'RSVP'
  }

  const buttonVariant: ButtonProps['variant'] = status ? 'default' : hasRoom ? variant : 'outline'

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant={buttonVariant}
        size={size}
        onClick={handleRSVP}
        loading={isLoading}
        aria-pressed={status !== null}
        title={status ? 'Cancel your RSVP' : undefined}
        className={cn(
          status === 'confirmed' && 'bg-success text-success-foreground hover:bg-success/90',
          status === 'waitlist' && 'bg-signal-amber text-foreground hover:bg-signal-amber/90',
          className
        )}
      >
        {!isLoading && icon}
        {label}
      </Button>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>
      )}

      {showCapacity && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3 w-3" aria-hidden />
          {capacity !== null ? (
            <span>
              {localRsvpCount}/{capacity} spots
              {spotsLeft !== null && spotsLeft <= 5 && spotsLeft > 0 && (
                <span className="ml-1 text-signal-amber">({plural(spotsLeft, 'spot')} left)</span>
              )}
              {spotsLeft === 0 && <span className="ml-1 text-destructive">(full)</span>}
            </span>
          ) : (
            <span>{localRsvpCount} attending</span>
          )}
          {localWaitlistCount > 0 && <span>· {localWaitlistCount} waitlisted</span>}
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
  const nearlyFull = spotsLeft !== null && spotsLeft <= 3 && spotsLeft > 0

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span className={cn('tabular-nums', isFull && 'text-destructive', nearlyFull && 'text-signal-amber')}>
        {capacity !== null ? `${rsvpCount}/${capacity}` : rsvpCount}
      </span>
      {userStatus === 'confirmed' && <Badge variant="success">Going</Badge>}
      {userStatus === 'waitlist' && <Badge variant="amber">Waitlist</Badge>}
    </div>
  )
}
