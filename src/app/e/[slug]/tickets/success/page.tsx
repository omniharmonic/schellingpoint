'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Ticket, Calendar, ArrowRight, Loader2, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { SuccessPanel } from '@/components/SuccessPanel'
import { useEvent } from '@/contexts/EventContext'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch } from '@/lib/api/client'

interface TicketDetails {
  id: string
  status: string
  tier: {
    name: string
  }
}

/** Human labels for ticket statuses; the API value is never shown raw. */
const TICKET_STATUS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  refund_needed: 'Refund due',
  cancelled: 'Cancelled',
}

export default function TicketSuccessPage() {
  const searchParams = useSearchParams()
  const event = useEvent()
  const { user, isLoading: authLoading } = useAuth()

  const [ticket, setTicket] = React.useState<TicketDetails | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const ticketId = searchParams.get('ticket')

  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    if (authLoading) return
    async function fetchTicket() {
      if (!ticketId || !user) {
        setLoading(false)
        return
      }
      try {
        const data = await apiFetch<{ ticket: TicketDetails }>(
          `/api/v1/events/${encodeURIComponent(event.slug)}/tickets/${encodeURIComponent(ticketId)}`,
        )
        if (cancelled) return
        setTicket(data.ticket)
        setError(null)
        // Paid tickets are confirmed by the payment webhook; check again for a short while.
        if (data.ticket.status === 'pending' && attempts < 10) {
          attempts++
          timer = setTimeout(fetchTicket, 3000)
        }
      } catch {
        if (!cancelled) setError('Your ticket details could not be loaded yet. They are safe; open “Your tickets” from the gathering page to see them.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchTicket()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
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

  const pending = ticket?.status === 'pending'
  const ticketHref = ticketId ? `/e/${event.slug}/tickets/${ticketId}` : `/e/${event.slug}/tickets`

  return (
    <div className="container mx-auto px-5 py-8">
      <div className="max-w-lg mx-auto space-y-6">
        <SuccessPanel
          title={pending ? 'Almost there' : 'You’re in'}
          icon={pending ? <Clock className="h-7 w-7" aria-hidden="true" /> : undefined}
          body={pending
            ? `We are waiting for the payment confirmation for ${event.name}. This page checks again on its own.`
            : `Your ticket for ${event.name} is confirmed.`}
          primary={
            <Button asChild>
              <Link href={ticketHref}>
                <Ticket className="h-4 w-4 mr-2" aria-hidden="true" />
                View your ticket
              </Link>
            </Button>
          }
          secondary={
            <Button variant="outline" asChild>
              <Link href={`/e/${event.slug}/schedule`}>
                <Calendar className="h-4 w-4 mr-2" aria-hidden="true" />
                View schedule
              </Link>
            </Button>
          }
        />

        <Card>
          <CardContent className="pt-6 space-y-6">
            {error ? (
              <p role="alert" className="text-sm text-muted-foreground text-center">{error}</p>
            ) : ticket ? (
              <div className="bg-muted rounded-lg p-4">
                <div className="flex items-center gap-3">
                  <Ticket className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="font-medium">{ticket.tier?.name || 'Ticket'}</p>
                    <p className="text-sm text-muted-foreground">Status: {TICKET_STATUS[ticket.status] ?? 'Unknown'}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-muted rounded-lg p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  Your ticket is being processed. You’ll get a confirmation as soon as it is ready.
                </p>
              </div>
            )}

            <div className="space-y-3">
              <h2 className="font-medium">What’s next</h2>
              <ol className="space-y-2">
                {[
                  { title: 'Keep your ticket handy', body: 'Open your ticket page at the door to show its check-in QR code.' },
                  { title: 'Browse the schedule', body: 'See which sessions are planned and add them to your calendar.' },
                  { title: 'Propose a session', body: 'Share what you know by proposing a session of your own.' },
                ].map((step, i) => (
                  <li key={step.title} className="flex items-start gap-3 text-sm">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true">
                      <span className="text-xs font-medium">{i + 1}</span>
                    </div>
                    <div>
                      <p className="font-medium">{step.title}</p>
                      <p className="text-muted-foreground">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex justify-center">
              <Button variant="ghost" asChild>
                <Link href={`/e/${event.slug}/propose`}>
                  Propose a session
                  <ArrowRight className="h-4 w-4 ml-2" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
