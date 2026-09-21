'use client'

import * as React from 'react'
import { AlertCircle, CalendarCheck, CheckCircle2, History, Loader2, Mail, Megaphone, Send } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { PageHeader } from '@/components/PageHeader'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'

interface SessionEmailStats {
  scheduled_total: number
  scheduled_unnotified: number
  scheduled_unnotified_sessions: { id: string; title: string }[]
  skipped: Array<{ sessionId: string; title: string; reason: string }>
}

interface Broadcast {
  title: string
  body: string | null
  action_url: string | null
  created_at: string
  recipients: number
}

type Feedback = { kind: 'success' | 'error'; text: string } | null

function FeedbackAlert({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null
  return (
    <Alert variant={feedback.kind === 'error' ? 'destructive' : 'success'}>
      {feedback.kind === 'success' ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
      <AlertDescription>{feedback.text}</AlertDescription>
    </Alert>
  )
}

export default function AdminCommunicationsPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const base = `/api/v1/events/${event.slug}/admin`

  const [title, setTitle] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [ctaUrl, setCtaUrl] = React.useState('')
  const [ctaText, setCtaText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [broadcastFeedback, setBroadcastFeedback] = React.useState<Feedback>(null)
  const titleRef = React.useRef<HTMLInputElement>(null)

  const [broadcasts, setBroadcasts] = React.useState<Broadcast[]>([])
  const [loadingHistory, setLoadingHistory] = React.useState(true)
  const [historyError, setHistoryError] = React.useState<string | null>(null)

  const [stats, setStats] = React.useState<SessionEmailStats | null>(null)
  const [loadingStats, setLoadingStats] = React.useState(true)
  const [statsError, setStatsError] = React.useState<string | null>(null)
  const [notifying, setNotifying] = React.useState(false)
  const [emailFeedback, setEmailFeedback] = React.useState<Feedback>(null)

  const loadStats = React.useCallback(async () => {
    setLoadingStats(true)
    setStatsError(null)
    try {
      setStats(await apiFetch<SessionEmailStats>(`${base}/session-emails`))
    } catch (e) {
      setStatsError(e instanceof ApiError ? e.message : 'Email status could not be loaded.')
    } finally {
      setLoadingStats(false)
    }
  }, [base])

  const loadHistory = React.useCallback(async () => {
    setLoadingHistory(true)
    try {
      const data = await apiFetch<{ broadcasts: Broadcast[] }>(`${base}/broadcast`)
      setBroadcasts(data.broadcasts)
      setHistoryError(null)
    } catch (e) {
      setHistoryError(e instanceof ApiError ? e.message : 'Recent announcements could not be loaded.')
    } finally {
      setLoadingHistory(false)
    }
  }, [base])

  React.useEffect(() => { void loadStats(); void loadHistory() }, [loadStats, loadHistory])

  const notifyHosts = async () => {
    setEmailFeedback(null)
    setNotifying(true)
    try {
      const data = await apiFetch<{ sent: number; logged: number; skipped: number; errors: string[] }>(`${base}/session-emails`, {
        method: 'POST',
        json: { action: 'notify-scheduled-hosts' },
      })
      const parts = [`Emailed ${plural(data.sent, 'host')}`]
      if (data.logged) parts.push(`${data.logged} logged (mail is not configured here)`)
      if (data.skipped) parts.push(`${data.skipped} skipped`)
      setEmailFeedback({ kind: data.errors.length ? 'error' : 'success', text: `${parts.join(', ')}.${data.errors.length ? ` ${data.errors[0]}` : ''}` })
      await loadStats()
    } catch (e) {
      setEmailFeedback({ kind: 'error', text: e instanceof ApiError ? e.message : 'Hosts could not be emailed.' })
    } finally {
      setNotifying(false)
    }
  }

  const sendAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault()
    setSending(true)
    setBroadcastFeedback(null)
    try {
      const data = await apiFetch<{ message: string }>(`${base}/broadcast`, {
        method: 'POST',
        json: { title: title.trim(), message: message.trim(), ctaUrl: ctaUrl.trim() || undefined, ctaText: ctaText.trim() || undefined },
      })
      setBroadcastFeedback({ kind: 'success', text: data.message })
      setTitle('')
      setMessage('')
      setCtaUrl('')
      setCtaText('')
      await loadHistory()
    } catch (err) {
      setBroadcastFeedback({ kind: 'error', text: err instanceof ApiError ? err.message : 'The announcement could not be sent.' })
    } finally {
      setSending(false)
    }
  }

  if (!can('sendCommunications')) {
    return (
      <>
        <PageHeader title="Announcements & emails" />
        <Card><CardContent className="py-8 text-center text-muted-foreground">Your role does not include messaging members. Ask an owner or admin to change your role.</CardContent></Card>
      </>
    )
  }

  return (
    <div>
      <PageHeader title="Announcements & emails" subtitle={`Announcements to every member, and slot emails to session hosts, for ${event.name}.`} />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" aria-hidden="true" />Session host emails</CardTitle>
            <CardDescription>
              Approval, rejection and scheduling updates reach hosts automatically as notifications, by email when their preferences allow. Use this to send hosts the full details of their slot once it is on the published schedule.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FeedbackAlert feedback={emailFeedback} />
            <div className="rounded-xl border p-4 space-y-3">
              <div className="flex items-start gap-3">
                <CalendarCheck className="h-5 w-5 text-primary mt-0.5" aria-hidden="true" />
                <div className="flex-1">
                  <h2 className="font-medium text-sm">Slot details</h2>
                  <p className="text-xs text-muted-foreground">Room, date and time for each host whose session is on the published schedule.</p>
                </div>
              </div>
              {loadingStats ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking who is ready to email…</div>
              ) : stats ? (
                <>
                  <p className="text-sm">
                    <span className="font-semibold">{stats.scheduled_unnotified}</span>
                    <span className="text-muted-foreground"> of {plural(stats.scheduled_total, 'scheduled session')} ready to email</span>
                  </p>
                  {stats.scheduled_unnotified_sessions.length > 0 && (
                    <ul className="text-xs text-muted-foreground max-h-24 overflow-y-auto space-y-0.5 pl-1">
                      {stats.scheduled_unnotified_sessions.slice(0, 5).map((s) => <li key={s.id} className="truncate">• {s.title}</li>)}
                      {stats.scheduled_unnotified_sessions.length > 5 && <li className="italic">…and {stats.scheduled_unnotified_sessions.length - 5} more</li>}
                    </ul>
                  )}
                  {stats.skipped.length > 0 && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{plural(stats.skipped.length, 'session')} can’t be emailed yet — see why</summary>
                      <ul className="mt-1 space-y-0.5 pl-1">{stats.skipped.slice(0, 20).map((s) => <li key={s.sessionId}>• {s.title} — {s.reason}</li>)}</ul>
                    </details>
                  )}
                  <Button size="sm" className="w-full sm:w-auto" onClick={() => void notifyHosts()} loading={notifying} disabled={stats.scheduled_unnotified === 0}>
                    {!notifying && <Mail className="h-4 w-4 mr-2" aria-hidden="true" />}Email hosts
                  </Button>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p className="text-destructive" role="alert">{statsError ?? 'Email status could not be loaded.'}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadStats()}>Try again</Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Megaphone className="h-5 w-5" aria-hidden="true" />Send an announcement</CardTitle>
              <CardDescription>Every member gets it in their notifications, and by email if they have that turned on.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={sendAnnouncement} className="space-y-4">
                <FeedbackAlert feedback={broadcastFeedback} />
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input ref={titleRef} id="title" placeholder="Important update" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="message">Message</Label>
                  <Textarea id="message" placeholder="Write your announcement…" value={message} onChange={(e) => setMessage(e.target.value)} required rows={5} maxLength={1000} />
                  <p className="text-xs text-muted-foreground text-right">{message.length}/1000</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="ctaUrl">Link (optional)</Label>
                    <Input id="ctaUrl" placeholder={`https://… or /e/${event.slug}/schedule`} value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} maxLength={500} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ctaText">Link text (optional)</Label>
                    <Input id="ctaText" placeholder="Learn more" value={ctaText} onChange={(e) => setCtaText(e.target.value)} maxLength={30} />
                  </div>
                </div>
                <Button type="submit" className="w-full sm:w-auto" loading={sending}>
                  {!sending && <Send className="h-4 w-4 mr-2" aria-hidden="true" />}Send announcement
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" aria-hidden="true" />Recent announcements</CardTitle>
              <CardDescription>What members have already heard from you.</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingHistory ? (
                <div className="flex items-center justify-center py-8" role="status" aria-label="Loading announcements"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : historyError ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p role="alert" className="text-destructive">{historyError}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadHistory()}>Try again</Button>
                </div>
              ) : broadcasts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-50" aria-hidden="true" />
                  <p>No announcements sent yet.</p>
                  <Button variant="link" className="mt-1" onClick={() => titleRef.current?.focus()}>Write your first one</Button>
                </div>
              ) : (
                <ul className="space-y-4">
                  {broadcasts.map((b) => (
                    <li key={`${b.title}-${b.created_at}`} className="border-b border-border pb-4 last:border-b-0 last:pb-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-medium text-sm">{b.title}</h3>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}</span>
                      </div>
                      {b.body && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{b.body}</p>}
                      <p className="text-xs text-muted-foreground mt-1">{plural(b.recipients, 'recipient')}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
