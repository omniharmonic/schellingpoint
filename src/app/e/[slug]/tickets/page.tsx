'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Ticket, Check, Clock, AlertCircle, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { formatPrice } from '@/lib/payments/format'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'

interface TicketTier {
  id: string
  name: string
  description: string | null
  price_cents: number
  currency: string
  quantity_total: number | null
  quantity_sold: number
  /** Confirmed tickets plus unexpired checkout holds. */
  quantity_reserved: number
  sale_starts_at: string | null
  sale_ends_at: string | null
  is_active: boolean
  allows_proposals: boolean
  allows_voting: boolean
  display_order: number
}

interface UserTicket {
  id: string
  tier_id: string
  status: string
}

/** Human labels for ticket statuses; the API value is never shown raw. */
const TICKET_STATUS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  refund_needed: 'Refund due',
  cancelled: 'Cancelled',
}

export default function TicketsPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()

  const [tiers, setTiers] = React.useState<TicketTier[]>([])
  const [userTickets, setUserTickets] = React.useState<UserTicket[]>([])
  const [loading, setLoading] = React.useState(true)
  const [purchasing, setPurchasing] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const loginHref = `/login?returnTo=${encodeURIComponent(`/e/${event.slug}/tickets`)}`

  // Tiers on sale and the viewer's own tickets
  React.useEffect(() => {
    let cancelled = false
    if (authLoading) return
    async function fetchData() {
      try {
        const data = await apiFetch<{ tiers: TicketTier[]; tickets: UserTicket[] }>(
          `/api/v1/events/${encodeURIComponent(event.slug)}/tickets`,
        )
        if (cancelled) return
        setTiers(data.tiers)
        setUserTickets(data.tickets)
        setError(null)
      } catch {
        if (!cancelled) setError('Ticket information could not be loaded. Please try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchData()
    return () => {
      cancelled = true
    }
  }, [event.slug, user?.id, authLoading])

  const handlePurchase = async (tier: TicketTier) => {
    if (!user) {
      router.push(loginHref)
      return
    }

    setPurchasing(tier.id)
    setError(null)

    try {
      const data = await apiFetch<{ url?: string; ticketId?: string; status?: string }>(
        `/api/v1/events/${encodeURIComponent(event.slug)}/checkout`,
        { method: 'POST', json: { tierId: tier.id } },
      )
      if (data.url) {
        // Stripe Checkout (paid tiers)
        window.location.href = data.url
      } else if (data.ticketId) {
        // Free ticket, confirmed server-side
        router.push(`/e/${event.slug}/tickets/success?ticket=${data.ticketId}`)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push(loginHref)
        return
      }
      setError(err instanceof Error ? err.message : 'Checkout could not be started. Please try again.')
    } finally {
      setPurchasing(null)
    }
  }

  const getTierStatus = (tier: TicketTier) => {
    const now = new Date()

    if (tier.sale_starts_at && new Date(tier.sale_starts_at) > now) {
      return { status: 'upcoming', label: 'Coming soon' }
    }

    if (tier.sale_ends_at && new Date(tier.sale_ends_at) < now) {
      return { status: 'ended', label: 'Sales ended' }
    }

    if (tier.quantity_total !== null && tier.quantity_reserved >= tier.quantity_total) {
      return { status: 'soldout', label: 'Sold out' }
    }

    return { status: 'available', label: null }
  }

  const userHasTicket = (tierId: string) => {
    return userTickets.some(t => t.tier_id === tierId && (t.status === 'confirmed' || t.status === 'checked_in'))
  }

  const backToGathering = (
    <Button variant="outline" asChild>
      <Link href={`/e/${event.slug}`}>
        <ArrowLeft className="h-4 w-4 mr-2" aria-hidden="true" />
        Back to {event.name}
      </Link>
    </Button>
  )

  if (loading) {
    return (
      <div className="container mx-auto px-5 py-8">
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading tickets">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </div>
    )
  }

  if (!event.ticketingEnabled) {
    return (
      <div className="container mx-auto px-5 py-8">
        <Card>
          <CardContent className="py-12 text-center">
            <Ticket className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="text-xl font-semibold mb-2">Tickets aren’t available here</h1>
            <p className="text-muted-foreground mb-6">Ticket sales are not enabled for this gathering.</p>
            {backToGathering}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-5 py-8">
      <div className="max-w-4xl mx-auto">
        <PageHeader title="Get your ticket" subtitle="Choose the ticket that’s right for you." />

        {error && (
          <div role="alert" className="mb-6 p-4 bg-destructive/10 border border-destructive/20 text-destructive rounded-lg flex items-center gap-2">
            <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {tiers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Ticket className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-xl font-semibold mb-2">No tickets available</h2>
              <p className="text-muted-foreground mb-6">Check back later for ticket sales.</p>
              {backToGathering}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {tiers.map((tier) => {
              const { status, label } = getTierStatus(tier)
              const hasTicket = userHasTicket(tier.id)
              const spotsLeft = tier.quantity_total !== null
                ? Math.max(0, tier.quantity_total - tier.quantity_reserved)
                : null

              return (
                <Card
                  key={tier.id}
                  className={`relative ${status === 'available' ? '' : 'opacity-75'}`}
                >
                  {hasTicket && (
                    <div className="absolute -top-3 -right-3">
                      <Badge variant="success">
                        <Check className="h-3 w-3 mr-1" aria-hidden="true" />
                        Purchased
                      </Badge>
                    </div>
                  )}

                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span>{tier.name}</span>
                      {tier.price_cents === 0 ? (
                        <Badge variant="secondary">Free</Badge>
                      ) : (
                        <span className="text-2xl font-bold">
                          {formatPrice(tier.price_cents, tier.currency)}
                        </span>
                      )}
                    </CardTitle>
                    {tier.description && (
                      <CardDescription>{tier.description}</CardDescription>
                    )}
                  </CardHeader>

                  <CardContent className="space-y-3">
                    {/* Permissions */}
                    <ul className="space-y-2 text-sm">
                      <li className="flex items-center gap-2">
                        <Check className={`h-4 w-4 ${tier.allows_proposals ? 'text-success' : 'text-muted-foreground'}`} aria-hidden="true" />
                        <span className={tier.allows_proposals ? '' : 'text-muted-foreground line-through'}>
                          Propose sessions
                        </span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className={`h-4 w-4 ${tier.allows_voting ? 'text-success' : 'text-muted-foreground'}`} aria-hidden="true" />
                        <span className={tier.allows_voting ? '' : 'text-muted-foreground line-through'}>
                          Vote on sessions
                        </span>
                      </li>
                    </ul>

                    {/* Availability */}
                    {spotsLeft !== null && status === 'available' && (
                      <div className="text-sm text-muted-foreground">
                        {spotsLeft <= 10 ? (
                          <span className="text-signal-amber font-medium">Only {spotsLeft} left</span>
                        ) : (
                          <span>{spotsLeft} available</span>
                        )}
                      </div>
                    )}

                    {status === 'upcoming' && tier.sale_starts_at && (
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-4 w-4" aria-hidden="true" />
                        <span>Sales start {new Date(tier.sale_starts_at).toLocaleDateString()}</span>
                      </div>
                    )}
                  </CardContent>

                  <CardFooter>
                    {hasTicket ? (
                      <Button variant="outline" className="w-full" disabled>
                        <Check className="h-4 w-4 mr-2" aria-hidden="true" />
                        Already purchased
                      </Button>
                    ) : status !== 'available' ? (
                      <Button variant="outline" className="w-full" disabled>
                        {label}
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        onClick={() => handlePurchase(tier)}
                        loading={purchasing === tier.id}
                        disabled={purchasing !== null && purchasing !== tier.id}
                      >
                        {tier.price_cents === 0 ? 'Get a free ticket' : 'Buy a ticket'}
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        )}

        {/* User's tickets */}
        {userTickets.length > 0 && (
          <section className="mt-12" aria-labelledby="your-tickets-heading">
            <h2 id="your-tickets-heading" className="text-xl font-semibold mb-4">Your {plural(userTickets.length, 'ticket').replace(/^\d+\s/, '')}</h2>
            <div className="space-y-4">
              {userTickets.map((ticket) => {
                const tier = tiers.find(t => t.id === ticket.tier_id)
                return (
                  <Card key={ticket.id}>
                    <CardContent className="py-4 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Ticket className="h-5 w-5 shrink-0" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="font-medium truncate">{tier?.name || 'Ticket'}</p>
                          <p className="text-sm text-muted-foreground">
                            Status: {TICKET_STATUS[ticket.status] ?? 'Unknown'}
                          </p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/e/${event.slug}/tickets/${ticket.id}`}>View ticket</Link>
                      </Button>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
