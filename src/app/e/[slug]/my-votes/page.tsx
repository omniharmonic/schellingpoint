'use client'

/**
 * My votes — the signed-in participant's OWN ballot, nothing else.
 *
 * While a round is open: each session they support, with the vote control and their
 * credit use. Never anyone else's votes and never a live total (spec §5.3).
 * After the round closes: the ballot is sealed — the ledger that linked them to their
 * votes has been deleted, so not even they can see it — and the public, k-suppressed
 * tally is shown instead.
 */
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ClipboardList, Loader2, Lock, Download } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { DashboardLayout } from '@/components/DashboardLayout'
import { VoteControl } from '@/components/VoteControl'
import { useAuth } from '@/hooks/useAuth'
import { useVoting, type VotingRound } from '@/hooks/useVoting'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { voteCost } from '@/lib/voting/mechanism'
import { plural } from '@/lib/format'
import { HELP_PRIVACY, LEARN_MORE } from '@/lib/labels'
import { formatLabel } from '@/lib/sessions/constants'

export default function MyVotesPage() {
  return (
    <DashboardLayout>
      <MyVotes />
    </DashboardLayout>
  )
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function Stat({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={highlight ? 'stat-value text-primary' : 'stat-value'}>{value}</dd>
    </div>
  )
}

function MyVotes() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const voting = useVoting(event.slug)

  React.useEffect(() => {
    if (!authLoading && !user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/my-votes`)}`)
    }
  }, [user, authLoading, router, event.slug])

  if (authLoading || !user || voting.loading) {
    return (
      <div className="flex items-center justify-center py-12" role="status" aria-label="Loading your votes">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const { round, status, allocation, spent, remaining, budget, mechanism } = voting
  const votedIds = Object.keys(allocation)
  const titles = new Map(voting.sessions.map((s) => [s.id, s]))
  const totalVotes = Object.values(allocation).reduce((sum, v) => sum + v, 0)

  let subtitle: string
  if (status === 'open') subtitle = voting.canVote ? `Voting closes ${formatWhen(round!.closesAt)}.` : (voting.reason ?? 'Voting is not open right now.')
  else if (status === 'upcoming') subtitle = `Voting opens ${formatWhen(round!.opensAt)}.`
  else if (status === 'closed') subtitle = 'Voting has closed.'
  else subtitle = 'Voting has not opened for this gathering yet.'

  return (
    <div className="space-y-6">
      <PageHeader title="My votes" subtitle={subtitle} />

      {voting.error && (
        // Announced by the control that caused it; shown here too so it is not missed.
        <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {voting.error}
        </p>
      )}

      {status === 'closed' && round ? (
        <ClosedRound round={round} eventSlug={event.slug} />
      ) : (
        <>
          <Card>
            <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
              <dl className="grid grid-cols-2 gap-4 text-center md:grid-cols-4">
                <Stat label="Sessions supported" value={votedIds.length} highlight />
                <Stat label={mechanism === 'approval' ? 'Approvals' : 'Votes'} value={totalVotes} />
                <Stat label="Credits used" value={spent} />
                <Stat label={`Credits remaining${status === 'none' ? '' : ` of ${budget}`}`} value={status === 'none' ? '—' : remaining} highlight />
              </dl>
              {mechanism === 'quadratic' && (
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Quadratic voting: n votes on one session cost n² credits, so spreading support is cheaper than piling it on.
                </p>
              )}
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Only you can see this. Nobody sees a count while voting is open, and nobody can see how you voted once it closes.
              </p>
            </CardContent>
          </Card>

          {votedIds.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <ClipboardList className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
                <h2 className="mb-2 text-lg font-semibold">No votes yet</h2>
                <p className="mb-4 text-muted-foreground">
                  {voting.canVote ? 'Browse sessions and support the ones you want to happen.' : 'You can still explore the sessions taking shape.'}
                </p>
                <Button asChild>
                  <Link href={`/e/${event.slug}/sessions`}>Browse sessions</Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <section aria-labelledby="my-votes-list" className="space-y-3">
              <h2 id="my-votes-list" className="font-semibold">Your ballot</h2>
              <ul className="space-y-3">
                {votedIds
                  .map((id) => ({ id, votes: allocation[id], session: titles.get(id) }))
                  .sort((a, b) => (a.session?.title ?? '').localeCompare(b.session?.title ?? ''))
                  .map(({ id, votes, session }) => (
                    <li key={id}>
                      <Card className="transition-all hover:border-primary/50">
                        <CardContent className="p-4 pt-4">
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <Link href={`/e/${event.slug}/sessions/${id}`} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <div className="mb-1 flex items-center gap-2">
                                {session?.format && <Badge variant="secondary">{formatLabel(session.format)}</Badge>}
                                {session?.track && <span className="truncate text-xs text-muted-foreground">{session.track.name}</span>}
                              </div>
                              <h3 className="truncate font-medium transition-colors hover:text-primary">
                                {session?.title ?? 'Session'}
                              </h3>
                              <p className="text-xs text-muted-foreground">
                                {plural(votes, 'vote')} · {plural(voteCost(votes, mechanism ?? 'quadratic'), 'credit')}
                              </p>
                            </Link>
                            <VoteControl eventSlug={event.slug} sessionId={id} sessionTitle={session?.title} />
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

interface TallyResponse {
  k: number
  ballotsCast: number
  entries: Array<{ sessionId: string; suppressed: true } | { sessionId: string; suppressed: false; voters: number; votes: number; credits: number }>
  sessions: Record<string, { title: string; format: string | null }>
}

function ClosedRound({ round, eventSlug }: { round: VotingRound; eventSlug: string }) {
  const tallyUrl = `/api/v1/events/${encodeURIComponent(eventSlug)}/rounds/${round.id}/tally`
  const [tally, setTally] = React.useState<TallyResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    apiFetch<TallyResponse>(tallyUrl, { cache: 'no-store' })
      .then((t) => !cancelled && setTally(t))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'The tally is unavailable right now.'))
    return () => {
      cancelled = true
    }
  }, [tallyUrl])

  const rows = tally
    ? tally.entries
        .filter((e) => tally.sessions[e.sessionId])
        .sort((a, b) => tally.sessions[a.sessionId].title.localeCompare(tally.sessions[b.sessionId].title))
    : []

  return (
    <>
      <Card>
        <CardContent className="flex items-start gap-4 p-4 pt-4 sm:p-6 sm:pt-6">
          <Lock className="mt-0.5 h-6 w-6 shrink-0 text-primary" aria-hidden />
          <div className="space-y-2">
            <h2 className="font-semibold">Voting is closed</h2>
            <p className="text-sm text-muted-foreground">
              Voting closed {formatWhen(round.finalizedAt ?? round.closesAt)} and your votes were counted. Nobody can
              see how you voted any more — not you, not the organizers.{' '}
              <Link href={HELP_PRIVACY.never} className="underline">{LEARN_MORE}</Link>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card id="tally">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Public tally</CardTitle>
            <Button asChild variant="outline" size="sm">
              <a href={tallyUrl} download={`tally-${round.id}.json`}>
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Download tally (JSON)
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!tally && !error && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading tally" />}
          {tally && (
            <>
              <p className="text-sm text-muted-foreground">
                {plural(tally.ballotsCast, 'person', 'people')} voted. Listed alphabetically, not ranked, and a session
                supported by fewer than {tally.k} people shows no number.
              </p>
              {rows.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">No sessions were open for voting.</p>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/e/${eventSlug}/sessions`}>Browse sessions</Link>
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((entry) => (
                    <li key={entry.sessionId} className="flex items-center justify-between gap-4 py-2">
                      <Link href={`/e/${eventSlug}/sessions/${entry.sessionId}`} className="min-w-0 truncate hover:text-primary">
                        {tally.sessions[entry.sessionId].title}
                      </Link>
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                        {entry.suppressed
                          ? `fewer than ${tally.k} voters`
                          : `${plural(entry.votes, 'vote')} · ${plural(entry.voters, 'voter')}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
