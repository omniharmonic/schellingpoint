'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  DollarSign,
  Ticket,
  Users,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  BarChart3,
  AlertTriangle,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { formatPrice } from '@/lib/payments/format'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

interface RevenueStats {
  totalRevenue: number
  platformFees: number
  netRevenue: number
  totalTickets: number
  confirmedTickets: number
  pendingTickets: number
  checkedIn: number
  refundNeeded: { count: number; amountCents: number }
  currency: string
  tierBreakdown: {
    tierId: string
    tierName: string
    sold: number
    revenue: number
    capacity: number | null
  }[]
  dailySales: {
    date: string
    tickets: number
    revenue: number
  }[]
}

export default function RevenueDashboardPage() {
  const { user } = useAuth()
  const event = useEvent()
  const { isAdmin, isOwner } = useEventRole()

  const [stats, setStats] = React.useState<RevenueStats | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadKey, setReloadKey] = React.useState(0)

  // Only owners and admins can view revenue
  const canViewRevenue = isOwner || isAdmin

  React.useEffect(() => {
    if (!canViewRevenue || !user) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    apiFetch<RevenueStats>(`/api/v1/events/${encodeURIComponent(event.slug)}/admin/ticketing-settings/revenue`)
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Revenue could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [canViewRevenue, event.slug, user, reloadKey])

  if (!canViewRevenue) {
    return (
      <>
        <PageHeader title="Revenue" />
        <Card>
          <CardContent className="py-12 text-center space-y-4">
            <DollarSign className="h-12 w-12 mx-auto text-muted-foreground" aria-hidden="true" />
            <p className="text-muted-foreground">Only owners and admins can see revenue. Ask an owner or admin to change your role.</p>
            <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin`}>Overview & sessions</Link></Button>
          </CardContent>
        </Card>
      </>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" role="status" aria-label="Loading revenue">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !stats) {
    return (
      <>
        <PageHeader title="Revenue" />
        <Card>
          <CardContent className="py-12 text-center space-y-4">
            <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground" aria-hidden="true" />
            <p role="alert" className="text-destructive">{error || 'Revenue could not be loaded.'}</p>
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
          </CardContent>
        </Card>
      </>
    )
  }

  // Calculate comparison (week over week)
  const lastWeekRevenue = stats.dailySales
    .slice(-14, -7)
    .reduce((sum, day) => sum + day.revenue, 0)
  const thisWeekRevenue = stats.dailySales
    .slice(-7)
    .reduce((sum, day) => sum + day.revenue, 0)
  const revenueChange = lastWeekRevenue > 0
    ? ((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue) * 100
    : thisWeekRevenue > 0 ? 100 : 0
  const maxRevenue = Math.max(...stats.dailySales.map((d) => d.revenue), 1)

  return (
    <div>
      <PageHeader
        title="Revenue"
        subtitle="Ticket sales and what reaches you after the platform contribution."
        actions={<Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/tickets`}>Ticket types</Link></Button>}
      />

      <div className="space-y-8">
        {stats.refundNeeded.count > 0 && (
          <Card className="border-destructive">
            <CardContent className="py-4 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" aria-hidden="true" />
              <div>
                <p className="font-medium">
                  {plural(stats.refundNeeded.count, 'payment')} {stats.refundNeeded.count === 1 ? 'needs' : 'need'} a refund ({formatPrice(stats.refundNeeded.amountCents, stats.currency)})
                </p>
                <p className="text-sm text-muted-foreground">
                  These buyers paid after their checkout hold lapsed and the tier had filled, or paid twice. They have no
                  ticket. Refund them from your Stripe dashboard; each is cleared here once Stripe reports the refund.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Gross revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {formatPrice(stats.totalRevenue, stats.currency)}
              </div>
              <p className="text-xs text-muted-foreground flex items-center">
                {revenueChange >= 0 ? (
                  <>
                    <ArrowUpRight className="h-3 w-3 text-success mr-1" aria-hidden="true" />
                    <span className="text-success">+{revenueChange.toFixed(1)}%</span>
                  </>
                ) : (
                  <>
                    <ArrowDownRight className="h-3 w-3 text-destructive mr-1" aria-hidden="true" />
                    <span className="text-destructive">{revenueChange.toFixed(1)}%</span>
                  </>
                )}
                <span className="ml-1">vs last week</span>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Platform contribution</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {formatPrice(stats.platformFees, stats.currency)}
              </div>
              <p className="text-xs text-muted-foreground">
                Recorded at checkout. Stripe processing fees are separate.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net to you</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {formatPrice(stats.netRevenue, stats.currency)}
              </div>
              <p className="text-xs text-muted-foreground">Gross revenue less the platform contribution</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tickets sold</CardTitle>
              <Ticket className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">{stats.confirmedTickets}</div>
              <p className="text-xs text-muted-foreground">
                {stats.pendingTickets > 0 ? `${stats.pendingTickets} pending` : 'None pending'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Checked in</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">{stats.checkedIn}</div>
              <p className="text-xs text-muted-foreground">
                {stats.confirmedTickets > 0
                  ? `${((stats.checkedIn / stats.confirmedTickets) * 100).toFixed(0)}% attendance`
                  : 'No tickets sold yet'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Average ticket price</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {stats.confirmedTickets > 0
                  ? formatPrice(Math.round(stats.totalRevenue / stats.confirmedTickets), stats.currency)
                  : formatPrice(0, stats.currency)
                }
              </div>
              <p className="text-xs text-muted-foreground">per ticket</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sales by ticket type</CardTitle>
            <CardDescription>Tickets sold per type</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats.tierBreakdown.map((tier) => {
                const percentage = tier.capacity
                  ? (tier.sold / tier.capacity) * 100
                  : tier.sold > 0 ? 100 : 0

                return (
                  <div key={tier.tierId} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{tier.tierName}</span>
                        <Badge variant="secondary">
                          {tier.capacity ? `${tier.sold} of ${tier.capacity} sold` : `${tier.sold} sold`}
                        </Badge>
                      </div>
                      <span className="font-semibold tabular-nums">
                        {formatPrice(tier.revenue, stats.currency)}
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden" role="progressbar" aria-label={`${tier.tierName} sold`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(percentage))}>
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${Math.min(100, percentage)}%` }}
                      />
                    </div>
                  </div>
                )
              })}

              {stats.tierBreakdown.length === 0 && (
                <div className="text-center py-4 space-y-3">
                  <p className="text-muted-foreground">No ticket types yet.</p>
                  <Button asChild variant="outline" size="sm"><Link href={`/e/${event.slug}/admin/tickets`}>Create a ticket type</Link></Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sales over time</CardTitle>
            <CardDescription>Last 30 days of ticket sales</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.dailySales.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sales yet.</p>
            ) : (
              <>
                <div className="h-[200px] flex items-end gap-1" role="img" aria-label="Daily ticket revenue for the last 30 days">
                  {stats.dailySales.slice(-30).map((day) => {
                    const height = (day.revenue / maxRevenue) * 100
                    const label = new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })
                    return (
                      <div
                        key={day.date}
                        className={cn('flex-1 bg-primary/20 hover:bg-primary/40 transition-colors rounded-t relative group')}
                        style={{ height: `${Math.max(2, height)}%` }}
                        title={`${label}: ${plural(day.tickets, 'ticket')}, ${formatPrice(day.revenue, stats.currency)}`}
                      >
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                          <div className="bg-popover text-popover-foreground text-xs p-2 rounded-lg border shadow-lg whitespace-nowrap">
                            <p className="font-medium">{label}</p>
                            <p>{plural(day.tickets, 'ticket')}</p>
                            <p>{formatPrice(day.revenue, stats.currency)}</p>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                  <span>{stats.dailySales[0]?.date}</span>
                  <span>{stats.dailySales[stats.dailySales.length - 1]?.date}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
