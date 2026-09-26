'use client'

/**
 * Home (mobile shell design §3), in the order the design gives:
 *
 *   1. the Now line — the one bold element, and the only motion on the page
 *   2. Next for you — the next session you saved, or the next thing on; hidden before publish
 *   3. Your ballot · 4. Your proposals · 5. From the organizers
 *   6. Recently proposed · Sessions you're supporting · the assistant card
 *   7. the organizer banner, with "N of M sessions placed" while the schedule is unpublished
 *
 * The stat tiles are gone: the two counts they carried are the Now line's second line. No vote
 * totals and no leaderboard — those were removed on purpose and stay removed (spec §5.3).
 */

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Clock,
  Heart,
  Lock,
  MapPin,
  Megaphone,
  MessagesSquare,
  Mic,
  Navigation,
  Sparkles,
  UserPlus,
  Zap,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { DashboardLayout } from '@/components/DashboardLayout'
import { NowLine, type NowLineInput } from '@/components/home/NowLine'
import { useAuth } from '@/hooks/useAuth'
import { useVoting } from '@/hooks/useVoting'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'
import { AssistantCard } from '@/components/knowledge/AssistantCard'
import { apiFetch } from '@/lib/api/client'
import { directionsHref } from '@/lib/geo/directions'
import { isParticipationOpen } from '@/lib/events/lifecycle'
import { sessionStatusBadge } from '@/lib/labels'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Announcement } from '@/app/api/v1/events/[slug]/announcements/route'
import type { NextUpResponse } from '@/app/api/v1/events/[slug]/next-up/route'

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

function formatWhen(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/* ─────────────────────────── 2. Next for you ─────────────────────────── */

function NextForYou({
  next,
  kind,
  timeZone,
  eventSlug,
}: {
  next: NextUpResponse['next']
  kind: NextUpResponse['kind']
  timeZone: string
  eventSlug: string
}) {
  // `directionsPlatform` reads the user agent, so the href is only computed in the browser.
  const [href, setHref] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!next) {
      setHref(null)
      return
    }
    setHref(directionsHref({ lat: next.geo?.lat, lng: next.geo?.lng, query: next.directionsQuery }))
  }, [next])

  if (!next) return null
  return (
    <Card data-testid="next-for-you">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Next for you</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground">
          {kind === 'saved' ? 'From your saved sessions' : 'Next in the program'}
        </p>
        <Link
          href={`/e/${eventSlug}/sessions/${next.id}`}
          className="mt-1 block rounded-md font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {next.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 shrink-0" aria-hidden />
            {formatWhen(next.startsAt, timeZone)}
          </span>
          {next.room && (
            <span className="flex min-w-0 items-center gap-1.5">
              <MapPin className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{next.room}</span>
            </span>
          )}
        </div>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            <Navigation className="h-4 w-4" aria-hidden />
            {next.coarseLocation ? 'Directions to the area' : 'Get directions'}
          </a>
        )}
      </CardContent>
    </Card>
  )
}

/* ──────────────────── 6. the assistant card, collapsed ──────────────────── */

/**
 * The assistant card is one line on mobile (design §3.6): a row with "Connect" that reveals the
 * card in place. On `md` and up the card is simply there, as it always was.
 */
function AssistantSection({ gatheringName }: { gatheringName: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      {!open && (
        <Card className="md:hidden" data-testid="assistant-collapsed">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <p className="min-w-0 text-sm font-medium">Use your own AI assistant here</p>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Connect
            </Button>
          </CardContent>
        </Card>
      )}
      <AssistantCard gatheringName={gatheringName} className={cn(!open && 'hidden md:block')} />
    </>
  )
}

/* ─────────────────────────────── the page ─────────────────────────────── */

