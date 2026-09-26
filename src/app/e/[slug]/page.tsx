import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowRight, Calendar, Globe, MapPin, MessagesSquare, Users, Vote, FileText } from 'lucide-react'
import { GatheringArtwork } from '@/components/GatheringArtwork'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { sql } from '@/lib/db'
import { formatCalendarDate, getEventAccess, isParticipationOpen, joinBlock, networkLinks, networkOf } from '@/lib/events'
import { JoinGatheringButton } from '@/contexts/EventContext'
import { isAdminRole } from '@/lib/permissions'
import { eventStatusBadge } from '@/lib/labels'
import { plural } from '@/lib/format'

/**
 * The gathering's front page. Rendered on the server for the signed-in viewer: the layout
 * has already authorized the slug (private/draft gatherings never reach here for
 * non-members), and every count below is scoped to this event.
 *
 * No vote totals appear here: while a round is open nobody sees counts (spec §5.3), and
 * afterwards the only public figures are the gathering's k-suppressed tally records.
 */

interface EventStats {
  sessionCount: number
  participantCount: number
  trackCount: number
}

interface RecentSession {
  id: string
  title: string
  format: string | null
  track_name: string | null
  track_color: string | null
}

async function loadStats(eventId: string): Promise<{ stats: EventStats; recent: RecentSession[] }> {
  const [[counts], recent] = await Promise.all([
    sql<{ sessions: number; participants: number; tracks: number }[]>`
      select
        (select count(*) from sessions where event_id = ${eventId} and status in ('approved', 'scheduled')
           and not coalesce(hidden_by_moderation, false))::int as sessions,
        (select count(*) from event_members where event_id = ${eventId})::int as participants,
        (select count(*) from tracks where event_id = ${eventId} and coalesce(is_active, true))::int as tracks
    `,
    sql<RecentSession[]>`
      select s.id, s.title, s.format, t.name as track_name, t.color as track_color
      from sessions s left join tracks t on t.id = s.track_id and t.event_id = s.event_id
      where s.event_id = ${eventId} and s.status in ('approved', 'scheduled')
        -- A session hidden by moderation is out of every listing this app serves (0033).
        and not coalesce(s.hidden_by_moderation, false)
      order by s.created_at desc
      limit 4
    `,
  ])
  return {
    stats: { sessionCount: counts?.sessions ?? 0, participantCount: counts?.participants ?? 0, trackCount: counts?.tracks ?? 0 },
    recent,
  }
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await getEventAccess(slug)
  // The layout renders the access gate; this is only reached for a viewable gathering.
  if (!access.ok) notFound()

  const { event, row, viewer, membership } = access
  const isMember = Boolean(membership)
  const isAdmin = membership ? isAdminRole(membership.role) : false
  const network = networkOf(row)
  const links = network.publishedAt ? networkLinks(network) : { profile: null, record: null }
  const [{ stats, recent }, block] = await Promise.all([
    loadStats(event.id),
    // Joining is an explicit action (spec §5.5); a page view never creates membership.
    isMember ? Promise.resolve(null) : joinBlock({ id: event.id, status: event.status, visibility: event.visibility, ticketing_enabled: event.ticketingEnabled }),
  ])
  const canJoin = Boolean(viewer) && !isMember && block === null

  const eventIsOver = event.status === 'completed' || event.status === 'archived'
  const badge = eventStatusBadge(event.status)
  const scheduleFirst = event.status === 'live' || event.status === 'completed'
  const proposing = isParticipationOpen(event, 'propose')
  const voting = isParticipationOpen(event, 'vote')
  const ticketsOpen = event.ticketingEnabled && !eventIsOver
  const showStats = stats.sessionCount + stats.participantCount + stats.trackCount > 0

  // Second CTA (the first is always "Explore …"): join, tickets, or the way back in.
  let secondary: { href: string; label: string } | null = null
  if (!canJoin) {
    if (ticketsOpen) {
      // Signed-out people go straight to sign-in instead of bouncing off the tickets page.
      secondary = viewer
        ? { href: `/e/${event.slug}/tickets`, label: 'Get tickets' }
        : { href: `/login?returnTo=${encodeURIComponent(`/e/${event.slug}/tickets`)}`, label: 'Sign in to get tickets' }
    } else if (viewer) {
      secondary = { href: `/e/${event.slug}/dashboard`, label: 'Your gathering' }
    } else {
      secondary = { href: `/login?returnTo=${encodeURIComponent(`/e/${event.slug}`)}`, label: eventIsOver ? 'Sign in to reconnect' : 'Sign in to join' }
    }
  }

  // Same labels as the workspace sidebar (DashboardLayout.getNavItems) for the same destinations.
  const quickActions = [
    proposing
      ? { href: `/e/${event.slug}/propose`, icon: FileText, label: 'Propose a session' }
      : { href: `/e/${event.slug}/sessions`, icon: FileText, label: 'Sessions' },
    { href: `/e/${event.slug}/my-votes`, icon: Vote, label: 'My votes' },
    { href: `/e/${event.slug}/schedule?view=mine`, icon: Calendar, label: 'My schedule' },
    { href: `/e/${event.slug}/participants`, icon: Users, label: 'People' },
  ]

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      <main id="event-main">
        <section className="container mx-auto px-5 py-10 sm:py-16">
          <div className="grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16 items-center">
            <div>
              <div className="flex items-center gap-3 mb-6">
                {event.logoUrl && <img src={event.logoUrl} alt="" className="h-12 w-12 rounded-xl object-contain border bg-card" />}
                <Badge variant={badge.badge}>{badge.label}</Badge>
              </div>
              <h1 className="font-display text-5xl sm:text-6xl font-semibold tracking-tight mb-5 break-words">{event.name}</h1>
              <p className="text-lg text-muted-foreground mb-7 max-w-xl leading-relaxed">
                {event.tagline || 'A gathering shaped by the people who show up. Bring your curiosity and help make it happen.'}
              </p>
              <div className="flex flex-col gap-3 text-sm text-muted-foreground mb-8">
                <span className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" aria-hidden="true" />
                  {formatCalendarDate(event.startDate, { month: 'long', day: 'numeric' })} – {formatCalendarDate(event.endDate, { month: 'long', day: 'numeric', year: 'numeric' })}
                </span>
                {event.locationName && <span className="flex items-center gap-2"><MapPin className="h-4 w-4" aria-hidden="true" />{event.locationName}</span>}
                {network.publishedAt && network.handle && (
                  <span className="flex flex-wrap items-center gap-2">
                    <Globe className="h-4 w-4" aria-hidden="true" />
                    <span className="font-mono text-xs">@{network.handle}</span>
                    {links.profile && <a href={links.profile} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">View on the network</a>}
                    {links.record && <a href={links.record} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Public record</a>}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href={`/e/${event.slug}/${scheduleFirst ? 'schedule' : 'sessions'}`}>
                    {scheduleFirst ? 'Explore the schedule' : 'Explore sessions'}<ArrowRight className="ml-3 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
                {canJoin ? (
                  <JoinGatheringButton size="lg" />
                ) : secondary ? (
                  <Button asChild variant="outline" size="lg">
                    <Link href={secondary.href}>{secondary.label}</Link>
                  </Button>
                ) : null}
              </div>
              {isAdmin && (
                <p className="mt-4 text-sm text-muted-foreground">
                  You organize this gathering.{' '}
                  <Link href={`/e/${event.slug}/admin`} className="font-medium text-primary hover:underline">
                    Organizer workspace
                  </Link>
                </p>
              )}
            </div>
            {event.bannerUrl
              ? <img src={event.bannerUrl} alt={`${event.name} artwork`} className="w-full aspect-[5/4] object-cover rounded-[2rem]" />
              : <GatheringArtwork compact />}
          </div>
        </section>

        {/* Stats strip — hidden until there is something to count */}
        {showStats && (
          <section className="border-y border-border bg-card/50" aria-label="At a glance">
            <div className="container mx-auto max-w-6xl px-4 py-6">
              <div className="grid grid-cols-3 gap-6 text-center">
                {[
                  { value: stats.sessionCount, label: 'Sessions' },
                  { value: stats.participantCount, label: 'Participants' },
                  { value: stats.trackCount, label: 'Tracks' },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="stat-value tabular-nums">{item.value}</div>
                    <div className="text-xs text-muted-foreground mt-1">{item.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <div className="container mx-auto max-w-6xl px-4 py-10 space-y-10 flex-1">
          {recent.length > 0 && (
            <section aria-labelledby="recent-heading">
              <div className="flex items-center justify-between mb-4">
                <h2 id="recent-heading" className="font-display text-lg font-bold flex items-center gap-2">
                  <MessagesSquare className="h-5 w-5 text-primary" strokeWidth={1.5} aria-hidden="true" />
                  Recently added ideas
                </h2>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/e/${event.slug}/sessions`} className="text-muted-foreground">
                    View all <ArrowRight className="h-4 w-4 ml-1" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {recent.map((session) => (
                  <Link key={session.id} href={`/e/${event.slug}/sessions/${session.id}`}>
                    <Card accent="left" accentColor={session.track_color || 'hsl(var(--signal))'} interactive className="h-full">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-1">
                          {session.format && <span className="text-xs text-muted-foreground capitalize">{session.format}</span>}
                          {session.track_name && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: session.track_color || undefined }} aria-hidden="true" />
                              {session.track_name}
                            </span>
                          )}
                        </div>
                        <h3 className="font-display font-semibold text-sm leading-snug line-clamp-2">{session.title}</h3>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {event.description && (
            <section aria-label="About">
              <div className="section-rule mb-4">About</div>
              <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{event.description}</p>
            </section>
          )}

          {canJoin && (proposing || voting) && (
            <section className="rounded-2xl border p-6 sm:p-8 flex flex-wrap items-center justify-between gap-4" aria-labelledby="join-heading">
              <div className="max-w-xl">
                <h2 id="join-heading" className="text-xl font-semibold mb-1">Join to take part</h2>
                <p className="text-sm text-muted-foreground">Proposing sessions and voting are for members. Joining makes you an attendee of this gathering; it is never published.</p>
              </div>
              <JoinGatheringButton />
            </section>
          )}

          <section className="rounded-2xl bg-secondary/50 p-6 sm:p-8" aria-labelledby="ways-heading">
            <h2 id="ways-heading" className="text-2xl font-semibold mb-6">{eventIsOver ? 'Keep the connections going.' : 'There’s more than one way to take part.'}</h2>
            <div className="grid sm:grid-cols-3 gap-6">
              {[
                !proposing
                  ? { icon: Calendar, title: 'Explore the gathering', description: 'Explore the program and the sessions we made together.', href: 'schedule', action: 'Explore the schedule' }
                  : { icon: FileText, title: 'Bring an idea', description: 'Start a session around something you want to share or explore.', href: 'propose', action: 'Propose a session' },
                !voting
                  ? { icon: Vote, title: 'Follow an idea', description: 'Discover the questions and conversations that brought people together.', href: 'sessions', action: 'Explore sessions' }
                  : { icon: Vote, title: 'Shape the program', description: `Use your ${plural(event.voteCreditsPerUser, 'credit')} to support the sessions that matter to you.`, href: 'sessions', action: 'Discover sessions' },
                { icon: Users, title: 'Find your people', description: 'Meet the people bringing this gathering to life.', href: 'participants', action: 'Meet the community' },
              ].map((item) => (
                <div key={item.title}>
                  <item.icon className="h-5 w-5 text-primary mb-3" aria-hidden="true" />
                  <h3 className="font-semibold mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">{item.description}</p>
                  <Link href={`/e/${event.slug}/${item.href}`} className="text-sm font-medium text-primary hover:underline">{item.action}</Link>
                </div>
              ))}
            </div>
          </section>

          {isMember && (
            <section aria-label="Quick actions">
              <div className="section-rule mb-4">Quick actions</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {quickActions.map(({ href, icon: Icon, label }) => (
                  <Link key={href} href={href}>
                    <Card interactive className="h-full">
                      <CardContent className="p-4 text-center">
                        <Icon className="h-5 w-5 mx-auto mb-2 text-primary" strokeWidth={1.5} aria-hidden="true" />
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
      <Footer variant="minimal" event={event} />
    </div>
  )
}
