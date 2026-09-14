'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Send, Loader2, CheckCircle, History, Megaphone, Mail, CalendarCheck, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { getAccessToken } from '@/lib/supabase/client'
import { formatDistanceToNow } from 'date-fns'

interface SessionEmailStats {
  scheduled_total: number
  scheduled_unnotified: number
  scheduled_unnotified_sessions: { id: string; title: string }[]
  pending_email_notifications: number
}

interface Broadcast {
  title: string
  body: string | null
  action_url: string | null
  data: Record<string, unknown> | null
  created_at: string
}

export default function AdminCommunicationsPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { isAdmin, isLoading: roleLoading, can } = useEventRole()

  const [title, setTitle] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [ctaUrl, setCtaUrl] = React.useState('')
  const [ctaText, setCtaText] = React.useState('')

  const [isLoading, setIsLoading] = React.useState(false)
  const [success, setSuccess] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const [broadcasts, setBroadcasts] = React.useState<Broadcast[]>([])
  const [loadingHistory, setLoadingHistory] = React.useState(true)

  // Session emails state
  const [sessionEmailStats, setSessionEmailStats] = React.useState<SessionEmailStats | null>(null)
  const [loadingStats, setLoadingStats] = React.useState(true)
  const [isNotifyingHosts, setIsNotifyingHosts] = React.useState(false)
  const [isDispatchingQueue, setIsDispatchingQueue] = React.useState(false)
  const [sessionEmailFeedback, setSessionEmailFeedback] = React.useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null)

  const fetchSessionEmailStats = React.useCallback(async () => {
    try {
      const token = getAccessToken()
      if (!token) {
        setLoadingStats(false)
        return
      }
      const response = await fetch(
        `/api/v1/events/${event.slug}/admin/session-emails`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (response.ok) {
        const data: SessionEmailStats = await response.json()
        setSessionEmailStats(data)
      }
    } catch (err) {
      console.error('Error fetching session email stats:', err)
    } finally {
      setLoadingStats(false)
    }
  }, [event.slug])

  React.useEffect(() => {
    fetchSessionEmailStats()
  }, [fetchSessionEmailStats])

  const postSessionEmailAction = async (action: 'notify-scheduled-hosts' | 'dispatch-queue') => {
    setSessionEmailFeedback(null)
    const token = getAccessToken()
    if (!token) {
      setSessionEmailFeedback({ kind: 'error', text: 'Please log in again.' })
      return
    }

    const setBusy = action === 'notify-scheduled-hosts' ? setIsNotifyingHosts : setIsDispatchingQueue
    setBusy(true)
    try {
      const response = await fetch(
        `/api/v1/events/${event.slug}/admin/session-emails`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action }),
        },
      )
      const data = await response.json()
      if (!response.ok) {
        setSessionEmailFeedback({
          kind: 'error',
          text: data.error || 'Failed to send emails.',
        })
        return
      }
      const label = action === 'notify-scheduled-hosts' ? 'schedule notification(s)' : 'approval/rejection email(s)'
      setSessionEmailFeedback({
        kind: 'success',
        text: `Sent ${data.sent ?? 0} ${label}${data.skipped ? ` (${data.skipped} skipped)` : ''}.`,
      })
      await fetchSessionEmailStats()
    } catch (err) {
      setSessionEmailFeedback({
        kind: 'error',
        text: 'Unexpected error sending emails.',
      })
    } finally {
      setBusy(false)
    }
  }

  // Fetch broadcast history
  React.useEffect(() => {
    async function fetchHistory() {
      try {
        const token = getAccessToken()
        if (!token) {
          console.warn('No auth token for broadcast history')
          setLoadingHistory(false)
          return
        }

        const response = await fetch(`/api/v1/events/${event.slug}/admin/broadcast`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        })
        if (response.ok) {
          const data = await response.json()
          setBroadcasts(data.broadcasts || [])
        }
      } catch (err) {
        console.error('Error fetching broadcast history:', err)
      } finally {
        setLoadingHistory(false)
      }
    }
    fetchHistory()
  }, [event.slug])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setSuccess(null)
    setError(null)

    try {
      const token = getAccessToken()
      if (!token) {
        setError('Please log in to send announcements')
        setIsLoading(false)
        return
      }

      const response = await fetch(`/api/v1/events/${event.slug}/admin/broadcast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: title.trim(),
          message: message.trim(),
          ctaUrl: ctaUrl.trim() || undefined,
          ctaText: ctaText.trim() || undefined,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to send announcement')
        return
      }

      setSuccess(data.message || `Announcement sent to ${data.sent} members`)
      setTitle('')
      setMessage('')
      setCtaUrl('')
      setCtaText('')

      // Refresh history
      const historyResponse = await fetch(`/api/v1/events/${event.slug}/admin/broadcast`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (historyResponse.ok) {
        const historyData = await historyResponse.json()
        setBroadcasts(historyData.broadcasts || [])
      }
    } catch (err) {
      setError('An unexpected error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  // Redirect if not admin
  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !isAdmin)) {
      router.push(`/e/${event.slug}/sessions`)
    }
  }, [user, isAdmin, authLoading, roleLoading, router, event.slug])

  if (authLoading || roleLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAdmin) {
    return null
  }

  return (
        <div className="space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-display font-bold">Messages</h1>
            <p className="text-sm text-muted-foreground">
              Announcements and session emails for {event.name}
            </p>
          </div>

          {/* Session Host Emails */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Session Host Emails
              </CardTitle>
              <CardDescription>
                Send session approval notifications and schedule confirmations directly to hosts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {sessionEmailFeedback && (
                <Alert
                  className={
                    sessionEmailFeedback.kind === 'success'
                      ? 'bg-green-500/10 border-green-500/30'
                      : undefined
                  }
                  variant={sessionEmailFeedback.kind === 'error' ? 'destructive' : undefined}
                >
                  {sessionEmailFeedback.kind === 'success' ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <AlertDescription
                    className={
                      sessionEmailFeedback.kind === 'success' ? 'text-green-500' : undefined
                    }
                  >
                    {sessionEmailFeedback.text}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                {/* Schedule notifications */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <CalendarCheck className="h-5 w-5 text-primary mt-0.5" />
                    <div className="flex-1">
                      <h3 className="font-medium text-sm">Schedule notifications</h3>
                      <p className="text-xs text-muted-foreground">
                        Email hosts when their session has been scheduled with venue and time details.
                      </p>
                    </div>
                  </div>
                  {loadingStats ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : sessionEmailStats ? (
                    <>
                      <p className="text-sm">
                        <span className="font-semibold">
                          {sessionEmailStats.scheduled_unnotified}
                        </span>
                        <span className="text-muted-foreground">
                          {' '}of {sessionEmailStats.scheduled_total} scheduled session(s) awaiting notification
                        </span>
                      </p>
                      {sessionEmailStats.scheduled_unnotified_sessions.length > 0 && (
                        <ul className="text-xs text-muted-foreground max-h-24 overflow-y-auto space-y-0.5 pl-1">
                          {sessionEmailStats.scheduled_unnotified_sessions.slice(0, 5).map((s) => (
                            <li key={s.id} className="truncate">• {s.title}</li>
                          ))}
                          {sessionEmailStats.scheduled_unnotified_sessions.length > 5 && (
                            <li className="italic">
                              …and {sessionEmailStats.scheduled_unnotified_sessions.length - 5} more
                            </li>
                          )}
                        </ul>
                      )}
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => postSessionEmailAction('notify-scheduled-hosts')}
                        disabled={
                          isNotifyingHosts ||
                          sessionEmailStats.scheduled_unnotified === 0
                        }
                      >
                        {isNotifyingHosts ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Sending…
                          </>
                        ) : (
                          <>
                            <Mail className="h-4 w-4 mr-2" />
                            Notify scheduled hosts
                          </>
                        )}
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">Unable to load stats.</p>
                  )}
                </div>

                {/* Approval / Rejection emails */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="h-5 w-5 text-primary mt-0.5" />
                    <div className="flex-1">
                      <h3 className="font-medium text-sm">Approval &amp; rejection emails</h3>
                      <p className="text-xs text-muted-foreground">
                        Dispatch any queued session-approval or rejection emails that haven&apos;t been
                        sent yet.
                      </p>
                    </div>
                  </div>
                  {loadingStats ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : sessionEmailStats ? (
                    <>
                      <p className="text-sm">
                        <span className="font-semibold">
                          {sessionEmailStats.pending_email_notifications}
                        </span>
                        <span className="text-muted-foreground">
                          {' '}queued email notification(s)
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Approval emails are normally sent automatically when a session is approved.
                        Use this to retry any that didn&apos;t go through.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => postSessionEmailAction('dispatch-queue')}
                        disabled={
                          isDispatchingQueue ||
                          sessionEmailStats.pending_email_notifications === 0
                        }
                      >
                        {isDispatchingQueue ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Dispatching…
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4 mr-2" />
                            Send queued emails
                          </>
                        )}
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">Unable to load stats.</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
          {/* Send Announcement */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Megaphone className="h-5 w-5" />
                Send Announcement
              </CardTitle>
              <CardDescription>
                Compose a message to send to all event members
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {success && (
                  <Alert className="bg-green-500/10 border-green-500/30">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <AlertDescription className="text-green-500">
                      {success}
                    </AlertDescription>
                  </Alert>
                )}

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    placeholder="Important Update"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    maxLength={100}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="message">Message *</Label>
                  <Textarea
                    id="message"
                    placeholder="Write your announcement here..."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    required
                    rows={5}
                    maxLength={1000}
                  />
                  <p className="text-xs text-muted-foreground text-right">
                    {message.length}/1000
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="ctaUrl">Link URL (optional)</Label>
                    <Input
                      id="ctaUrl"
                      type="url"
                      placeholder="https://..."
                      value={ctaUrl}
                      onChange={(e) => setCtaUrl(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ctaText">Link Text (optional)</Label>
                    <Input
                      id="ctaText"
                      placeholder="Learn More"
                      value={ctaText}
                      onChange={(e) => setCtaText(e.target.value)}
                      maxLength={30}
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Send Announcement
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Broadcast History */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Recent Announcements
              </CardTitle>
              <CardDescription>
                Previously sent announcements
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingHistory ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : broadcasts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No announcements sent yet</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {broadcasts.map((broadcast, index) => (
                    <div
                      key={index}
                      className="border-b border-border pb-4 last:border-b-0 last:pb-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-medium text-sm">{broadcast.title}</h4>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDistanceToNow(new Date(broadcast.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      {broadcast.body && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {broadcast.body}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        </div>
  )
}
