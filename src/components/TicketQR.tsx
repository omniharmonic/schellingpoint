'use client'

import * as React from 'react'
import { Loader2, QrCode as QrCodeIcon, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'

/**
 * The holder's check-in QR code. The code is a short-lived token bound to the holder's
 * account, so it is fetched fresh and refreshed automatically before it expires; a
 * screenshot or download would stop working, so none is offered.
 */

interface TicketQRProps {
  /** Ticket ID to fetch QR for */
  ticketId: string
  /** Event slug for API calls */
  eventSlug: string
  /** Ticket tier name */
  tierName?: string
  /** Event name */
  eventName?: string
  /** Custom class name */
  className?: string
  /** Size of QR code */
  size?: 'sm' | 'md' | 'lg'
}

const SIZES = {
  sm: 150,
  md: 250,
  lg: 350,
}

/** Refresh this long before expiry (and at least every minute when the tab returns). */
const REFRESH_MARGIN_MS = 2 * 60 * 1000

export function TicketQR({ ticketId, eventSlug, tierName, eventName, className, size = 'md' }: TicketQRProps) {
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null)
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const qrSize = SIZES[size]

  const fetchQR = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ qrDataUrl: string; expiresAt: string }>(
        `/api/v1/events/${encodeURIComponent(eventSlug)}/tickets/${encodeURIComponent(ticketId)}/qr`,
      )
      setQrDataUrl(data.qrDataUrl)
      setExpiresAt(new Date(data.expiresAt).getTime())
      setError(null)
    } catch {
      setError('Failed to load QR code')
    } finally {
      setLoading(false)
    }
  }, [ticketId, eventSlug])

  React.useEffect(() => {
    fetchQR()
  }, [fetchQR])

  // Refresh ahead of expiry, and when the page becomes visible with a stale code.
  React.useEffect(() => {
    if (!expiresAt) return
    const delay = Math.max(expiresAt - Date.now() - REFRESH_MARGIN_MS, 5_000)
    const timer = window.setTimeout(fetchQR, delay)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() > expiresAt - REFRESH_MARGIN_MS) fetchQR()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [expiresAt, fetchQR])

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="text-center pb-2">
        <CardTitle className="flex items-center justify-center gap-2">
          <QrCodeIcon className="h-5 w-5" />
          {tierName || 'Event Ticket'}
        </CardTitle>
        {eventName && <CardDescription>{eventName}</CardDescription>}
      </CardHeader>

      <CardContent className="flex flex-col items-center gap-4">
        {loading ? (
          <div className="flex items-center justify-center bg-muted rounded-lg" style={{ width: qrSize, height: qrSize }}>
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : error && !qrDataUrl ? (
          <div
            className="flex flex-col items-center justify-center gap-3 bg-destructive/10 text-destructive rounded-lg p-4"
            style={{ width: qrSize, height: qrSize }}
          >
            <p className="text-sm text-center">{error}</p>
            <Button variant="outline" size="sm" onClick={() => fetchQR()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : qrDataUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt="Ticket QR Code" width={qrSize} height={qrSize} className="rounded-lg" />
            <p className="text-xs text-muted-foreground text-center">
              Show this QR code at check-in. It refreshes automatically while this page is open.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
