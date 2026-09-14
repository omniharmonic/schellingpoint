'use client'

import * as React from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Ticket,
  DollarSign,
  Calendar,
  Users,
  GripVertical,
  Check,
  X,
  CreditCard,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Link2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { useEvent, useEventRole } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { getAccessToken } from '@/lib/supabase/client'
import { formatPrice } from '@/lib/payments/stripe'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

interface TicketTier {
  id: string
  name: string
  description: string | null
  price_cents: number
  currency: string
  quantity_total: number | null
  quantity_sold: number
  sale_starts_at: string | null
  sale_ends_at: string | null
  is_active: boolean
  display_order: number
  allows_proposals: boolean
  allows_voting: boolean
  vote_credits_override: number | null
}

interface ConnectStatus {
  connected: boolean
  accountId: string | null
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsDue: string[]
  disabledReason?: string | null
  platformFallbackAllowed: boolean
  /** Set when Stripe rejected the stored account id (deleted, wrong-mode key). */
  error?: string
  /** Set client-side when the deployment has no STRIPE_SECRET_KEY (API answered 503). */
  unavailable?: boolean
}

/** Turn Stripe requirement keys like `business_profile.url` into readable labels. */
function describeRequirement(key: string): string {
  return key
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!
    .replace(/_/g, ' ')
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Not set'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function AdminTicketsPage() {
  // useSearchParams needs a Suspense boundary to avoid a CSR bailout at build time.
  return (
    <React.Suspense fallback={null}>
      <AdminTicketsPageInner />
    </React.Suspense>
  )
}

