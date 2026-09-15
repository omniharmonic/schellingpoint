'use client'

import * as React from 'react'
import {
  DollarSign,
  Ticket,
  Users,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  BarChart3,
  Download,
  AlertTriangle,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { formatPrice } from '@/lib/payments/format'
import { apiFetch } from '@/lib/api/client'

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

  // Only owners and admins can view revenue
  const canViewRevenue = isOwner || isAdmin

  React.useEffect(() => {
    if (!canViewRevenue || !user) {
      setLoading(false)
      return
    }
    let cancelled = false
    apiFetch<RevenueStats>(`/api/v1/events/${encodeURIComponent(event.slug)}/admin/ticketing-settings/revenue`)
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load revenue data')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [canViewRevenue, event.slug, user])

  if (!canViewRevenue) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <DollarSign className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">
            Only event owners and admins can view revenue data.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  if (error || !stats) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-xl font-semibold mb-2">Error Loading Data</h2>
          <p className="text-muted-foreground">{error || 'Failed to load revenue data'}</p>
        </CardContent>
      </Card>
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

  return (
      <div className="space-y-8">
        <div className="page-heading">
          <div>
            <h1 className="text-2xl font-display font-bold">Revenue</h1>
            <p className="text-muted-foreground">Track ticket sales and revenue</p>
          </div>
          <Button variant="outline" disabled>
            <Download className="h-4 w-4 mr-2" />
            Export Report
          </Button>
        </div>

        {stats.refundNeeded.count > 0 && (
          <Card className="border-destructive">
            <CardContent className="py-4 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />
              <div>
                <p className="font-medium">
                  {stats.refundNeeded.count} payment{stats.refundNeeded.count === 1 ? '' : 's'} need
                  {stats.refundNeeded.count === 1 ? 's' : ''} a refund ({formatPrice(stats.refundNeeded.amountCents, stats.currency)})
                </p>
                <p className="text-sm text-muted-foreground">
                  These buyers paid after their checkout hold lapsed and the tier had filled, or paid twice. They have no
                  ticket. Refund them from your Stripe dashboard; each is cleared here once Stripe reports the refund.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Summary Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Gross Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatPrice(stats.totalRevenue, stats.currency)}
              </div>
              <p className="text-xs text-muted-foreground flex items-center">
                {revenueChange >= 0 ? (
                  <>
                    <ArrowUpRight className="h-3 w-3 text-green-600 mr-1" />
                    <span className="text-green-600">+{revenueChange.toFixed(1)}%</span>
                  </>
                ) : (
                  <>
                    <ArrowDownRight className="h-3 w-3 text-red-600 mr-1" />
                    <span className="text-red-600">{revenueChange.toFixed(1)}%</span>
                  </>
                )}
                <span className="ml-1">vs last week</span>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Platform Fees</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatPrice(stats.platformFees, stats.currency)}
              </div>
              <p className="text-xs text-muted-foreground">
                5% + $0.50 per paid ticket. Excludes Stripe processing fees.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net to Organizer</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatPrice(stats.netRevenue, stats.currency)}
              </div>
              <p className="text-xs text-muted-foreground">gross revenue less platform fees</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tickets Sold</CardTitle>
              <Ticket className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.confirmedTickets}</div>
              <p className="text-xs text-muted-foreground">
                {stats.pendingTickets > 0 && `${stats.pendingTickets} pending`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Check-Ins</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.checkedIn}</div>
              <p className="text-xs text-muted-foreground">
                {stats.confirmedTickets > 0 && (
                  `${((stats.checkedIn / stats.confirmedTickets) * 100).toFixed(0)}% attendance`
                )}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg. Ticket Price</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stats.confirmedTickets > 0
                  ? formatPrice(Math.round(stats.totalRevenue / stats.confirmedTickets), stats.currency)
                  : formatPrice(0, stats.currency)
                }
              </div>
              <p className="text-xs text-muted-foreground">per ticket</p>
            </CardContent>
          </Card>
        </div>

        {/* Tier Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Sales by Tier</CardTitle>
            <CardDescription>Breakdown of tickets sold per tier</CardDescription>
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
                          {tier.sold}{tier.capacity ? `/${tier.capacity}` : ''} sold
                        </Badge>
                      </div>
                      <span className="font-semibold">
                        {formatPrice(tier.revenue, stats.currency)}
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${Math.min(100, percentage)}%` }}
                      />
                    </div>
                  </div>
                )
              })}

              {stats.tierBreakdown.length === 0 && (
                <p className="text-muted-foreground text-center py-4">
                  No ticket tiers configured yet
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Sales Chart (Simplified) */}
        <Card>
          <CardHeader>
            <CardTitle>Sales Over Time</CardTitle>
            <CardDescription>Last 30 days of ticket sales</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] flex items-end gap-1">
              {stats.dailySales.slice(-30).map((day, index) => {
                const maxRevenue = Math.max(...stats.dailySales.map(d => d.revenue), 1)
                const height = (day.revenue / maxRevenue) * 100

                return (
                  <div
                    key={day.date}
                    className="flex-1 bg-primary/20 hover:bg-primary/40 transition-colors rounded-t cursor-pointer relative group"
                    style={{ height: `${Math.max(2, height)}%` }}
                    title={`${day.date}: ${day.tickets} tickets, ${formatPrice(day.revenue, stats.currency)}`}
                  >
                    {/* Tooltip on hover */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                      <div className="bg-popover text-popover-foreground text-xs p-2 rounded shadow-lg whitespace-nowrap">
                        <p className="font-medium">{new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })}</p>
                        <p>{day.tickets} tickets</p>
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
          </CardContent>
        </Card>
      </div>
  )
}
