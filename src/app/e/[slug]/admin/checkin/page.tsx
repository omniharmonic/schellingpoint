'use client'

import * as React from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ScanLine, UserCheck, Users, XCircle } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'

// Dynamic import: the scanner needs the camera, so it never renders on the server.
const QRScanner = dynamic(() => import('@/components/QRScanner').then((mod) => mod.QRScanner), {
  ssr: false,
  loading: () => (
    <div className="flex h-[300px] w-full items-center justify-center rounded-xl bg-muted" role="status" aria-label="Starting the camera">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  ),
})

interface CheckInResult {
  success: boolean
  error?: string
  code?: string
  attendee?: { name: string; avatarUrl?: string | null; tierName?: string | null; ticketId?: string }
  checkedInAt?: string | null
}

interface CheckInStats {
  total: number
  checkedIn: number
  pending: number
}

type CheckInRequest = { qrToken: string } | { ticketCode: string }

export default function AdminCheckInPage() {
  const router = useRouter()
  const event = useEvent()
  const { can } = useEventRole()
  const canCheckIn = can('checkInAttendees')

  const [scanning, setScanning] = React.useState(true)
  const [lastResult, setLastResult] = React.useState<CheckInResult | null>(null)
  const [processing, setProcessing] = React.useState(false)
  const [stats, setStats] = React.useState<CheckInStats | null>(null)
  const [lastScannedCode, setLastScannedCode] = React.useState<string | null>(null)
  const [cameraError, setCameraError] = React.useState<string | null>(null)
  const [manualCode, setManualCode] = React.useState('')
  const [manualError, setManualError] = React.useState<string | null>(null)
  const manualInputRef = React.useRef<HTMLInputElement>(null)

  const fetchStats = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ stats: CheckInStats }>(`/api/v1/events/${encodeURIComponent(event.slug)}/checkin`)
      setStats(data.stats)
    } catch {
      // Stats are informational; the scanner keeps working without them.
    }
  }, [event.slug])

  React.useEffect(() => {
    if (canCheckIn) void fetchStats()
  }, [canCheckIn, fetchStats])

  const submit = React.useCallback(async (body: CheckInRequest) => {
    setProcessing(true)
    setScanning(false)
    try {
      // Same-origin fetch rather than apiFetch: a refused check-in (409) carries the attendee
      // and the earlier check-in time in its body, which the door needs to resolve it.
      const response = await fetch(`/api/v1/events/${encodeURIComponent(event.slug)}/checkin`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.status === 401) {
        router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/admin/checkin`)}`)
        return
      }
      const data = (await response.json().catch(() => ({}))) as Partial<CheckInResult>
      if (response.ok) {
        setLastResult({ success: true, attendee: data.attendee })
        setManualCode('')
        void fetchStats()
      } else if ('ticketCode' in body && (data.code === 'INVALID_CODE' || data.code === 'AMBIGUOUS_CODE' || data.code === 'TICKET_NOT_FOUND')) {
        // Keep the typed code on screen so the volunteer can correct it.
        setManualError(data.error || 'No ticket matches that code.')
        setScanning(true)
      } else {
        setLastResult({
          success: false,
          error: data.error || 'The check-in could not be processed.',
          code: data.code,
          attendee: data.attendee,
          checkedInAt: data.checkedInAt ?? undefined,
        })
      }
    } catch {
      setLastResult({ success: false, error: 'The check-in could not be processed. Check the connection and try again.' })
    } finally {
      setProcessing(false)
    }
  }, [event.slug, router, fetchStats])

  const handleScan = React.useCallback((qrToken: string) => {
    // Do not scan the same code twice in a row.
    if (qrToken === lastScannedCode || processing) return
    setLastScannedCode(qrToken)
    void submit({ qrToken })
  }, [lastScannedCode, processing, submit])

  const handleManual = (e: React.FormEvent) => {
    e.preventDefault()
    const code = manualCode.trim()
    setManualError(null)
    if (code.length < 8) {
      setManualError('Enter at least the first 8 characters of the ticket ID.')
      manualInputRef.current?.focus()
      return
    }
    void submit({ ticketCode: code })
  }

  const handleContinue = () => {
    setLastResult(null)
    setLastScannedCode(null)
    setManualError(null)
    setScanning(true)
  }

  if (!canCheckIn) {
    return (
      <>
        <PageHeader title="Check-in" />
        <Card>
          <CardContent className="py-10 text-center space-y-4">
            <p className="text-muted-foreground">Check-in is for owners, admins, moderators and volunteers. Ask an owner or admin to change your role.</p>
            <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin`}>Overview & sessions</Link></Button>
          </CardContent>
        </Card>
      </>
    )
  }

  const tone = lastResult?.success ? 'success' : lastResult?.code === 'ALREADY_CHECKED_IN' ? 'warning' : 'error'

  return (
    <>
      <PageHeader title="Check-in" subtitle="Scan each attendee’s ticket at the door, or type their ticket code if the camera can’t read it." />

      <div className="max-w-lg space-y-6">
        {stats && (
          <dl className="grid grid-cols-3 gap-3">
            {[
              { label: 'Tickets', value: stats.total, icon: Users, tone: 'text-muted-foreground' },
              { label: 'Checked in', value: stats.checkedIn, icon: CheckCircle2, tone: 'text-success' },
              { label: 'Remaining', value: stats.pending, icon: UserCheck, tone: 'text-muted-foreground' },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border bg-card p-4 text-center">
                <stat.icon className={cn('mx-auto mb-1 h-5 w-5', stat.tone)} aria-hidden="true" />
                <dd className="text-2xl font-semibold tabular-nums">{stat.value}</dd>
                <dt className="text-xs text-muted-foreground">{stat.label}</dt>
              </div>
            ))}
          </dl>
        )}

        {lastResult && (
          <Card
            role={lastResult.success ? 'status' : 'alert'}
            className={cn(
              'border-2',
              tone === 'success' && 'border-success/40 bg-success/5',
              tone === 'warning' && 'border-signal-amber/40 bg-signal-amber/10',
              tone === 'error' && 'border-destructive/40 bg-destructive/5',
            )}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                {tone === 'success' && <><CheckCircle2 className="h-6 w-6 text-success" aria-hidden="true" /><span className="text-success">Checked in</span></>}
                {tone === 'warning' && <><AlertTriangle className="h-6 w-6 text-signal-amber" aria-hidden="true" /><span className="text-signal-amber">Already checked in</span></>}
                {tone === 'error' && <><XCircle className="h-6 w-6 text-destructive" aria-hidden="true" /><span className="text-destructive">Could not check in</span></>}
              </CardTitle>
              {lastResult.error && !lastResult.success && (
                <CardDescription className={tone === 'error' ? 'text-destructive' : undefined}>{lastResult.error}</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              {lastResult.attendee && (
                <div className="mb-4 flex items-center gap-3">
                  {lastResult.attendee.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={lastResult.attendee.avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <span className="text-lg font-medium">{lastResult.attendee.name.charAt(0).toUpperCase()}</span>
                    </div>
                  )}
                  <div>
                    <p className="font-semibold">{lastResult.attendee.name}</p>
                    {lastResult.attendee.tierName && <p className="text-sm text-muted-foreground">{lastResult.attendee.tierName}</p>}
                  </div>
                </div>
              )}
              {lastResult.checkedInAt && (
                <p className="mb-4 text-sm text-muted-foreground">Previously checked in {new Date(lastResult.checkedInAt).toLocaleString()}</p>
              )}
              <Button onClick={handleContinue} className="w-full">
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                Scan the next ticket
              </Button>
            </CardContent>
          </Card>
        )}

        {!lastResult && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ScanLine className="h-5 w-5" aria-hidden="true" />Scan a ticket</CardTitle>
                <CardDescription>Point the camera at the QR code on the attendee’s ticket page.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {processing ? (
                  <div className="flex h-[300px] w-full flex-col items-center justify-center rounded-xl bg-muted" role="status">
                    <Loader2 className="mb-2 h-8 w-8 animate-spin text-muted-foreground" />
                    <p className="text-muted-foreground">Checking the ticket…</p>
                  </div>
                ) : (
                  <QRScanner onScan={handleScan} paused={!scanning} onError={(message) => setCameraError(message)} />
                )}
                {cameraError && (
                  <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p>The camera could not be used: {cameraError}</p>
                      <p className="mt-1 text-destructive/80">Allow camera access in the browser, or type the ticket code below.</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setCameraError(null)} aria-label="Dismiss camera error">Dismiss</Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Enter a ticket code</CardTitle>
                <CardDescription>The first 8 characters of the ticket ID, shown on the attendee’s ticket page and in its link.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleManual} className="space-y-3" noValidate>
                  <div className="space-y-2">
                    <Label htmlFor="ticket-code">Ticket code</Label>
                    <Input
                      ref={manualInputRef}
                      id="ticket-code"
                      value={manualCode}
                      onChange={(e) => { setManualCode(e.target.value); setManualError(null) }}
                      placeholder="e.g. 3f9a1c2b"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      inputMode="text"
                      className="font-mono"
                      aria-invalid={manualError ? true : undefined}
                      aria-describedby={manualError ? 'ticket-code-error' : undefined}
                    />
                    {manualError && <p id="ticket-code-error" role="alert" className="text-sm text-destructive">{manualError}</p>}
                  </div>
                  <Button type="submit" loading={processing} disabled={!manualCode.trim()} className="w-full sm:w-auto">Check in</Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  )
}
