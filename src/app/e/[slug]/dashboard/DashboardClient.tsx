'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Clock,
  Heart,
  Lock,
  Mic,
  Presentation,
  MessagesSquare,
  Users,
  Vote,
  Zap,
  Sparkles,
  UserPlus,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useAuth, viewerDisplayName } from '@/hooks/useAuth'
import { useVoting } from '@/hooks/useVoting'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'
import { isParticipationOpen } from '@/lib/events/lifecycle'
import { sessionStatusBadge } from '@/lib/labels'
import { plural, SEPARATOR } from '@/lib/format'

export interface DashboardData {
  stats: {
    /** Approved + scheduled sessions. */
    sessions: number
    scheduled: number
    /** Awaiting review; organizers only. */
    pending: number | null
    /** Members of the gathering; members only. */
    participants: number | null
  }
  recentSessions: Array<{
    id: string
    title: string
    format: string | null
    status: string
    created_at: string
    host_display_name: string | null
    track: { name: string; color: string | null } | null
  }>
  /** Sessions the viewer hosts or co-hosts, every status. */
  mySessions: Array<{
    id: string
    title: string
    description: string | null
    format: string | null
    status: string
    created_at: string
  }>
  favorites: number
  isOrganizer: boolean
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function DashboardClient({ data }: { data: DashboardData }) {
  return (
    <DashboardLayout>
      <Dashboard data={data} />
    </DashboardLayout>
  )
}

/** The one "View all" treatment for every card header on this page. */
function ViewAll({ href, label = 'View all' }: { href: string; label?: string }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={href} className="text-muted-foreground">
        {label} <ArrowRight className="h-4 w-4 ml-1" aria-hidden="true" />
      </Link>
    </Button>
  )
}

