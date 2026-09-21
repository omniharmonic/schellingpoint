'use client'

/**
 * Post-session feedback on ballot machinery (`/api/v1/events/[slug]/sessions/[id]/feedback`).
 *
 * While the window is open a participant can leave, change or withdraw one response.
 * When it closes the responses are sealed: nobody can tie a response to its author any
 * more — not organizers, not hosts, not the author. Results appear only then, and only
 * once at least k people responded; hosts and organizers also see the comments, without
 * names, ratings or dates attached.
 */
import * as React from 'react'
import Link from 'next/link'
import { Loader2, Lock, MessageSquare, Star, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'
import { ELLIPSIS, plural } from '@/lib/format'
import { cn } from '@/lib/utils'

interface OwnFeedback {
  rating: number
  comment: string | null
  would_attend_again: boolean | null
}

interface FeedbackResponse {
  window: { status: 'none' | 'open' | 'closed'; opensAt: string | null; closesAt: string | null }
  summary: {
    k: number
    released: boolean
    count?: number
    avgRating?: number
    wouldAttendAgain?: { yes: number; no: number }
    comments?: string[]
  }
  own: OwnFeedback | null
  can_submit: boolean
  reason: string | null
  can_manage: boolean
  is_host: boolean
}

interface SessionFeedbackProps {
  sessionId: string
  eventSlug: string
}

const MAX_COMMENT_LENGTH = 2000

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function StarRating({
  value,
  onChange,
  size = 'md',
  readOnly = false,
}: {
  value: number
  onChange?: (value: number) => void
  size?: 'sm' | 'md'
  readOnly?: boolean
}) {
  const [hover, setHover] = React.useState<number | null>(null)
  const active = hover ?? value
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-7 w-7'
  const lit = 'fill-signal-amber text-signal-amber'
  const dark = 'text-muted-foreground/40'

  if (readOnly) {
    return (
      <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} aria-hidden className={cn(dim, n <= value ? lit : dark)} />
        ))}
      </span>
    )
  }

  return (
    <div className="inline-flex items-center gap-0.5" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={plural(n, 'star')}
          className="rounded p-0.5 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setHover(n)}
          onFocus={() => setHover(n)}
          onBlur={() => setHover(null)}
          onClick={() => onChange?.(n)}
        >
          <Star aria-hidden className={cn(dim, 'transition-colors', n <= active ? lit : dark)} />
        </button>
      ))}
    </div>
  )
}

