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
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { PageHeader } from '@/components/PageHeader'

import { useEvent, useEventRole } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { apiFetch, ApiError } from '@/lib/api/client'
import { formatPrice, MAX_CONTRIBUTION_PERCENT } from '@/lib/payments/format'

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

interface Sale {
  ticketId: string
  status: string
  attendee: string | null
  handle: string | null
  tierName: string | null
  amountCents: number
  currency: string
  contributionCents: number
  refundedCents: number
  contributionRefundedCents: number
  settledAt: string | null
  refundable: boolean
}

/** Turn Stripe requirement keys like `business_profile.url` into readable labels. */
function describeRequirement(key: string): string {
  return key
    .replace(/\[\d+\]/g, '')
    .split('.')
    .pop()!
    .replace(/_/g, ' ')
}

/** ISO timestamp → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** <input type="datetime-local"> value (browser time zone) → ISO timestamp, or null. */
function fromLocalInput(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const CONNECT_UNAVAILABLE: ConnectStatus = {
  connected: false,
  accountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: [],
  platformFallbackAllowed: false,
  unavailable: true,
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
    platform_fee_percent: number
    /** The server's own readiness verdict; the browser checks below only mirror it. */
    payments_ready?: boolean
    payments_blocked_code?: string | null
    payments_blocked_reason?: string | null
  } | null>(null)
  const [isTogglingTicketing, setIsTogglingTicketing] = React.useState(false)
  const [contributionSaved, setContributionSaved] = React.useState(false)
  const [ticketingError, setTicketingError] = React.useState<string | null>(null)

  // Sales & refunds
  const [sales, setSales] = React.useState<Sale[] | null>(null)
  const [salesError, setSalesError] = React.useState<string | null>(null)
  const [refundingTicketId, setRefundingTicketId] = React.useState<string | null>(null)
  const [refundAmount, setRefundAmount] = React.useState('')
  const [refundContribution, setRefundContribution] = React.useState(true)
  const [refundBusy, setRefundBusy] = React.useState(false)
  const [refundNotice, setRefundNotice] = React.useState<string | null>(null)

  // Stripe Connect state
  const [connect, setConnect] = React.useState<ConnectStatus | null>(null)
  const [isLoadingConnect, setIsLoadingConnect] = React.useState(true)
  const [isConnecting, setIsConnecting] = React.useState(false)
  const [isOpeningDashboard, setIsOpeningDashboard] = React.useState(false)
  const [isDisconnecting, setIsDisconnecting] = React.useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)
  const [confirmDeleteTierId, setConfirmDeleteTierId] = React.useState<string | null>(null)
  const [connectError, setConnectError] = React.useState<string | null>(null)
  const [connectBanner, setConnectBanner] = React.useState<'return' | 'refresh' | null>(null)

  const apiBase = `/api/v1/events/${encodeURIComponent(eventSlug)}/admin`

  const fetchConnectStatus = React.useCallback(async () => {
    setIsLoadingConnect(true)
    try {
      const data = await apiFetch<ConnectStatus>(`${apiBase}/stripe-connect`)
      setConnect(data.unavailable ? CONNECT_UNAVAILABLE : data)
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setConnect(CONNECT_UNAVAILABLE)
      } else {
        setConnectError(err instanceof Error ? err.message : 'Failed to load Stripe status')
      }
    } finally {
      setIsLoadingConnect(false)
    }
  }, [apiBase])

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
    setIsConnecting(true)
    setConnectError(null)
    try {
      const data = await apiFetch<{ url?: string }>(`${apiBase}/stripe-connect`, { method: 'POST' })
      if (data.url) {
        window.location.assign(data.url)
        return
      }
      setConnectError('Failed to start Stripe onboarding')
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to start Stripe onboarding')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleOpenDashboard = async () => {
    setIsOpeningDashboard(true)
    setConnectError(null)
    try {
      const data = await apiFetch<{ url?: string }>(`${apiBase}/stripe-connect?action=dashboard`, { method: 'POST' })
      if (data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer')
      } else {
        setConnectError('Failed to open Stripe dashboard')
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to open Stripe dashboard')
    } finally {
      setIsOpeningDashboard(false)
    }
  }

  const handleDisconnect = async () => {
    setIsDisconnecting(true)
    setConnectError(null)
    try {
      const data = await apiFetch<ConnectStatus & { ticketing_enabled: boolean }>(`${apiBase}/stripe-connect`, {
        method: 'DELETE',
      })
      setConnect(data)
      setSettings((prev) =>
        prev ? { ...prev, stripe_account_id: null, ticketing_enabled: data.ticketing_enabled } : prev,
      )
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to disconnect Stripe')
    } finally {
      setIsDisconnecting(false)
      setConfirmDisconnect(false)
    }
  }

  const fetchSales = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ sales: Sale[] }>(`${apiBase}/ticketing-settings/sales`)
      setSales(data.sales)
      setSalesError(null)
    } catch (err) {
      setSalesError(err instanceof Error ? err.message : 'Sales could not be loaded')
    }
  }, [apiBase])

  React.useEffect(() => {
    fetchSales()
  }, [fetchSales])

  /**
   * A refund is issued on the organizer's own Stripe account. Leaving the amount blank
   * returns everything still outstanding and cancels the ticket; an amount returns part of
   * the price and leaves admission alone.
   */
  const submitRefund = async (sale: Sale) => {
    setRefundBusy(true)
    setRefundNotice(null)
    try {
      const partial = refundAmount.trim() !== ''
      const amountCents = partial ? Math.round(Number(refundAmount) * 100) : null
      if (partial && (!Number.isFinite(amountCents) || (amountCents ?? 0) <= 0)) {
        throw new Error('Enter an amount greater than zero, or leave it blank to refund everything')
      }
      const result = await apiFetch<{ amountCents: number; full: boolean; admissionRevoked: boolean }>(
        `${apiBase}/ticketing-settings/sales/${sale.ticketId}/refund`,
        { method: 'POST', json: { amountCents, refundApplicationFee: partial ? refundContribution : true } },
      )
      setRefundNotice(
        result.full
          ? `Refunded ${formatPrice(result.amountCents, sale.currency)} in full. The ticket no longer admits its holder, and they have been told.`
          : `Refunded ${formatPrice(result.amountCents, sale.currency)}. The ticket still admits its holder.`,
      )
      setRefundingTicketId(null)
      setRefundAmount('')
      await fetchSales()
    } catch (err) {
      setSalesError(err instanceof Error ? err.message : 'The refund could not be issued')
    } finally {
      setRefundBusy(false)
    }
  }

  // Fetch ticketing settings
  React.useEffect(() => {
    apiFetch<NonNullable<typeof settings>>(`${apiBase}/ticketing-settings`)
      .then(setSettings)
      .catch(() => setTicketingError('Failed to load ticketing settings'))
  }, [apiBase])

  // Paid checkout needs either a connected account that can take charges, or
  // the explicit platform-account fallback. Free-only events may enable
  // ticketing regardless, since free tickets never touch Stripe.
  // The server decides (ticketing-settings refuses the write with a reason); this mirrors that
  // verdict so the button explains itself before the request is made. `payments_ready` is
  // authoritative when present; the connect-status checks are the fallback while it loads.
  const hasPaidTiers = tiers.some((t) => t.price_cents > 0)
  const canEnableTicketing =
    settings?.payments_ready !== undefined
      ? settings.payments_ready
      : !hasPaidTiers ||
        Boolean(connect?.chargesEnabled && connect?.payoutsEnabled) ||
        Boolean(connect?.platformFallbackAllowed && !connect?.connected)
  const ticketingBlockedReason = (() => {
    if (!settings || settings.ticketing_enabled || canEnableTicketing) return null
    if (settings.payments_blocked_reason) return settings.payments_blocked_reason
    if (connect?.unavailable) {
      return 'Stripe is not configured on this deployment, so paid tickets cannot be sold. Free tiers still work once all paid tiers are removed or deactivated.'
    }
    if (connect?.connected) {
      return 'Finish Stripe onboarding below before enabling ticket sales. Stripe must be able to accept charges and payouts for this account.'
    }
    return 'Connect a Stripe account below before enabling ticket sales. You have paid ticket tiers, and there is no account to receive the money.'
  })()

  const handleToggleTicketing = async () => {
    if (!settings) return
    if (!settings.ticketing_enabled && !canEnableTicketing) return
    setIsTogglingTicketing(true)
    setTicketingError(null)
    try {
      const data = await apiFetch<NonNullable<typeof settings>>(`${apiBase}/ticketing-settings`, {
        method: 'POST',
        json: { ticketing_enabled: !settings.ticketing_enabled },
      })
      setSettings((prev) => (prev ? { ...prev, ...data } : data))
    } catch (err) {
      setTicketingError(err instanceof Error ? err.message : 'Failed to update ticket sales')
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
  const [tierError, setTierError] = React.useState<string | null>(null)

  // Fetch tiers on mount
  React.useEffect(() => {
    apiFetch<{ tiers: TicketTier[] }>(`${apiBase}/ticketing-settings/tiers`)
      .then((data) => setTiers(data.tiers))
      .catch((err) => setTierError(err instanceof Error ? err.message : 'Failed to load ticket tiers'))
      .finally(() => setIsLoading(false))
  }, [apiBase])

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
    setFormSaleStarts(toLocalInput(tier.sale_starts_at))
    setFormSaleEnds(toLocalInput(tier.sale_ends_at))
    setFormAllowsProposals(tier.allows_proposals)
    setFormAllowsVoting(tier.allows_voting)
    setEditingTier(tier)
    setIsCreating(true)
  }

  const handleSave = async () => {
    if (!formName.trim()) return

    setIsSaving(true)
    setTierError(null)

    try {
      const tierData = {
        name: formName.trim(),
        description: formDescription.trim() || null,
        price_cents: Math.round(parseFloat(formPrice || '0') * 100),
        quantity_total: formQuantity ? parseInt(formQuantity, 10) : null,
        sale_starts_at: fromLocalInput(formSaleStarts),
        sale_ends_at: fromLocalInput(formSaleEnds),
        allows_proposals: formAllowsProposals,
        allows_voting: formAllowsVoting,
      }

      if (editingTier) {
        const { tier: updated } = await apiFetch<{ tier: TicketTier }>(
          `${apiBase}/ticketing-settings/tiers/${editingTier.id}`,
          { method: 'PATCH', json: tierData },
        )
        setTiers(prev => prev.map(t => t.id === updated.id ? updated : t))
      } else {
        const { tier: created } = await apiFetch<{ tier: TicketTier }>(`${apiBase}/ticketing-settings/tiers`, {
          method: 'POST',
          json: { ...tierData, display_order: tiers.length },
        })
        setTiers(prev => [...prev, created])
      }

      setIsCreating(false)
      resetForm()
      setEditingTier(null)
    } catch (err) {
      setTierError(err instanceof Error ? err.message : 'Failed to save tier')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (tierId: string) => {
    setTierError(null)
    try {
      await apiFetch(`${apiBase}/ticketing-settings/tiers/${tierId}`, { method: 'DELETE' })
      setTiers(prev => prev.filter(t => t.id !== tierId))
    } catch (err) {
      setTierError(err instanceof Error ? err.message : 'The ticket type could not be deleted.')
    } finally {
      setConfirmDeleteTierId(null)
    }
  }

  const toggleActive = async (tier: TicketTier) => {
    setTierError(null)
    try {
      const { tier: updated } = await apiFetch<{ tier: TicketTier }>(
        `${apiBase}/ticketing-settings/tiers/${tier.id}`,
        { method: 'PATCH', json: { is_active: !tier.is_active } },
      )
      setTiers(prev => prev.map(t => t.id === updated.id ? updated : t))
    } catch (err) {
      setTierError(err instanceof Error ? err.message : 'Failed to update tier')
    }
  }

  if (!isAdmin) {
    return (
      <p className="text-muted-foreground">You don&apos;t have permission to view this page.</p>
    )
  }

  return (
        <div className="space-y-6">
          <PageHeader
            title="Tickets"
            subtitle="Set admission, ticket types and your contribution."
            actions={(
              <Button onClick={openCreateForm} disabled={isCreating}>
                <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                Add ticket type
              </Button>
            )}
          />

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
                          ? 'Attendees need a valid ticket to participate. Offer free passes or paid tickets.'
                          : 'Ticket admission is off. Eligible attendees can join without a ticket.'}
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

                <form className="rounded-xl border bg-muted/30 p-4 space-y-3" onSubmit={async (event) => {
                  event.preventDefault()
                  const form = new FormData(event.currentTarget)
                  setIsSaving(true)
                  setTicketingError(null)
                  setContributionSaved(false)
                  try {
                    const response = await fetch(`/api/v1/events/${eventSlug}/admin/ticketing-settings`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ platform_fee_percent: Number(form.get('contribution')) }),
                    })
                    const data = await response.json()
                    if (!response.ok) throw new Error(data.error || 'Contribution could not be saved')
                    setSettings(data)
                    setContributionSaved(true)
                  } catch (error) { setTicketingError(error instanceof Error ? error.message : 'Contribution could not be saved') }
                  finally { setIsSaving(false) }
                }}>
                  {contributionSaved && <p role="status" className="text-sm text-primary">Contribution saved. Applies to new checkouts.</p>}
                  <Label htmlFor="platform-contribution">Your contribution to unconference</Label>
                  <p className="text-sm text-muted-foreground">
                    Choose what this gathering gives back: a percentage of each paid ticket, minimum 1%, with no fixed
                    platform surcharge and nothing added to the buyer&apos;s price. Free tickets stay free.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Up to {MAX_CONTRIBUTION_PERCENT}%. This is separate from Stripe&apos;s processing fees. Ticket money
                    is charged on your own Stripe account: Stripe takes its processing fee there, and unconference takes
                    only the percentage you set here. On a $25 ticket at 1% the contribution is $0.25.
                  </p>
                  {settings.platform_fee_percent > MAX_CONTRIBUTION_PERCENT && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        This gathering is set to {settings.platform_fee_percent}%, above the {MAX_CONTRIBUTION_PERCENT}%
                        ceiling. New checkouts contribute {MAX_CONTRIBUTION_PERCENT}% of the ticket price; lower it to
                        the figure you mean.
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <Input key={settings.platform_fee_percent} id="platform-contribution" name="contribution" type="number" min="1" max={MAX_CONTRIBUTION_PERCENT} step="0.01" required defaultValue={settings.platform_fee_percent} className="w-24" />
                    <span className="text-sm">% of ticket sales</span>
                    <Button type="submit" variant="outline" disabled={isSaving}>Save contribution</Button>
                  </div>
                </form>

                {/* Stripe status */}
                {settings.ticketing_enabled && !settings.platform_stripe_configured && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Paid ticket sales are not available yet. Free tickets still work;
                      contact the platform team to activate payments.
                    </AlertDescription>
                  </Alert>
                )}

                {settings.ticketing_enabled &&
                  settings.platform_stripe_configured &&
                  !settings.webhook_configured && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        Payment confirmation is not ready yet, so paid checkout is paused.
                        Contact the platform team to finish activating payments.
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
                      connect?.chargesEnabled ? 'bg-success/10' : 'bg-primary/10',
                    )}
                  >
                    {connect?.chargesEnabled ? (
                      <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
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
                        <Badge variant="secondary">Payments unavailable</Badge>
                      ) : !connect?.connected ? (
                        <Badge variant="secondary">Not connected</Badge>
                      ) : connect.chargesEnabled ? (
                        <Badge variant="success">Ready</Badge>
                      ) : (
                        <Badge variant="amber">Onboarding incomplete</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {connect?.unavailable
                        ? 'Paid ticket sales are not available yet. You can set up ticket types and offer free passes now.'
                        : !connect?.connected
                          ? connect?.platformFallbackAllowed
                            ? 'No Stripe account connected. Paid tickets are charged to the platform account until you connect your own.'
                            : 'Connect a Stripe account to sell tickets. Buyers are charged on your account, Stripe deducts its processing fees there, and unconference receives only the contribution you chose.'
                          : connect.chargesEnabled
                            ? `Connected to ${connect.accountId}. Tickets are charged on this account and paid out to it${connect.payoutsEnabled ? '' : ' once payouts are enabled'}.`
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
                          <Loader2 className="h-4 w-4 animate-spin" aria-label="Opening" />
                        ) : (
                          <>
                            <ExternalLink className="h-4 w-4 mr-2" aria-hidden="true" />
                            Open Stripe dashboard
                          </>
                        )}
                      </Button>
                    )}
                    {(!connect?.connected || !connect.chargesEnabled) && (
                      <Button size="sm" onClick={handleConnect} disabled={isConnecting || isLoadingConnect}>
                        {isConnecting ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-label="Connecting" />
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
                        aria-label="Refresh Stripe status"
                        title="Refresh status"
                      >
                        <RefreshCw className={cn('h-4 w-4', isLoadingConnect && 'animate-spin')} aria-hidden="true" />
                      </Button>
                    )}
                    {connect?.connected && isOwner && !confirmDisconnect && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDisconnect(true)}
                        disabled={isDisconnecting}
                        className="text-destructive hover:text-destructive"
                      >
                        Disconnect
                      </Button>
                    )}
                  </div>
                )}
                {confirmDisconnect && (
                  <ConfirmInline
                    destructive
                    message="Disconnect this Stripe account? Paid ticket sales stop until another account is connected. The Stripe account itself is not deleted."
                    confirmLabel="Disconnect"
                    loading={isDisconnecting}
                    onConfirm={() => void handleDisconnect()}
                    onCancel={() => setConfirmDisconnect(false)}
                  />
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
                      ? 'Checking your Stripe account…'
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

          {/* Sales & refunds */}
          {sales !== null && sales.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Paid sales</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Every settled paid checkout. A refund is issued on your own Stripe account. Refunding the whole
                  amount cancels the ticket and returns your contribution with it; refunding part of it returns only
                  that part and the holder keeps their ticket.
                </p>
                {refundNotice && (
                  <Alert>
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertDescription>{refundNotice}</AlertDescription>
                  </Alert>
                )}
                {salesError && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{salesError}</AlertDescription>
                  </Alert>
                )}
                <ul className="divide-y rounded-xl border">
                  {sales.map((sale) => (
                    <li key={sale.ticketId} className="p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {sale.attendee?.trim() || sale.handle || 'Attendee'}
                            {sale.tierName ? <span className="text-muted-foreground"> · {sale.tierName}</span> : null}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatPrice(sale.amountCents, sale.currency)} paid
                            {sale.contributionCents > 0 && <> · {formatPrice(sale.contributionCents, sale.currency)} contribution</>}
                            {sale.refundedCents > 0 && <> · {formatPrice(sale.refundedCents, sale.currency)} refunded</>}
                            {sale.settledAt ? ` · ${formatDate(sale.settledAt)}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={sale.status === 'cancelled' ? 'secondary' : sale.status === 'checked_in' ? 'success' : 'outline'}>
                            {sale.status.replace(/_/g, ' ')}
                          </Badge>
                          {sale.refundable && refundingTicketId !== sale.ticketId && (
                            <Button variant="outline" size="sm" onClick={() => {
                              setRefundingTicketId(sale.ticketId)
                              setRefundAmount('')
                              setRefundContribution(true)
                              setRefundNotice(null)
                              setSalesError(null)
                            }}>
                              Refund
                            </Button>
                          )}
                        </div>
                      </div>
                      {refundingTicketId === sale.ticketId && (
                        <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div className="space-y-1">
                              <Label htmlFor={`refund-${sale.ticketId}`} className="text-xs">Amount (blank = everything left)</Label>
                              <Input
                                id={`refund-${sale.ticketId}`}
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder={((sale.amountCents - sale.refundedCents) / 100).toFixed(2)}
                                value={refundAmount}
                                onChange={(e) => setRefundAmount(e.target.value)}
                                className="w-32"
                              />
                            </div>
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={refundAmount.trim() === '' ? true : refundContribution}
                                disabled={refundAmount.trim() === ''}
                                onChange={(e) => setRefundContribution(e.target.checked)}
                              />
                              Return the unconference contribution too
                            </label>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {refundAmount.trim() === ''
                              ? 'A full refund returns the contribution as well and cancels the ticket. The holder is notified.'
                              : 'A partial refund leaves the ticket valid. Stripe processing fees are not returned by any refund.'}
                          </p>
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => void submitRefund(sale)} disabled={refundBusy}>
                              {refundBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Refunding" /> : 'Issue refund'}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setRefundingTicketId(null)} disabled={refundBusy}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Stats */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
                    <p className="text-sm text-muted-foreground">Tickets sold</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-success/10">
                    <DollarSign className="h-5 w-5 text-success" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {formatPrice(
                        tiers.reduce((sum, t) => sum + (t.quantity_sold * t.price_cents), 0),
                        tiers[0]?.currency || 'usd'
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">Total revenue</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Users className="h-5 w-5 text-primary" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{tiers.filter(t => t.is_active).length}</p>
                    <p className="text-sm text-muted-foreground">Active ticket types</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {tierError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{tierError}</AlertDescription>
            </Alert>
          )}

          {/* Create/Edit Form */}
          {isCreating && (
            <Card>
              <CardHeader>
                <CardTitle>{editingTier ? 'Edit ticket type' : 'New ticket type'}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="tier-name">Name</Label>
                    <Input
                      id="tier-name"
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
                  <Button onClick={handleSave} loading={isSaving} disabled={!formName.trim()}>
                    {editingTier ? 'Save changes' : 'Create ticket type'}
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
                <h2 className="text-lg font-semibold mb-2">Your first ticket type</h2>
                <p className="text-muted-foreground mb-4">
                  Offer a free pass or a paid ticket, and choose the participation rights it includes.
                </p>
                <Button onClick={openCreateForm}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create ticket type
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
                            <Badge variant="success">Free</Badge>
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
                      {confirmDeleteTierId !== tier.id && (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => toggleActive(tier)}
                            aria-label={tier.is_active ? `Deactivate ${tier.name}` : `Activate ${tier.name}`}
                            title={tier.is_active ? 'Deactivate' : 'Activate'}
                          >
                            {tier.is_active ? (
                              <X className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Check className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openEditForm(tier)}
                            aria-label={`Edit ${tier.name}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setConfirmDeleteTierId(tier.id)}
                            className="text-destructive hover:text-destructive"
                            aria-label={`Delete ${tier.name}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {confirmDeleteTierId === tier.id && (
                      <ConfirmInline
                        layout="inline"
                        destructive
                        className="mt-3"
                        message={`Delete “${tier.name}”?${tier.quantity_sold > 0 ? ` ${tier.quantity_sold} people already hold this ticket.` : ''}`}
                        confirmLabel="Delete"
                        onConfirm={() => void handleDelete(tier.id)}
                        onCancel={() => setConfirmDeleteTierId(null)}
                      />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
  )
}
