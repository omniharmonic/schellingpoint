'use client'

import * as React from 'react'
import Link from 'next/link'
import { Loader2, MessageSquare, Star, Trash2, ThumbsUp, ThumbsDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/hooks/useAuth'
import { getAccessToken } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

interface FeedbackSummary {
  avg_rating: number | null
  count: number | null
}

interface OwnFeedback {
  id: string
  rating: number
  comment: string | null
  would_attend_again: boolean | null
  created_at: string
  updated_at: string
}

interface FeedbackEntry {
  id: string
  rating: number
  comment: string | null
  would_attend_again: boolean | null
  created_at: string
  /** Only present for event organizers. Hosts see anonymous entries. */
  user?: { id: string; display_name: string | null; avatar_url: string | null } | null
}

interface FeedbackResponse {
  summary: FeedbackSummary
  own: OwnFeedback | null
  feedback?: FeedbackEntry[]
  feedback_open: boolean
  started_at: string | null
  can_manage: boolean
  is_organizer: boolean
}

interface SessionFeedbackProps {
  sessionId: string
  eventSlug: string
}

const MAX_COMMENT_LENGTH = 2000

function authHeaders(): Record<string, string> {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
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

  return (
    <div
      className="inline-flex items-center gap-0.5"
      role={readOnly ? undefined : 'radiogroup'}
      aria-label="Rating"
      onMouseLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= active
        const star = (
          <Star
            className={cn(
              dim,
              'transition-colors',
              filled ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'
            )}
          />
        )
        if (readOnly) {
          return <span key={n}>{star}</span>
        }
        return (
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
            {star}
          </button>
        )
      })}
    </div>
  )
}

