'use client'

/**
 * My Votes — the signed-in participant's OWN ballot, nothing else.
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
import { ClipboardList, Loader2, Lock, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DashboardLayout } from '@/components/DashboardLayout'
import { VoteControl } from '@/components/VoteControl'
import { useAuth } from '@/hooks/useAuth'
import { useVoting, type VotingRound } from '@/hooks/useVoting'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { voteCost } from '@/lib/voting/mechanism'

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
      <div>
        <h1 className="text-2xl font-bold">My Votes</h1>
        <p className="text-muted-foreground mt-1">{subtitle}</p>
      </div>

      {voting.error && (
        // Announced by the control that caused it; shown here too so it is not missed.
        <p className="rounded-xl bg-destructive/10 p-4 text-destructive">
          {voting.error}
        </p>
      )}

      {status === 'closed' && round ? (
        <ClosedRound round={round} eventSlug={event.slug} />
      ) : (
        <>
          <Card>
            <CardContent className="p-6">
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div className="flex flex-col-reverse">
                  <dt className="text-sm text-muted-foreground">Sessions supported</dt>
                  <dd className="text-3xl font-bold text-primary">{votedIds.length}</dd>
                </div>
                <div className="flex flex-col-reverse">
                  <dt className="text-sm text-muted-foreground">{mechanism === 'approval' ? 'Approvals' : 'Votes'}</dt>
                  <dd className="text-3xl font-bold">{totalVotes}</dd>
                </div>
                <div className="flex flex-col-reverse">
                  <dt className="text-sm text-muted-foreground">Credits used</dt>
                  <dd className="text-3xl font-bold">{spent}</dd>
                </div>
                <div className="flex flex-col-reverse">
                  <dt className="text-sm text-muted-foreground">Credits remaining</dt>
                  <dd className="text-3xl font-bold text-primary">{status === 'none' ? '—' : `${remaining}/${budget}`}</dd>
                </div>
              </dl>
              {mechanism === 'quadratic' && (
                <p className="mt-4 text-xs text-muted-foreground text-center">
                  Quadratic voting: n votes on one session cost n² credits, so spreading support is cheaper than piling it on.
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground text-center">
                Only you can see this. Organizers see no counts while voting is open, and when it closes your ballot is sealed.
              </p>
            </CardContent>
          </Card>

          {votedIds.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <ClipboardList className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden />
                <h2 className="text-lg font-semibold mb-2">No votes yet</h2>
                <p className="text-muted-foreground mb-4">
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
                      <Card className="hover:border-primary/50 transition-all">
                        <CardContent className="p-4">
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <Link href={`/e/${event.slug}/sessions/${id}`} className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                {session?.format && (
                                  <Badge variant="secondary" className="capitalize text-xs">
                                    {session.format}
                                  </Badge>
                                )}
                                {session?.track && (
                                  <span className="text-xs text-muted-foreground truncate">{session.track.name}</span>
                                )}
                              </div>
                              <h3 className="font-medium truncate hover:text-primary transition-colors">
                                {session?.title ?? 'Session'}
                              </h3>
                              <p className="text-xs text-muted-foreground">
                                {votes} {votes === 1 ? 'vote' : 'votes'} · {voteCost(votes, mechanism ?? 'quadratic')} credits
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
        <CardContent className="p-6 flex gap-4 items-start">
          <Lock className="h-6 w-6 text-primary flex-shrink-0 mt-0.5" aria-hidden />
          <div className="space-y-2">
            <h2 className="font-semibold">Your ballot is sealed</h2>
            <p className="text-sm text-muted-foreground">
              Voting closed {formatWhen(round.finalizedAt ?? round.closesAt)}. Your votes were counted, and the record
              that tied them to you was deleted in the same step — nobody, including you and the organizers, can
              see how you voted any more.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card id="tally">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Public tally</CardTitle>
            <a href={tallyUrl} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground underline underline-offset-2">
              Public tally data <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!tally && !error && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading tally" />}
          {tally && (
            <>
              <p className="text-sm text-muted-foreground">
                {tally.ballotsCast} {tally.ballotsCast === 1 ? 'person' : 'people'} voted. Sessions supported by fewer than {tally.k}{' '}
                people show no numbers, so a single person&apos;s choice is never published. Listed alphabetically — the tally is not a ranking.
              </p>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sessions were open for voting.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((entry) => (
                    <li key={entry.sessionId} className="flex items-center justify-between gap-4 py-2">
                      <Link href={`/e/${eventSlug}/sessions/${entry.sessionId}`} className="min-w-0 truncate hover:text-primary">
                        {tally.sessions[entry.sessionId].title}
                      </Link>
                      <span className="text-sm tabular-nums text-muted-foreground flex-shrink-0">
                        {entry.suppressed
                          ? `fewer than ${tally.k} voters`
                          : `${entry.votes} votes · ${entry.voters} voters`}
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