function Dashboard({ data }: { data: DashboardData }) {
  const router = useRouter()
  const { user, profile, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { isMember, joinable, joinBlockedBy } = useEventRole()
  const voting = useVoting(event.slug)
  const proposalsOpen = isParticipationOpen(event, 'propose')

  // The server rendered for whoever held the cookie then; re-render after sign-in/out.
  const renderedFor = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    if (authLoading) return
    const id = user?.id ?? null
    if (renderedFor.current !== undefined && renderedFor.current !== id) router.refresh()
    renderedFor.current = id
  }, [authLoading, user?.id, router])

  const pendingMine = data.mySessions.filter((s) => s.status === 'pending')
  const liveMine = data.mySessions.filter((s) => s.status !== 'pending')
  const supported = Object.entries(voting.allocation)
  const titles = new Map(voting.sessions.map((s) => [s.id, s]))
  const votesCast = supported.reduce((sum, [, v]) => sum + v, 0)

  let votingHeadline: string
  let votingDetail: string
  switch (voting.status) {
    case 'open':
      votingHeadline = 'Open'
      votingDetail = voting.round ? `closes ${formatWhen(voting.round.closesAt)}` : 'now'
      break
    case 'upcoming':
      votingHeadline = 'Soon'
      votingDetail = voting.round ? `opens ${formatWhen(voting.round.opensAt)}` : ''
      break
    case 'closed':
      votingHeadline = 'Closed'
      votingDetail = 'results published as a public tally'
      break
    default:
      votingHeadline = 'Not open'
      votingDetail = 'voting has not started'
  }

  const showJoinCard = Boolean(user) && !isMember && (joinable === true || joinBlockedBy === 'ticket-required')
  const nothingYet =
    data.stats.sessions === 0 && data.recentSessions.length === 0 && data.mySessions.length === 0 && supported.length === 0

  return (
    <div className="space-y-6">
      <PageHeader
        className="dashboard-welcome mb-0"
        title={user ? `Welcome back, ${viewerDisplayName(profile, user)}` : 'Your gathering'}
        subtitle={`Find your people. Follow your curiosity. Make ${event.name} your own.`}
      />

      {showJoinCard && (
        <Card accent="left" accentColor="hsl(var(--signal))">
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-lg bg-primary/10">
                  <UserPlus className="h-6 w-6 text-primary" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="font-semibold">Join this gathering</h2>
                  <p className="text-sm text-muted-foreground">
                    Proposing sessions, voting and the people directory are for members. Joining is never published.
                  </p>
                </div>
              </div>
              <JoinGatheringButton />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="dashboard-stats grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="stats-card" accent="top" accentColor="hsl(var(--signal))">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs text-muted-foreground">Sessions</CardTitle>
            <Presentation className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          </CardHeader>
          <CardContent>
            <div className="stat-value tabular-nums">{data.stats.sessions}</div>
            <p className="text-xs text-muted-foreground mt-1">{data.stats.scheduled} scheduled</p>
          </CardContent>
        </Card>

        <Card className="stats-card" accent="top" accentColor="hsl(var(--signal-amber))">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs text-muted-foreground">Voting</CardTitle>
            <Vote className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{votingHeadline}</div>
            <p className="text-xs text-muted-foreground mt-1">{votingDetail}</p>
          </CardContent>
        </Card>

        {data.stats.participants !== null && (
          <Card className="stats-card" accent="top" accentColor="hsl(var(--signal-cyan))">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs text-muted-foreground">Participants</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} aria-hidden />
            </CardHeader>
            <CardContent>
              <div className="stat-value tabular-nums">{data.stats.participants}</div>
              <p className="text-xs text-muted-foreground mt-1">people shaping the gathering</p>
            </CardContent>
          </Card>
        )}

        {user && voting.status !== 'none' && voting.status !== 'closed' && (
          <Card className="stats-card" accent="top" accentColor="hsl(var(--signal))">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs text-muted-foreground">Your credits</CardTitle>
              <Vote className="h-4 w-4 text-primary" strokeWidth={1.5} aria-hidden />
            </CardHeader>
            <CardContent>
              <div className="stat-value tabular-nums text-primary">{voting.remaining}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {voting.spent} of {voting.budget} allocated
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {user && isMember && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card interactive>
            <Link href={`/e/${event.slug}/sessions`} className="block">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-primary/10">
                    <Vote className="h-6 w-6 text-primary" aria-hidden />
                  </div>
                  <div>
                    <h2 className="font-semibold">{voting.canVote ? 'Vote on sessions' : 'Explore sessions'}</h2>
                    <p className="text-sm text-muted-foreground">
                      {voting.canVote ? `${plural(voting.remaining, 'credit')} remaining` : 'Discover the ideas taking shape'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Link>
          </Card>

          <Card interactive>
            <Link href={`/e/${event.slug}/my-schedule`} className="block">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-primary/10">
                    <Heart className="h-6 w-6 text-primary" aria-hidden />
                  </div>
                  <div>
                    <h2 className="font-semibold">My schedule</h2>
                    <p className="text-sm text-muted-foreground">{plural(data.favorites, 'session')} saved</p>
                  </div>
                </div>
              </CardContent>
            </Link>
          </Card>

          <Card interactive>
            <Link href={`/e/${event.slug}/${proposalsOpen ? 'propose' : 'participants'}`} className="block">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-primary/10">
                    <Presentation className="h-6 w-6 text-primary" aria-hidden />
                  </div>
                  <div>
                    <h2 className="font-semibold">{proposalsOpen ? 'Propose a session' : 'Find your people'}</h2>
                    <p className="text-sm text-muted-foreground">
                      {proposalsOpen ? 'Share your knowledge' : 'Connect with the community'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Link>
          </Card>
        </div>
      )}

      {nothingYet && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">Nothing here yet — here’s what to do first</h2>
                <ol className="mt-2 space-y-1.5 text-sm text-muted-foreground list-decimal pl-5">
                  {proposalsOpen && <li>Propose a session around something you want to share or explore.</li>}
                  <li>Meet the people who are already here on the People page.</li>
                  <li>Save sessions to your schedule as ideas come in; voting opens when the organizers say so.</li>
                  {data.isOrganizer && <li>As an organizer, add rooms and times so the schedule can take shape.</li>}
                </ol>
                <div className="mt-4 flex flex-wrap gap-2">
                  {proposalsOpen && isMember && (
                    <Button asChild size="sm">
                      <Link href={`/e/${event.slug}/propose`}>Propose a session</Link>
                    </Button>
                  )}
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/e/${event.slug}/participants`}>People</Link>
                  </Button>
                  {data.isOrganizer && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/e/${event.slug}/admin`}>Organizer workspace</Link>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {user && isMember && voting.status !== 'none' && (
        <Card accent="left" accentColor="hsl(var(--signal))" className="stats-card">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" aria-hidden />
                Your ballot
              </h2>
              <ViewAll href={`/e/${event.slug}/my-votes`} label={voting.status === 'closed' ? 'See the tally' : 'View all'} />
            </div>
            {voting.status === 'closed' ? (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Lock className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden />
                Voting has closed and ballots are sealed: nobody, including you, can see how anyone voted. The public tally
                shows the result.
              </p>
            ) : (
              <>
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="flex flex-col-reverse">
                    <dt className="text-xs text-muted-foreground">Sessions supported</dt>
                    <dd className="text-2xl sm:text-3xl font-bold tabular-nums text-primary">{supported.length}</dd>
                  </div>
                  <div className="flex flex-col-reverse">
                    <dt className="text-xs text-muted-foreground">Votes cast</dt>
                    <dd className="text-2xl sm:text-3xl font-bold tabular-nums">{votesCast}</dd>
                  </div>
                  <div className="flex flex-col-reverse">
                    <dt className="text-xs text-muted-foreground">Credits used</dt>
                    <dd className="text-2xl sm:text-3xl font-bold tabular-nums">{voting.spent}</dd>
                  </div>
                  <div className="flex flex-col-reverse">
                    <dt className="text-xs text-muted-foreground">Credits remaining</dt>
                    <dd className="text-2xl sm:text-3xl font-bold tabular-nums text-primary">{voting.remaining}</dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground tracking-wider" id="dashboard-credit-usage">Credit usage</span>
                    <span className="font-medium tabular-nums">
                      {voting.spent}/{voting.budget}
                    </span>
                  </div>
                  <Progress
                    value={voting.budget > 0 ? (voting.spent / voting.budget) * 100 : 0}
                    className="h-2"
                    aria-labelledby="dashboard-credit-usage"
                  />
                </div>
                {!voting.canVote && voting.reason && <p className="mt-3 text-xs text-muted-foreground">{voting.reason}</p>}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {user && pendingMine.length > 0 && (
        <Card className="border-signal-amber/30 bg-signal-amber/5">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="h-5 w-5 text-signal-amber" aria-hidden />
                My pending proposals
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="amber">Awaiting review</Badge>
                <ViewAll href={`/e/${event.slug}/sessions?filter=mine`} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {pendingMine.map((session) => {
                const status = sessionStatusBadge(session.status)
                return (
                  <Link
                    key={session.id}
                    href={`/e/${event.slug}/sessions/${session.id}`}
                    className="block p-4 rounded-lg border border-signal-amber/20 bg-background/50 hover:border-signal-amber/50 hover:bg-muted/30 transition-all"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-medium line-clamp-2">{session.title}</p>
                      <Badge variant={status.badge} className="flex-shrink-0">{status.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{session.description || 'No description'}</p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="capitalize">{session.format || 'session'}</span>
                      <span>{new Date(session.created_at).toLocaleDateString()}</span>
                    </div>
                  </Link>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Your proposals are being reviewed by organizers. You can still open and edit them while they wait. Once
              approved they’ll appear in the sessions list.
            </p>
          </CardContent>
        </Card>
      )}

      {data.recentSessions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessagesSquare className="h-5 w-5 text-primary" aria-hidden />
                Recently proposed
              </CardTitle>
              <ViewAll href={`/e/${event.slug}/sessions?sort=recent`} />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.recentSessions.map((session) => (
                <li key={session.id}>
                  <Link
                    href={`/e/${event.slug}/sessions/${session.id}`}
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                  >
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      <MessagesSquare className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate group-hover:text-primary transition-colors">{session.title}</p>
                      <div className="flex items-center text-xs text-muted-foreground overflow-hidden">
                        {session.host_display_name && <span className="truncate">{session.host_display_name}</span>}
                        {session.host_display_name && <span className="flex-shrink-0" aria-hidden>{SEPARATOR}</span>}
                        <span className="flex-shrink-0">{new Date(session.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {session.format && (
                      <Badge variant="secondary" className="capitalize flex-shrink-0">
                        {session.format}
                      </Badge>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {user && liveMine.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Mic className="h-5 w-5 text-primary" aria-hidden />
                My sessions
              </CardTitle>
              <ViewAll href={`/e/${event.slug}/sessions?filter=mine`} />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {liveMine.map((session) => {
                const status = sessionStatusBadge(session.status)
                return (
                  <Link
                    key={session.id}
                    href={`/e/${event.slug}/sessions/${session.id}`}
                    className="p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 transition-all group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-medium line-clamp-2 group-hover:text-primary transition-colors">{session.title}</p>
                      <Badge variant={status.badge} className="flex-shrink-0">{status.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground capitalize">{session.format || 'session'}</p>
                  </Link>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {user && supported.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Heart className="h-5 w-5 text-favorite" aria-hidden />
                Sessions you’re supporting
              </CardTitle>
              <ViewAll href={`/e/${event.slug}/my-votes`} />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {supported
                .sort(([, a], [, b]) => b - a)
                .slice(0, 6)
                .map(([id, votes]) => (
                  <Link
                    key={id}
                    href={`/e/${event.slug}/sessions/${id}`}
                    className="p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 transition-all group"
                  >
                    <p className="font-medium line-clamp-2 group-hover:text-primary transition-colors mb-2">
                      {titles.get(id)?.title ?? 'Session'}
                    </p>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Your votes</span>
                      <span className="font-semibold text-primary">{votes}</span>
                    </div>
                  </Link>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data.isOrganizer && data.stats.pending !== null && data.stats.pending > 0 && (
        <Card className="border-signal-amber/30 bg-signal-amber/5">
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-signal-amber/10">
                  <Clock className="h-6 w-6 text-signal-amber" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold">Awaiting review</h2>
                  <p className="text-sm text-muted-foreground">{plural(data.stats.pending, 'session')} waiting for a decision</p>
                </div>
              </div>
              <Button asChild>
                <Link href={`/e/${event.slug}/admin`}>Review proposals</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
