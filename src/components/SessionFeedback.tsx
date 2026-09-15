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
import { Loader2, Lock, MessageSquare, Star, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'
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

  if (readOnly) {
    return (
      <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} aria-hidden className={cn(dim, n <= value ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
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
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          className="rounded p-0.5 hover:scale-110 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setHover(n)}
          onFocus={() => setHover(n)}
          onBlur={() => setHover(null)}
          onClick={() => onChange?.(n)}
        >
          <Star aria-hidden className={cn(dim, 'transition-colors', n <= active ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
        </button>
      ))}
    </div>
  )
}

export function SessionFeedback({ sessionId, eventSlug }: SessionFeedbackProps) {
  const { user } = useAuth()
  const [data, setData] = React.useState<FeedbackResponse | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [rating, setRating] = React.useState(0)
  const [comment, setComment] = React.useState('')
  const [wouldAttendAgain, setWouldAttendAgain] = React.useState<boolean | null>(null)
  const [isEditing, setIsEditing] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)

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
      setError(err instanceof ApiError ? err.message : 'Failed to load feedback')
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
      setError('Pick a star rating first')
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      await apiFetch(endpoint, {
        method: 'POST',
        json: { rating, comment: comment.trim() || null, would_attend_again: wouldAttendAgain },
      })
      setIsEditing(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save feedback')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Withdraw your feedback for this session?')) return
    setIsDeleting(true)
    setError(null)
    try {
      await apiFetch(endpoint, { method: 'DELETE' })
      setRating(0)
      setComment('')
      setWouldAttendAgain(null)
      setIsEditing(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to withdraw feedback')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading feedback...
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card className="p-6">
        <p className="text-sm text-destructive">{error || 'Feedback is unavailable right now.'}</p>
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
    <Card className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <MessageSquare className="h-4 w-4" aria-hidden />
            Session feedback
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {open
              ? `Anonymous once feedback closes${win.closesAt ? ` (${formatWhen(win.closesAt)})` : ''}. Results appear then.`
              : 'Feedback has closed and responses are sealed.'}
          </p>
        </div>
        {!open && (
          <div className="text-right">
            {summary.released && summary.avgRating !== undefined && summary.count !== undefined ? (
              <>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-2xl font-bold">{summary.avgRating.toFixed(1)}</span>
                  <StarRating value={Math.round(summary.avgRating)} size="sm" readOnly />
                </div>
                <p className="text-xs text-muted-foreground">
                  {summary.count} {summary.count === 1 ? 'response' : 'responses'}
                  {summary.wouldAttendAgain && summary.wouldAttendAgain.yes + summary.wouldAttendAgain.no > 0 && (
                    <> · {summary.wouldAttendAgain.yes} of {summary.wouldAttendAgain.yes + summary.wouldAttendAgain.no} would attend again</>
                  )}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground max-w-[14rem]">
                Fewer than {summary.k} people responded, so no results are shown.
              </p>
            )}
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {open && !user && (
        <div className="rounded-lg border border-dashed p-4 text-center">
          <p className="text-sm text-muted-foreground mb-3">Sign in to rate this session</p>
          <Button asChild variant="outline" size="sm">
            <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link>
          </Button>
        </div>
      )}

      {open && user && !data.can_submit && data.reason && (
        <p className="text-sm text-muted-foreground">{data.reason}</p>
      )}

      {open && own && !isEditing && (
        <div className="rounded-lg bg-muted/40 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StarRating value={own.rating} size="sm" readOnly />
              <span className="text-sm text-muted-foreground">Your response (only you can see it, until feedback closes)</span>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleDelete}
                disabled={isDeleting}
                aria-label="Withdraw your feedback"
              >
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
          </div>
          {own.would_attend_again !== null && (
            <p className="text-sm">{own.would_attend_again ? 'Would attend again' : 'Would not attend again'}</p>
          )}
          {own.comment && <p className="text-sm whitespace-pre-wrap">{own.comment}</p>}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Your rating</legend>
            <StarRating value={rating} onChange={setRating} />
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Would you attend a session like this again?</legend>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={wouldAttendAgain === true ? 'default' : 'outline'}
                onClick={() => setWouldAttendAgain(wouldAttendAgain === true ? null : true)}
                aria-pressed={wouldAttendAgain === true}
              >
                <ThumbsUp className="h-4 w-4 mr-1" aria-hidden />
                Yes
              </Button>
              <Button
                type="button"
                size="sm"
                variant={wouldAttendAgain === false ? 'default' : 'outline'}
                onClick={() => setWouldAttendAgain(wouldAttendAgain === false ? null : false)}
                aria-pressed={wouldAttendAgain === false}
              >
                <ThumbsDown className="h-4 w-4 mr-1" aria-hidden />
                No
              </Button>
            </div>
          </fieldset>

          <div className="space-y-2">
            <label htmlFor={`feedback-comment-${sessionId}`} className="text-sm font-medium">
              Comment <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              id={`feedback-comment-${sessionId}`}
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_LENGTH))}
              placeholder="What worked well? What could be better?"
              rows={3}
              maxLength={MAX_COMMENT_LENGTH}
              aria-describedby={`feedback-comment-help-${sessionId}`}
            />
            <p id={`feedback-comment-help-${sessionId}`} className="text-xs text-muted-foreground flex justify-between gap-2">
              <span>Hosts read comments word for word once feedback closes, without your name. Leave out anything that identifies you.</span>
              <span className="tabular-nums flex-shrink-0">
                {comment.length}/{MAX_COMMENT_LENGTH}
              </span>
            </p>
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving || rating < 1}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />}
              {own ? 'Update feedback' : 'Submit feedback'}
            </Button>
            {own && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setIsEditing(false)
                  setRating(own.rating)
                  setComment(own.comment ?? '')
                  setWouldAttendAgain(own.would_attend_again)
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {data.can_manage && (
        <div className="border-t pt-4 space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-2">
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
                <li key={i} className="rounded-lg border p-3 text-sm whitespace-pre-wrap">
                  {text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No comments were left.</p>
          )}
        </div>
      )}
    </Card>
  )
}