export function SessionFeedback({ sessionId, eventSlug }: SessionFeedbackProps) {
  const { user } = useAuth()
  const [data, setData] = React.useState<FeedbackResponse | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Form state
  const [rating, setRating] = React.useState(0)
  const [comment, setComment] = React.useState('')
  const [wouldAttendAgain, setWouldAttendAgain] = React.useState<boolean | null>(null)
  const [isEditing, setIsEditing] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)

  const endpoint = `/api/v1/events/${eventSlug}/sessions/${sessionId}/feedback`

  const load = React.useCallback(async () => {
    try {
      const response = await fetch(endpoint, { headers: authHeaders() })
      if (!response.ok) {
        throw new Error((await response.json().catch(() => null))?.error || 'Failed to load feedback')
      }
      const json: FeedbackResponse = await response.json()
      setData(json)
      if (json.own) {
        setRating(json.own.rating)
        setComment(json.own.comment ?? '')
        setWouldAttendAgain(json.own.would_attend_again)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feedback')
    } finally {
      setIsLoading(false)
    }
  }, [endpoint])

  // Refetch when the signed-in user changes so "own" feedback stays accurate.
  React.useEffect(() => {
    setIsLoading(true)
    load()
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
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          rating,
          comment: comment.trim() || null,
          would_attend_again: wouldAttendAgain,
        }),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(json?.error || 'Failed to save feedback')
      }
      setIsEditing(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save feedback')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Remove your feedback for this session?')) return
    setIsDeleting(true)
    setError(null)
    try {
      const response = await fetch(endpoint, { method: 'DELETE', headers: authHeaders() })
      if (!response.ok) {
        throw new Error((await response.json().catch(() => null))?.error || 'Failed to remove feedback')
      }
      setRating(0)
      setComment('')
      setWouldAttendAgain(null)
      setIsEditing(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove feedback')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
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

  // Parent only renders this once the session has started, but the API is
  // the source of truth for the window.
  if (!data.feedback_open) {
    return null
  }

  const { summary, own, feedback, can_manage: canManage, is_organizer: isOrganizer } = data
  const showForm = !!user && (!own || isEditing)
  const returnTo = `/e/${eventSlug}/sessions/${sessionId}`
  const attendAgainCount = feedback?.filter((f) => f.would_attend_again === true).length ?? 0
  const attendAgainAnswered = feedback?.filter((f) => f.would_attend_again !== null).length ?? 0

  return (
    <Card className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Session Feedback
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            How was this session? Your rating helps organizers shape future events.
          </p>
        </div>
        <div className="text-right">
          {summary.avg_rating !== null && summary.count !== null ? (
            <>
              <div className="flex items-center justify-end gap-2">
                <span className="text-2xl font-bold">{summary.avg_rating.toFixed(1)}</span>
                <StarRating value={Math.round(summary.avg_rating)} size="sm" readOnly />
              </div>
              <p className="text-xs text-muted-foreground">
                {summary.count} {summary.count === 1 ? 'rating' : 'ratings'}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground max-w-[12rem]">
              Average shown once at least 3 people have rated
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {!user && (
        <div className="rounded-lg border border-dashed p-4 text-center">
          <p className="text-sm text-muted-foreground mb-3">Sign in to rate this session</p>
          <Button asChild variant="outline" size="sm">
            <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link>
          </Button>
        </div>
      )}

      {user && own && !isEditing && (
        <div className="rounded-lg bg-muted/40 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StarRating value={own.rating} size="sm" readOnly />
              <span className="text-sm text-muted-foreground">Your rating</span>
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
              >
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          {own.would_attend_again !== null && (
            <p className="text-sm">
              {own.would_attend_again ? 'Would attend again' : 'Would not attend again'}
            </p>
          )}
          {own.comment && (
            <p className="text-sm whitespace-pre-wrap">{own.comment}</p>
          )}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Your rating</label>
            <div>
              <StarRating value={rating} onChange={setRating} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Would you attend a session like this again?</label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={wouldAttendAgain === true ? 'default' : 'outline'}
                onClick={() => setWouldAttendAgain(wouldAttendAgain === true ? null : true)}
                aria-pressed={wouldAttendAgain === true}
              >
                <ThumbsUp className="h-4 w-4 mr-1" />
                Yes
              </Button>
              <Button
                type="button"
                size="sm"
                variant={wouldAttendAgain === false ? 'default' : 'outline'}
                onClick={() => setWouldAttendAgain(wouldAttendAgain === false ? null : false)}
                aria-pressed={wouldAttendAgain === false}
              >
                <ThumbsDown className="h-4 w-4 mr-1" />
                No
              </Button>
            </div>
          </div>

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
            />
            <p className="text-xs text-muted-foreground text-right">
              {comment.length}/{MAX_COMMENT_LENGTH}
            </p>
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving || rating < 1}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
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

      {canManage && feedback && (
        <div className="border-t pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">
              Responses ({feedback.length})
            </h4>
            {attendAgainAnswered > 0 && (
              <span className="text-xs text-muted-foreground">
                {attendAgainCount}/{attendAgainAnswered} would attend again
              </span>
            )}
          </div>
          {!isOrganizer && feedback.length > 0 && (
            <p className="text-xs text-muted-foreground">Responses are shown anonymously.</p>
          )}
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">No responses yet.</p>
          ) : (
            <ul className="space-y-3">
              {feedback.map((entry) => (
                <li key={entry.id} className="rounded-lg border p-3 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StarRating value={entry.rating} size="sm" readOnly />
                      {isOrganizer && (
                        <span className="text-sm font-medium">
                          {entry.user?.display_name || 'Anonymous attendee'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {entry.would_attend_again !== null && (
                        <span className="inline-flex items-center gap-1">
                          {entry.would_attend_again ? (
                            <ThumbsUp className="h-3 w-3" />
                          ) : (
                            <ThumbsDown className="h-3 w-3" />
                          )}
                          {entry.would_attend_again ? 'Would attend again' : 'Would not attend again'}
                        </span>
                      )}
                      <span>{new Date(entry.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {entry.comment && (
                    <p className="text-sm whitespace-pre-wrap">{entry.comment}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
