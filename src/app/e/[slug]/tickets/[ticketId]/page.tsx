'use client'

import * as React from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Calendar, MapPin, Ticket, CheckCircle, Clock, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { TicketQR } from '@/components/TicketQR'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { formatDateRange } from '@/lib/format'

interface TicketData {
  id: string
  status: string
  created_at: string
  checked_in_at: string | null
  tier: {
    name: string
    description: string | null
  }
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; variant: BadgeProps['variant']; description: string }> = {
  pending: {
    label: 'Pending',
    icon: Clock,
    variant: 'amber',
    description: 'Your payment is being processed.',
  },
  confirmed: {
    label: 'Confirmed',
    icon: CheckCircle,
    variant: 'success',
    description: 'Your ticket is confirmed.',
  },
  checked_in: {
    label: 'Checked in',
    icon: CheckCircle,
    variant: 'default',
    description: 'You have checked in to the gathering.',
  },
  refund_needed: {
    label: 'Refund due',
    icon: XCircle,
    variant: 'amber',
    description: 'Your payment arrived after the last seat was taken. The organizer will refund it.',
  },
  cancelled: {
    label: 'Cancelled',
    icon: XCircle,
    variant: 'destructive',
    description: 'This ticket has been cancelled.',
  },
}

export default function TicketDetailPage() {
  const params = useParams()
  const ticketId = params.ticketId as string
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()

  const [ticket, setTicket] = React.useState<TicketData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (authLoading) return
    async function fetchTicket() {
      if (!user) {
        setLoading(false)
        return
      }
      try {
        const data = await apiFetch<{ ticket: TicketData }>(
          `/api/v1/events/${encodeURIComponent(event.slug)}/tickets/${encodeURIComponent(ticketId)}`,
        )
        if (!cancelled) setTicket(data.ticket)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError && err.status === 404 ? 'This ticket could not be found.' : 'Your ticket could not be loaded. Please try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchTicket()
    return () => {
      cancelled = true
    }
  }, [ticketId, user, event.slug, authLoading])

  if (loading) {
    return (
      <div className="container mx-auto px-5 py-8">
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading your ticket">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="container mx-auto px-5 py-8">
        <Card>
          <CardContent className="py-12 text-center">
            <Ticket className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-xl font-semibold mb-2">Sign in to see your ticket</h1>
            <p className="text-muted-foreground mb-6">Tickets are shown only to the person who holds them.</p>
            <Button asChild>
              <Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/tickets/${ticketId}`)}`}>Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error || !ticket) {
    return (
      <div className="container mx-auto px-5 py-8">
        <Card>
          <CardContent className="py-12 text-center">
            <Ticket className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-xl font-semibold mb-2">Ticket not found</h1>
            <p className="text-muted-foreground mb-6">{error || 'This ticket could not be found.'}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" asChild>
                <Link href={`/e/${event.slug}/tickets`}>
                  <ArrowLeft className="h-4 w-4 mr-2" aria-hidden="true" />
                  Back to tickets
                </Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link href={`/e/${event.slug}`}>Back to {event.name}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const statusConfig = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.pending
  const StatusIcon = statusConfig.icon
  const showQR = ticket.status === 'confirmed' || ticket.status === 'checked_in'

  return (
    <div className="container mx-auto px-5 py-8">
      <div className="max-w-lg mx-auto space-y-6">
        {/* Back link */}
        <Link
          href={`/e/${event.slug}/tickets`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
          Back to tickets
        </Link>

        {/* Ticket header */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="min-w-0">
                <h1 className="page-title">{ticket.tier?.name || 'Ticket'}</h1>
                {ticket.tier?.description && (
                  <p className="text-muted-foreground mt-1">{ticket.tier.description}</p>
                )}
              </div>
              <Badge variant={statusConfig.variant} className="shrink-0">
                <StatusIcon className="h-3 w-3 mr-1" aria-hidden="true" />
                {statusConfig.label}
              </Badge>
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span>{formatDateRange(event.startDate, event.endDate, event.timezone)}</span>
              </div>

              {event.locationName && (
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span>{event.locationName}</span>
                </div>
              )}
            </div>

            <p className="text-sm text-muted-foreground mt-4">{statusConfig.description}</p>

            {ticket.checked_in_at && (
              <p className="text-sm text-muted-foreground mt-2">
                Checked in: {new Date(ticket.checked_in_at).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>

        {/* QR code */}
        {showQR && (
          <TicketQR
            ticketId={ticket.id}
            eventSlug={event.slug}
            tierName={ticket.tier?.name}
            eventName={event.name}
            size="lg"
          />
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Button variant="outline" asChild className="flex-1">
            <Link href={`/e/${event.slug}/schedule`}>
              <Calendar className="h-4 w-4 mr-2" aria-hidden="true" />
              View schedule
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
