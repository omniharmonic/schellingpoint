'use client'

/**
 * "How did my session do?" — the host-facing panel on a session page (PRD §3.2).
 *
 * It is shown to the host, their accepted co-hosts and the organizers, and to nobody else.
 * Three numbers a host can act on, and two absences the panel says out loud rather than
 * leaving as a mystery:
 *
 *   · while a voting round is open there is no count to show, because no count leaves the
 *     database until the round is sealed — organizers included (spec §5.3);
 *   · below the gathering's k, the tally and the feedback summary stay suppressed, because a
 *     count drawn from two people is a count that names them.
 */

import * as React from 'react'
import { BarChart3, Loader2, Lock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch, ApiError } from '@/lib/api/client'

interface HostAnalytics {
  sessionId: string
  k: number
  rsvps: number
  waitlist: number
  favorites: number
  tally: { voters: number; votes: number; credits: number } | null
  sealed: boolean
  feedback: { released: boolean; count?: number; avgRating?: number; wouldAttendAgain?: { yes: number; no: number }; status: string }
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="rounded-xl border bg-card p-4">
    <p className="text-2xl font-semibold tabular-nums">{value}</p>
    <p className="text-sm text-muted-foreground">{label}</p>
    {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
  </div>
}

export function HostSessionAnalytics({ eventSlug, sessionId }: { eventSlug: string; sessionId: string }) {
  const [data, setData] = React.useState<HostAnalytics | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    apiFetch<HostAnalytics>(`/api/v1/events/${encodeURIComponent(eventSlug)}/sessions/${sessionId}/host-analytics`, { cache: 'no-store' })
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'These numbers could not be loaded.') })
    return () => { cancelled = true }
  }, [eventSlug, sessionId])

  if (error) return null

  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-lg">
        <BarChart3 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        How your session is doing
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
      {!data ? (
        <div className="flex justify-center py-4" role="status" aria-label="Loading your session’s numbers"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="RSVPs" value={data.rsvps} />
          <Stat label="On the waitlist" value={data.waitlist} />
          <Stat label="Saved it" value={data.favorites} />
        </div>

        <div className="rounded-xl border bg-muted/30 p-4">
          <p className="text-sm font-medium">Votes</p>
          {data.sealed ? (
            <p className="mt-1 flex items-start gap-2 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Voting is open. Nobody sees counts while it is — not you, not the organizers. They appear when the round closes.
            </p>
          ) : data.tally ? (
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground tabular-nums">{data.tally.votes}</span> votes from{' '}
              <span className="font-semibold text-foreground tabular-nums">{data.tally.voters}</span> people.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              No count yet. Either no round has closed, or fewer than {data.k} people voted for this session — below that, counts are withheld, because a number drawn from a handful of people names them.
            </p>
          )}
        </div>

        <div className="rounded-xl border bg-muted/30 p-4">
          <p className="text-sm font-medium">Feedback</p>
          {data.feedback.released ? (
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground tabular-nums">{data.feedback.count}</span> people left feedback
              {typeof data.feedback.avgRating === 'number' ? <> · average <span className="font-semibold text-foreground tabular-nums">{data.feedback.avgRating.toFixed(1)}</span> out of 5</> : null}
              {data.feedback.wouldAttendAgain ? <> · {data.feedback.wouldAttendAgain.yes} would come again</> : null}.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              {data.feedback.status === 'open'
                ? 'The feedback window is open. Nothing is shown until it closes.'
                : `Nothing to show: fewer than ${data.k} people left feedback, so the summary stays sealed. Feedback is anonymous even to organizers.`}
            </p>
          )}
        </div>
      </>}
    </CardContent>
  </Card>
}