function AdminTicketsPageInner() {
  const params = useParams()
  const eventSlug = params.slug as string
  const event = useEvent()
  const { isAdmin, isOwner } = useEventRole()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const stripeReturnParam = searchParams.get('stripe')

  const [tiers, setTiers] = React.useState<TicketTier[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [editingTier, setEditingTier] = React.useState<TicketTier | null>(null)
  const [isCreating, setIsCreating] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)

  // Ticketing settings state
  const [settings, setSettings] = React.useState<{
    ticketing_enabled: boolean
    stripe_account_id: string | null
    platform_stripe_configured: boolean
    webhook_configured: boolean
  } | null>(null)
  const [isTogglingTicketing, setIsTogglingTicketing] = React.useState(false)
  const [ticketingError, setTicketingError] = React.useState<string | null>(null)

  // Stripe Connect state
  const [connect, setConnect] = React.useState<ConnectStatus | null>(null)
  const [isLoadingConnect, setIsLoadingConnect] = React.useState(true)
  const [isConnecting, setIsConnecting] = React.useState(false)
  const [isOpeningDashboard, setIsOpeningDashboard] = React.useState(false)
  const [isDisconnecting, setIsDisconnecting] = React.useState(false)
  const [connectError, setConnectError] = React.useState<string | null>(null)
  const [connectBanner, setConnectBanner] = React.useState<'return' | 'refresh' | null>(null)

  const fetchConnectStatus = React.useCallback(async () => {
    const token = getAccessToken()
    if (!token) return
    setIsLoadingConnect(true)
    try {
      const response = await fetch(`/api/v1/events/${eventSlug}/admin/stripe-connect`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status === 503 || (response.ok && (await response.clone().json())?.unavailable)) {
        setConnect({
          connected: false,
          accountId: null,
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          requirementsDue: [],
          platformFallbackAllowed: false,
          unavailable: true,
        })
        return
      }
      if (response.ok) {
        setConnect(await response.json())
      } else {
        const data = await response.json().catch(() => ({}))
        setConnectError(data.error || 'Failed to load Stripe status')
      }
    } catch (err) {
      console.error('Error fetching Stripe Connect status:', err)
      setConnectError('Failed to load Stripe status')
    } finally {
      setIsLoadingConnect(false)
    }
  }, [eventSlug])

  React.useEffect(() => {
    fetchConnectStatus()
  }, [fetchConnectStatus])

  // Returning from Stripe-hosted onboarding (?stripe=return|refresh): show a
  // banner, re-fetch status, then strip the query param from the URL.
  React.useEffect(() => {
    if (stripeReturnParam !== 'return' && stripeReturnParam !== 'refresh') return
    setConnectBanner(stripeReturnParam)
    fetchConnectStatus()
    router.replace(pathname, { scroll: false })
  }, [stripeReturnParam, fetchConnectStatus, router, pathname])

  const handleConnect = async () => {
    const token = getAccessToken()
    if (!token) return
    setIsConnecting(true)
    setConnectError(null)
    try {
      const response = await fetch(`/api/v1/events/${eventSlug}/admin/stripe-connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.url) {
        window.location.assign(data.url)
        return
      }
      setConnectError(data.error || 'Failed to start Stripe onboarding')
    } catch (err) {
      console.error('Error starting Stripe onboarding:', err)
      setConnectError('Failed to start Stripe onboarding')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleOpenDashboard = async () => {
    const token = getAccessToken()
    if (!token) return
    setIsOpeningDashboard(true)
    setConnectError(null)
    try {
      const response = await fetch(
        `/api/v1/events/${eventSlug}/admin/stripe-connect?action=dashboard`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      )
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer')
      } else {
        setConnectError(data.error || 'Failed to open Stripe dashboard')
      }
    } catch (err) {
      console.error('Error opening Stripe dashboard:', err)
      setConnectError('Failed to open Stripe dashboard')
    } finally {
      setIsOpeningDashboard(false)
    }
  }

  const handleDisconnect = async () => {
    if (
      !confirm(
        'Disconnect this Stripe account? Paid ticket sales will stop until another account is connected. The Stripe account itself is not deleted.',
      )
    ) {
      return
    }
    const token = getAccessToken()
    if (!token) return
    setIsDisconnecting(true)
    setConnectError(null)
    try {
      const response = await fetch(`/api/v1/events/${eventSlug}/admin/stripe-connect`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok) {
        setConnect(data)
        setSettings((prev) =>
          prev
            ? { ...prev, stripe_account_id: null, ticketing_enabled: data.ticketing_enabled }
            : prev,
        )
      } else {
        setConnectError(data.error || 'Failed to disconnect Stripe')
      }
    } catch (err) {
      console.error('Error disconnecting Stripe:', err)
      setConnectError('Failed to disconnect Stripe')
    } finally {
      setIsDisconnecting(false)
    }
  }

  // Fetch ticketing settings
  React.useEffect(() => {
    const fetchSettings = async () => {
      const token = getAccessToken()
      if (!token) return
      try {
        const response = await fetch(
          `/api/v1/events/${eventSlug}/admin/ticketing-settings`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (response.ok) {
          const data = await response.json()
          setSettings(data)
        }
      } catch (err) {
        console.error('Error fetching ticketing settings:', err)
      }
    }
    fetchSettings()
  }, [eventSlug])

  // Paid checkout needs either a connected account that can take charges, or
  // the explicit platform-account fallback. Free-only events may enable
  // ticketing regardless, since free tickets never touch Stripe.
  const hasPaidTiers = tiers.some((t) => t.price_cents > 0)
  const canEnableTicketing =
    !hasPaidTiers ||
    Boolean(connect?.chargesEnabled) ||
    Boolean(connect?.platformFallbackAllowed && !connect?.connected)
  const ticketingBlockedReason = (() => {
    if (!settings || settings.ticketing_enabled || canEnableTicketing) return null
    if (connect?.unavailable) {
      return 'Stripe is not configured on this deployment, so paid tickets cannot be sold. Free tiers still work once all paid tiers are removed or deactivated.'
    }
    if (connect?.connected) {
      return 'Finish Stripe onboarding below before enabling ticket sales. Stripe must be able to accept charges for this account.'
    }
    return 'Connect a Stripe account below before enabling ticket sales. You have paid ticket tiers, and there is no account to receive the money.'
  })()

  const handleToggleTicketing = async () => {
    if (!settings) return
    if (!settings.ticketing_enabled && !canEnableTicketing) return
    const token = getAccessToken()
    if (!token) return

    setIsTogglingTicketing(true)
    setTicketingError(null)
    try {
      const response = await fetch(
        `/api/v1/events/${eventSlug}/admin/ticketing-settings`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ ticketing_enabled: !settings.ticketing_enabled }),
        },
      )
      const data = await response.json().catch(() => ({}))
      if (response.ok) {
        setSettings((prev) => (prev ? { ...prev, ...data } : data))
      } else {
        setTicketingError(data.error || 'Failed to update ticket sales')
      }
    } catch (err) {
      console.error('Error toggling ticketing:', err)
      setTicketingError('Failed to update ticket sales')
    } finally {
      setIsTogglingTicketing(false)
    }
  }

  // Form state
  const [formName, setFormName] = React.useState('')
  const [formDescription, setFormDescription] = React.useState('')
  const [formPrice, setFormPrice] = React.useState('')
  const [formQuantity, setFormQuantity] = React.useState('')
  const [formSaleStarts, setFormSaleStarts] = React.useState('')
  const [formSaleEnds, setFormSaleEnds] = React.useState('')
  const [formAllowsProposals, setFormAllowsProposals] = React.useState(true)
  const [formAllowsVoting, setFormAllowsVoting] = React.useState(true)

  // Fetch tiers on mount
  React.useEffect(() => {
    const fetchTiers = async () => {
      const token = getAccessToken()
      if (!token) return

      try {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/ticket_tiers?event_id=eq.${event.id}&order=display_order`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )

        if (response.ok) {
          const data = await response.json()
          setTiers(data)
        }
      } catch (err) {
        console.error('Error fetching tiers:', err)
      } finally {
        setIsLoading(false)
      }
    }

    fetchTiers()
  }, [event.id])

  const resetForm = () => {
    setFormName('')
    setFormDescription('')
    setFormPrice('')
    setFormQuantity('')
    setFormSaleStarts('')
    setFormSaleEnds('')
    setFormAllowsProposals(true)
    setFormAllowsVoting(true)
  }

  const openCreateForm = () => {
    resetForm()
    setEditingTier(null)
    setIsCreating(true)
  }

  const openEditForm = (tier: TicketTier) => {
    setFormName(tier.name)
    setFormDescription(tier.description || '')
    setFormPrice((tier.price_cents / 100).toString())
    setFormQuantity(tier.quantity_total?.toString() || '')
    setFormSaleStarts(tier.sale_starts_at ? tier.sale_starts_at.slice(0, 16) : '')
    setFormSaleEnds(tier.sale_ends_at ? tier.sale_ends_at.slice(0, 16) : '')
    setFormAllowsProposals(tier.allows_proposals)
    setFormAllowsVoting(tier.allows_voting)
    setEditingTier(tier)
    setIsCreating(true)
  }

  const handleSave = async () => {
    const token = getAccessToken()
    if (!token || !formName.trim()) return

    setIsSaving(true)

    try {
      const tierData = {
        event_id: event.id,
        name: formName.trim(),
        description: formDescription.trim() || null,
        price_cents: Math.round(parseFloat(formPrice || '0') * 100),
        quantity_total: formQuantity ? parseInt(formQuantity) : null,
        sale_starts_at: formSaleStarts || null,
        sale_ends_at: formSaleEnds || null,
        allows_proposals: formAllowsProposals,
        allows_voting: formAllowsVoting,
        display_order: editingTier ? editingTier.display_order : tiers.length,
      }

      if (editingTier) {
        // Update existing
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/ticket_tiers?id=eq.${editingTier.id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify(tierData),
          }
        )

        if (response.ok) {
          const [updated] = await response.json()
          setTiers(prev => prev.map(t => t.id === updated.id ? updated : t))
        }
      } else {
        // Create new
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/ticket_tiers`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify(tierData),
          }
        )

        if (response.ok) {
          const [created] = await response.json()
          setTiers(prev => [...prev, created])
        }
      }

      setIsCreating(false)
      resetForm()
      setEditingTier(null)
    } catch (err) {
      console.error('Error saving tier:', err)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (tierId: string) => {
    if (!confirm('Are you sure you want to delete this ticket tier?')) return

    const token = getAccessToken()
    if (!token) return

    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/ticket_tiers?id=eq.${tierId}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
          },
        }
      )

      if (response.ok) {
        setTiers(prev => prev.filter(t => t.id !== tierId))
      }
    } catch (err) {
      console.error('Error deleting tier:', err)
    }
  }

  const toggleActive = async (tier: TicketTier) => {
    const token = getAccessToken()
    if (!token) return

    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/ticket_tiers?id=eq.${tier.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({ is_active: !tier.is_active }),
        }
      )

      if (response.ok) {
        const [updated] = await response.json()
        setTiers(prev => prev.map(t => t.id === updated.id ? updated : t))
      }
    } catch (err) {
      console.error('Error toggling tier:', err)
    }
  }

  if (!isAdmin) {
    return (
      <p className="text-muted-foreground">You don&apos;t have permission to view this page.</p>
    )
  }

  return (
        <div className="space-y-6">
          {/* Header */}
          <div className="page-heading">
            <div>
              <h1 className="text-2xl font-display font-bold">Tickets</h1>
              <p className="text-muted-foreground mt-1">
                Configure ticket types and pricing
              </p>
            </div>
            <Button onClick={openCreateForm}>
              <Plus className="h-4 w-4 mr-2" />
              Add Tier
            </Button>
          </div>

          {/* Ticketing Settings */}
          {settings && (
            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-primary/10 mt-0.5">
                      <CreditCard className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium">Ticket sales</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {settings.ticketing_enabled
                          ? 'Attendees can purchase tickets from the public tickets page.'
                          : 'Ticket sales are disabled. Enable to let attendees buy tickets.'}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant={settings.ticketing_enabled ? 'outline' : 'default'}
                    size="sm"
                    onClick={handleToggleTicketing}
                    disabled={
                      isTogglingTicketing ||
                      (!settings.ticketing_enabled && (isLoadingConnect || !canEnableTicketing))
                    }
                    title={ticketingBlockedReason ?? undefined}
                  >
                    {isTogglingTicketing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : settings.ticketing_enabled ? (
                      'Disable'
                    ) : (
                      'Enable ticketing'
                    )}
                  </Button>
                </div>

                {ticketingBlockedReason && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{ticketingBlockedReason}</AlertDescription>
                  </Alert>
                )}

                {ticketingError && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{ticketingError}</AlertDescription>
                  </Alert>
                )}

                {/* Stripe status */}
                {settings.ticketing_enabled && !settings.platform_stripe_configured && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Stripe isn&apos;t configured on this deployment. Set{' '}
                      <code className="text-xs">STRIPE_SECRET_KEY</code> (and{' '}
                      <code className="text-xs">STRIPE_WEBHOOK_SECRET</code>) in
                      environment variables before accepting paid tickets. Free
                      tickets still work.
                    </AlertDescription>
                  </Alert>
                )}

                {settings.ticketing_enabled &&
                  settings.platform_stripe_configured &&
                  !settings.webhook_configured && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        Stripe webhooks are not configured. Set{' '}
                        <code className="text-xs">STRIPE_WEBHOOK_SECRET</code> and
                        point Stripe at <code className="text-xs">/api/webhooks/stripe</code>{' '}
                        so purchases are automatically confirmed.
                      </AlertDescription>
                    </Alert>
                  )}

              </CardContent>
            </Card>
          )}

          {/* Payments (Stripe Connect) */}
          <Card>
            <CardContent className="py-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'p-2 rounded-lg mt-0.5',
                      connect?.chargesEnabled ? 'bg-green-500/10' : 'bg-primary/10',
                    )}
                  >
                    {connect?.chargesEnabled ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                    ) : (
                      <Link2 className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">Payments</h3>
                      {isLoadingConnect ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : connect?.unavailable ? (
                        <Badge variant="secondary">Stripe not configured</Badge>
                      ) : !connect?.connected ? (
                        <Badge variant="secondary">Not connected</Badge>
                      ) : connect.chargesEnabled ? (
                        <Badge variant="outline" className="text-green-600">Ready</Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-600">Onboarding incomplete</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {connect?.unavailable
                        ? 'This deployment has no Stripe secret key, so accounts cannot be connected.'
                        : !connect?.connected
                          ? connect?.platformFallbackAllowed
                            ? 'No Stripe account connected. Paid tickets are charged to the platform account until you connect your own.'
                            : 'Connect a Stripe account to receive ticket revenue. Payouts go straight to you; the platform keeps 5% + $0.50 per paid ticket.'
                          : connect.chargesEnabled
                            ? `Connected to ${connect.accountId}. Ticket revenue is paid out to this account${connect.payoutsEnabled ? '' : ' once payouts are enabled'}.`
                            : `Account ${connect.accountId} was created but Stripe still needs information before it can accept charges.`}
                    </p>
                  </div>
                </div>

                {!connect?.unavailable && (
                  <div className="flex flex-wrap items-center gap-2">
                    {connect?.connected && connect.chargesEnabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleOpenDashboard}
                        disabled={isOpeningDashboard}
                      >
                        {isOpeningDashboard ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <ExternalLink className="h-4 w-4 mr-2" />
                            Open Stripe dashboard
                          </>
                        )}
                      </Button>
                    )}
                    {(!connect?.connected || !connect.chargesEnabled) && (
                      <Button size="sm" onClick={handleConnect} disabled={isConnecting || isLoadingConnect}>
                        {isConnecting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : connect?.connected ? (
                          'Continue onboarding'
                        ) : (
                          'Connect Stripe'
                        )}
                      </Button>
                    )}
                    {connect?.connected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={fetchConnectStatus}
                        disabled={isLoadingConnect}
                        title="Refresh status"
                      >
                        <RefreshCw className={cn('h-4 w-4', isLoadingConnect && 'animate-spin')} />
                      </Button>
                    )}
                    {connect?.connected && isOwner && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleDisconnect}
                        disabled={isDisconnecting}
                        className="text-destructive hover:text-destructive"
                      >
                        {isDisconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Disconnect'}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {connectBanner === 'return' && (
                <Alert>
                  {connect?.chargesEnabled ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertTriangle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {isLoadingConnect
                      ? 'Checking your Stripe account...'
                      : connect?.chargesEnabled
                        ? 'Stripe onboarding complete. Your account can accept payments.'
                        : 'Welcome back from Stripe. Onboarding is not finished yet; see the outstanding requirements below.'}
                  </AlertDescription>
                </Alert>
              )}

              {connectBanner === 'refresh' && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    The Stripe onboarding link expired or was already used. Click
                    &quot;Continue onboarding&quot; to get a fresh one.
                  </AlertDescription>
                </Alert>
              )}

              {connect?.error && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Stripe could not load account {connect.accountId}: {connect.error}. If it was
                    deleted or belongs to a different Stripe mode, disconnect and connect again.
                  </AlertDescription>
                </Alert>
              )}

              {connectError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{connectError}</AlertDescription>
                </Alert>
              )}

              {connect?.connected && !connect.chargesEnabled && connect.requirementsDue.length > 0 && (
                <div className="text-sm">
                  <p className="text-muted-foreground mb-1">Stripe still needs:</p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {connect.requirementsDue.slice(0, 8).map((req) => (
                      <li key={req} className="capitalize">{describeRequirement(req)}</li>
                    ))}
                    {connect.requirementsDue.length > 8 && (
                      <li className="text-muted-foreground">
                        and {connect.requirementsDue.length - 8} more
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {connect?.connected && connect.chargesEnabled && !connect.payoutsEnabled && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Charges are enabled but payouts are not yet. Ticket revenue will accumulate in
                    Stripe until payouts are enabled from the Stripe dashboard.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Stats */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Ticket className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {tiers.reduce((sum, t) => sum + t.quantity_sold, 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Tickets Sold</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-green-500/10">
                    <DollarSign className="h-5 w-5 text-green-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {formatPrice(
                        tiers.reduce((sum, t) => sum + (t.quantity_sold * t.price_cents), 0),
                        'usd'
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">Total Revenue</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10">
                    <Users className="h-5 w-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{tiers.filter(t => t.is_active).length}</p>
                    <p className="text-sm text-muted-foreground">Active Tiers</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Create/Edit Form */}
          {isCreating && (
            <Card>
              <CardHeader>
                <CardTitle>{editingTier ? 'Edit Tier' : 'Create Tier'}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Name *</label>
                    <Input
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="e.g., Early Bird, General Admission"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Price (USD)</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formPrice}
                      onChange={(e) => setFormPrice(e.target.value)}
                      placeholder="0.00 (free)"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">Description</label>
                    <Input
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      placeholder="What's included with this ticket?"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Quantity (leave blank for unlimited)</label>
                    <Input
                      type="number"
                      min="1"
                      value={formQuantity}
                      onChange={(e) => setFormQuantity(e.target.value)}
                      placeholder="Unlimited"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Sale Starts</label>
                    <Input
                      type="datetime-local"
                      value={formSaleStarts}
                      onChange={(e) => setFormSaleStarts(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Sale Ends</label>
                    <Input
                      type="datetime-local"
                      value={formSaleEnds}
                      onChange={(e) => setFormSaleEnds(e.target.value)}
                    />
                  </div>
                  <div className="space-y-3 md:col-span-2">
                    <label className="text-sm font-medium">Permissions</label>
                    <div className="flex gap-6">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formAllowsProposals}
                          onChange={(e) => setFormAllowsProposals(e.target.checked)}
                          className="rounded"
                        />
                        <span className="text-sm">Can propose sessions</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formAllowsVoting}
                          onChange={(e) => setFormAllowsVoting(e.target.checked)}
                          className="rounded"
                        />
                        <span className="text-sm">Can vote on sessions</span>
                      </label>
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-6">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsCreating(false)
                      resetForm()
                      setEditingTier(null)
                    }}
                  >
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={isSaving || !formName.trim()}>
                    {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {editingTier ? 'Save Changes' : 'Create Tier'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Tiers List */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : tiers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Ticket className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <h2 className="text-lg font-semibold mb-2">No ticket tiers yet</h2>
                <p className="text-muted-foreground mb-4">
                  Create your first ticket tier to start selling tickets.
                </p>
                <Button onClick={openCreateForm}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create First Tier
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {tiers.map((tier) => (
                <Card
                  key={tier.id}
                  className={cn(!tier.is_active && 'opacity-60')}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center gap-4">
                      <div className="cursor-grab text-muted-foreground">
                        <GripVertical className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{tier.name}</h3>
                          {!tier.is_active && (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                          {tier.price_cents === 0 && (
                            <Badge variant="outline" className="text-green-600">Free</Badge>
                          )}
                        </div>
                        {tier.description && (
                          <p className="text-sm text-muted-foreground mt-0.5">{tier.description}</p>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {formatPrice(tier.price_cents, tier.currency)}
                          </span>
                          <span>
                            {tier.quantity_sold}
                            {tier.quantity_total ? ` / ${tier.quantity_total}` : ''} sold
                          </span>
                          {tier.sale_starts_at && (
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {formatDate(tier.sale_starts_at)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleActive(tier)}
                          title={tier.is_active ? 'Deactivate' : 'Activate'}
                        >
                          {tier.is_active ? (
                            <X className="h-4 w-4" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditForm(tier)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(tier.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
  )
}