function Dashboard({ data }: { data: DashboardData }) {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { isMember, joinable, joinBlockedBy } = useEventRole()
  const voting = useVoting(event.slug)
  const attendance = useVoting(event.slug, 'attendance')
  const proposalsOpen = isParticipationOpen(event, 'propose')
  const schedulePublished = !!event.schedulePublishedAt

  // The server rendered for whoever held the cookie then; re-render after sign-in/out.
  const renderedFor = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    if (authLoading) return
    const id = user?.id ?? null
    if (renderedFor.current !== undefined && renderedFor.current !== id) router.refresh()
    renderedFor.current = id
  }, [authLoading, user?.id, router])

  const [nextUp, setNextUp] = React.useState<NextUpResponse | null>(null)
  React.useEffect(() => {
    let mounted = true
    apiFetch<NextUpResponse>(`/api/v1/events/${encodeURIComponent(event.slug)}/next-up`, { cache: 'no-store' })
      .then((res) => {
        if (mounted) setNextUp(res)
      })
      .catch(() => {
        if (mounted) setNextUp(null)
      })
    return () => {
      mounted = false
    }
  }, [event.slug, user?.id])

  const [announcements, setAnnouncements] = React.useState<Announcement[]>([])
  React.useEffect(() => {
    if (!user) {
      setAnnouncements([])
      return
    }
    let mounted = true
    apiFetch<{ announcements: Announcement[] }>(
      `/api/v1/events/${encodeURIComponent(event.slug)}/announcements?limit=3`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (mounted) setAnnouncements(Array.isArray(res?.announcements) ? res.announcements : [])
      })
      .catch(() => {
        if (mounted) setAnnouncements([])
      })
    return () => {
      mounted = false
    }
  }, [event.slug, user?.id])

  // "N of M sessions placed", while the schedule is unpublished (design §3.7).
  const [placed, setPlaced] = React.useState<{ filled: number; slots: number } | null>(null)
  React.useEffect(() => {
    if (!data.isOrganizer || schedulePublished) {
      setPlaced(null)
      return
    }
    let mounted = true
    apiFetch<{ schedule?: { filledSlots?: number; sessionSlots?: number } }>(
      `/api/v1/events/${encodeURIComponent(event.slug)}/admin/overview`,
      { cache: 'no-store' },
    )
      .then((res) => {
        if (!mounted) return
        const filled = res?.schedule?.filledSlots
        const slots = res?.schedule?.sessionSlots
        setPlaced(typeof filled === 'number' && typeof slots === 'number' ? { filled, slots } : null)
      })
      .catch(() => {
        if (mounted) setPlaced(null)
      })
    return () => {
      mounted = false
    }
  }, [data.isOrganizer, schedulePublished, event.slug])

  const supported = Object.entries(voting.allocation)
  const titles = new Map(voting.sessions.map((s) => [s.id, s]))
  const votesCast = supported.reduce((sum, [, v]) => sum + v, 0)

  const nowInput: NowLineInput = {
    slug: event.slug,
    name: event.name,
    eventStatus: event.status,
    schedulePublished,
    voting: {
      status: voting.status,
      opensAt: voting.round?.opensAt ?? null,
      closesAt: voting.round?.closesAt ?? null,
      remaining: voting.signedIn ? voting.remaining : null,
    },
    attendance: {
      open: attendance.signedIn && attendance.attendanceOpen && attendance.status === 'open',
      live: nextUp?.live.total ?? attendance.votableNow.size,
      liveSaved: nextUp?.live.saved ?? 0,
    },
    saved: data.favorites,
    sessions: data.stats.sessions,
    participants: data.stats.participants,
    feedbackOpen: !!nextUp?.feedbackOpen,
  }

  /**
   * The organizer banner (§3.7): what is still waiting on them, and — while the schedule is
   * unpublished — how much of the grid is filled. "2 of 2 placed" with nothing pending is not a
   * chore, so it becomes the nudge to publish instead.
   */
  const pendingCount = data.stats.pending ?? 0
  const roomToPlace = !!placed && placed.slots > 0 && placed.filled < placed.slots
  const organizerTodo = {
    heading: pendingCount > 0 || roomToPlace ? 'Still to do' : 'Ready to publish',
    detail: [
      pendingCount > 0 ? `${plural(pendingCount, 'session')} awaiting review` : null,
      placed && placed.slots > 0
        ? roomToPlace
          ? `${placed.filled} of ${placed.slots} sessions placed`
          : `all ${plural(placed.filled, 'session')} placed`
        : null,
    ]
      .filter(Boolean)
      .join(', '),
  }
  const showOrganizerBanner = data.isOrganizer && (pendingCount > 0 || (!!placed && placed.slots > 0))

  const showJoinCard = Boolean(user) && !isMember && (joinable === true || joinBlockedBy === 'ticket-required')
  const nothingYet =
    data.stats.sessions === 0 &&
    data.recentSessions.length === 0 &&
    data.mySessions.length === 0 &&
    supported.length === 0

  return (
    <div className="space-y-6">
      <NowLine input={nowInput} />

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

      {/* 2. Next for you — nothing to point at before the schedule is out. */}
      {schedulePublished && nextUp && (
        <NextForYou next={nextUp.next} kind={nextUp.kind} timeZone={event.timezone} eventSlug={event.slug} />
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

      {/* 3. Your ballot. */}
      {user && isMember && voting.status !== 'none' && (
        <Card accent="left" accentColor="hsl(var(--signal))" data-testid="your-ballot">
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
                Ballots are sealed: nobody, not even you, can see how anyone voted.
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

      {/* 4. Your proposals — one card for every status, pending included. */}
      {user && data.mySessions.length > 0 && (
        <Card data-testid="your-proposals">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Mic className="h-5 w-5 text-primary" aria-hidden />
                Your proposals
              </CardTitle>
              <ViewAll href={`/e/${event.slug}/sessions?filter=mine`} />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.mySessions.slice(0, 6).map((session) => {
                const status = sessionStatusBadge(session.status)
                return (
                  <li key={session.id}>
                    <Link
                      href={`/e/${event.slug}/sessions/${session.id}`}
                      className="flex items-start justify-between gap-2 rounded-lg p-2.5 transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{session.title}</span>
                        <span className="block text-xs capitalize text-muted-foreground">
                          {session.format || 'session'}
                        </span>
                      </span>
                      <Badge variant={status.badge} className="flex-shrink-0">
                        {status.label}
                      </Badge>
                    </Link>
                  </li>
                )
              })}
            </ul>
            {data.mySessions.some((s) => s.status === 'pending') && (
              <p className="mt-3 text-xs text-muted-foreground">
                Organizers are reviewing what is marked awaiting review. You can still edit it while it waits.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 5. From the organizers. */}
      {announcements.length > 0 && (
        <Card data-testid="from-the-organizers">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Megaphone className="h-5 w-5 text-primary" aria-hidden />
                From the organizers
              </CardTitle>
              <ViewAll href={`/e/${event.slug}/notifications`} label="All notifications" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-3">
              {announcements.map((a) => (
                <li key={a.id}>
                  <p className="font-medium">{a.title}</p>
                  {a.body && <p className="text-sm text-muted-foreground">{a.body}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* 6. Recently proposed. */}
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
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate group-hover:text-primary transition-colors">{session.title}</p>
                      {session.host_display_name && (
                        <p className="truncate text-xs text-muted-foreground">{session.host_display_name}</p>
                      )}
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

      {/* Sessions you're supporting — your own votes, never anyone else's. */}
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
            <ul className="grid gap-2 sm:grid-cols-2">
              {supported
                .sort(([, a], [, b]) => b - a)
                .slice(0, 6)
                .map(([id, votes]) => (
                  <li key={id}>
                    <Link
                      href={`/e/${event.slug}/sessions/${id}`}
                      className="flex items-center justify-between gap-3 rounded-lg p-2.5 transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{titles.get(id)?.title ?? 'Session'}</span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {plural(votes, 'vote')} from you
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Discoverability (design 2026-09-25 §2.3a): members can point their own assistant here. */}
      {user && isMember && <AssistantSection gatheringName={event.name} />}

      {/* 7. Organizer banner. */}
      {showOrganizerBanner && (
        <Card className="border-signal-amber/30 bg-signal-amber/5" data-testid="organizer-banner">
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-signal-amber/10">
                  <Clock className="h-6 w-6 text-signal-amber" aria-hidden />
                </div>
                <div>
                  <h2 className="font-semibold">{organizerTodo.heading}</h2>
                  <p className="text-sm text-muted-foreground">{organizerTodo.detail}</p>
                </div>
              </div>
              <Button asChild>
                <Link href={`/e/${event.slug}/admin`}>Organizer workspace</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