export function SessionFeedback({ sessionId, eventSlug }: SessionFeedbackProps) {
  const { user } = useAuth()
  const { toast } = useToast()
  const [data, setData] = React.useState<FeedbackResponse | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [rating, setRating] = React.useState(0)
  const [comment, setComment] = React.useState('')
  const [wouldAttendAgain, setWouldAttendAgain] = React.useState<boolean | null>(null)
  const [isEditing, setIsEditing] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [confirmingWithdraw, setConfirmingWithdraw] = React.useState(false)

  const endpoint = `/api/v1/events/${encodeURIComponent(eventSlug)}/sessions/${encodeURIComponent(sessionId)}/feedback`

  const load = React.useCallback(async () => {
    try {
      const json = await apiFetch<FeedbackResponse>(endpoint, { cache: 'no-store' })
      setData(json)
      if (json.own) {
        setRating(json.own.rating)
        setComment(json.own.comment ?? '')
        setWouldAttendAgain(json.own.would_attend_again)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Feedback could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [endpoint])

  React.useEffect(() => {
    setIsLoading(true)
    void load()
  }, [load, user?.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (rating < 1) {
      setError('Pick a star rating first.')
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      await apiFetch(endpoint, {
        method: 'POST',
        json: { rating, comment: comment.trim() || null, would_attend_again: wouldAttendAgain },
      })
      const updating = !!data?.own
      setIsEditing(false)
      await load()
      toast({ title: updating ? 'Feedback updated' : 'Thanks for your feedback', description: 'Only you can see it until feedback closes.', variant: 'success' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your feedback could not be saved. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    setError(null)
    try {
      await apiFetch(endpoint, { method: 'DELETE' })
      setRating(0)
      setComment('')
      setWouldAttendAgain(null)
      setIsEditing(false)
      setConfirmingWithdraw(false)
      await load()
      toast({ title: 'Feedback withdrawn', variant: 'success' })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your feedback could not be withdrawn. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading feedback{ELLIPSIS}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
          <p role="alert" className="text-sm text-destructive">{error || 'Feedback is unavailable right now.'}</p>
        </CardContent>
      </Card>
    )
  }

  // Nothing to show before the session starts.
  if (data.window.status === 'none') return null

  const { window: win, summary, own } = data
  const open = win.status === 'open'
  const showForm = open && data.can_submit && (!own || isEditing)
  const returnTo = `/e/${eventSlug}/sessions/${sessionId}`

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" aria-hidden />
              Session feedback
            </CardTitle>
            <CardDescription className="mt-1.5">
              {open
                ? `Anonymous once feedback closes${win.closesAt ? ` (${formatWhen(win.closesAt)})` : ''}. Results appear then.`
                : 'Feedback has closed and responses are sealed.'}
            </CardDescription>
          </div>
          {!open && (
            <div className="text-right">
              {summary.released && summary.avgRating !== undefined && summary.count !== undefined ? (
                <>
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-2xl font-bold tabular-nums">{summary.avgRating.toFixed(1)}</span>
                    <StarRating value={Math.round(summary.avgRating)} size="sm" readOnly />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {plural(summary.count, 'response')}
                    {summary.wouldAttendAgain && summary.wouldAttendAgain.yes + summary.wouldAttendAgain.no > 0 && (
                      <> · {summary.wouldAttendAgain.yes} of {summary.wouldAttendAgain.yes + summary.wouldAttendAgain.no} would attend again</>
                    )}
                  </p>
                </>
              ) : (
                <p className="max-w-[14rem] text-xs text-muted-foreground">
                  Fewer than {summary.k} people responded, so no results are shown.
                </p>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}

        {open && !user && (
          <div className="rounded-lg border border-dashed p-4 text-center">
            <p className="mb-3 text-sm text-muted-foreground">Sign in to rate this session.</p>
            <Button asChild variant="outline" size="sm">
              <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link>
            </Button>
          </div>
        )}

        {open && user && !data.can_submit && data.reason && (
          <p className="text-sm text-muted-foreground">{data.reason}</p>
        )}

        {open && own && !isEditing && (
          <div className="space-y-3 rounded-lg bg-muted/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <StarRating value={own.rating} size="sm" readOnly />
                <span className="text-sm text-muted-foreground">Your response (only you can see it until feedback closes)</span>
              </div>
              {!confirmingWithdraw && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmingWithdraw(true)}>
                    Withdraw
                  </Button>
                </div>
              )}
            </div>
            {own.would_attend_again !== null && (
              <p className="text-sm">{own.would_attend_again ? 'Would attend again' : 'Would not attend again'}</p>
            )}
            {own.comment && <p className="whitespace-pre-wrap text-sm">{own.comment}</p>}
            {confirmingWithdraw && (
              <ConfirmInline
                destructive
                message="Withdraw your feedback for this session? You can leave a new response while feedback is open."
                confirmLabel="Withdraw"
                loading={isDeleting}
                onConfirm={handleDelete}
                onCancel={() => setConfirmingWithdraw(false)}
              />
            )}
          </div>
        )}

        {showForm && (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium leading-none">Your rating</legend>
              <div className="pt-2">
                <StarRating value={rating} onChange={setRating} />
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium leading-none">Would you attend a session like this again?</legend>
              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant={wouldAttendAgain === true ? 'default' : 'outline'}
                  onClick={() => setWouldAttendAgain(wouldAttendAgain === true ? null : true)}
                  aria-pressed={wouldAttendAgain === true}
                >
                  <ThumbsUp className="mr-1 h-4 w-4" aria-hidden />
                  Yes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={wouldAttendAgain === false ? 'default' : 'outline'}
                  onClick={() => setWouldAttendAgain(wouldAttendAgain === false ? null : false)}
                  aria-pressed={wouldAttendAgain === false}
                >
                  <ThumbsDown className="mr-1 h-4 w-4" aria-hidden />
                  No
                </Button>
              </div>
            </fieldset>

            <div className="space-y-2">
              <Label htmlFor={`feedback-comment-${sessionId}`}>Comment (optional)</Label>
              <Textarea
                id={`feedback-comment-${sessionId}`}
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_LENGTH))}
                placeholder="What worked well? What could be better?"
                rows={3}
                maxLength={MAX_COMMENT_LENGTH}
                aria-describedby={`feedback-comment-help-${sessionId}`}
              />
              <p id={`feedback-comment-help-${sessionId}`} className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>Hosts read comments word for word once feedback closes, without your name. Leave out anything that identifies you.</span>
                <span className="shrink-0 tabular-nums">
                  {comment.length}/{MAX_COMMENT_LENGTH}
                </span>
              </p>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {own && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setIsEditing(false)
                    setRating(own.rating)
                    setComment(own.comment ?? '')
                    setWouldAttendAgain(own.would_attend_again)
                  }}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              )}
              <Button type="submit" loading={isSaving} disabled={rating < 1}>
                {own ? 'Update feedback' : 'Submit feedback'}
              </Button>
            </div>
          </form>
        )}

        {data.can_manage && (
          <div className="space-y-3 border-t pt-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <Lock className="h-4 w-4" aria-hidden />
              Comments for hosts and organizers
            </h4>
            {open ? (
              <p className="text-sm text-muted-foreground">
                Comments appear here after feedback closes{win.closesAt ? ` on ${formatWhen(win.closesAt)}` : ''}, if at least{' '}
                {summary.k} people respond. Nobody can see who wrote what.
              </p>
            ) : !summary.released ? (
              <p className="text-sm text-muted-foreground">Fewer than {summary.k} people responded, so comments stay sealed.</p>
            ) : summary.comments && summary.comments.length > 0 ? (
              <ul className="space-y-3">
                {summary.comments.map((text, i) => (
                  <li key={i} className="whitespace-pre-wrap rounded-lg border p-3 text-sm">
                    {text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No comments were left.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
