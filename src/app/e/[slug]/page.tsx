import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowRight, Calendar, FileText, Globe, MapPin, Sparkles, Users, Vote } from 'lucide-react'
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

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'amber' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  published: { label: 'Open', variant: 'default' },
  proposals_open: { label: 'Proposals Open', variant: 'default' },
  voting_open: { label: 'Voting Open', variant: 'default' },
  scheduling: { label: 'Scheduling', variant: 'amber' },
  live: { label: 'Live Now', variant: 'destructive' },
  completed: { label: 'Completed', variant: 'secondary' },
  archived: { label: 'Archived', variant: 'outline' },
}

async function loadStats(eventId: string): Promise<{ stats: EventStats; recent: RecentSession[] }> {
  const [[counts], recent] = await Promise.all([
    sql<{ sessions: number; participants: number; tracks: number }[]>`
      select
        (select count(*) from sessions where event_id = ${eventId} and status in ('approved', 'scheduled'))::int as sessions,
        (select count(*) from event_members where event_id = ${eventId})::int as participants,
        (select count(*) from tracks where event_id = ${eventId} and coalesce(is_active, true))::int as tracks
    `,
    sql<RecentSession[]>`
      select s.id, s.title, s.format, t.name as track_name, t.color as track_color
      from sessions s left join tracks t on t.id = s.track_id and t.event_id = s.event_id
      where s.event_id = ${eventId} and s.status in ('approved', 'scheduled')
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
  const badge = statusConfig[event.status] || statusConfig.draft
  const scheduleFirst = event.status === 'live' || event.status === 'completed'
  const proposing = isParticipationOpen(event, 'propose')
  const voting = isParticipationOpen(event, 'vote')

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      <main id="event-main">
        <section className="container mx-auto px-5 py-10 sm:py-16">
          <div className="grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16 items-center">
            <div>
              <div className="flex items-center gap-3 mb-6">
                {event.logoUrl && <img src={event.logoUrl} alt="" className="h-12 w-12 rounded-xl object-contain border bg-card" />}
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </div>
              <h1 className="font-display text-5xl sm:text-6xl font-semibold tracking-tight mb-5 break-words">{event.name}</h1>
              <p className="text-lg text-muted-foreground mb-7 max-w-xl leading-relaxed">
                {event.tagline || 'A gathering shaped by the people who show up. Bring your curiosity and help make it happen.'}
              </p>
              <div className="flex flex-col gap-3 text-sm text-muted-foreground mb-8">
                <span className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  {formatCalendarDate(event.startDate, { month: 'long', day: 'numeric' })} – {formatCalendarDate(event.endDate, { month: 'long', day: 'numeric', year: 'numeric' })}
                </span>
                {event.locationName && <span className="flex items-center gap-2"><MapPin className="h-4 w-4" />{event.locationName}</span>}
                {network.publishedAt && network.handle && (
                  <span className="flex flex-wrap items-center gap-2">
                    <Globe className="h-4 w-4" />
                    <span className="font-mono text-xs">@{network.handle}</span>
                    {links.profile && <a href={links.profile} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">View on the network</a>}
                    {links.record && <a href={links.record} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Public record</a>}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href={`/e/${event.slug}/${scheduleFirst ? 'schedule' : 'sessions'}`}>
                    {scheduleFirst ? 'Explore the schedule' : 'Explore sessions'}<ArrowRight className="ml-3 h-4 w-4" />
                  </Link>
                </Button>
                {canJoin ? (
                  <JoinGatheringButton size="lg" />
                ) : (
                  <Button asChild variant="outline" size="lg">
                    <Link href={event.ticketingEnabled && !eventIsOver ? `/e/${event.slug}/tickets` : viewer ? `/e/${event.slug}/dashboard` : `/login?redirect=${encodeURIComponent(`/e/${event.slug}`)}`}>
                      {event.ticketingEnabled && !eventIsOver ? 'Get tickets' : viewer ? 'Your gathering' : eventIsOver ? 'Sign in to reconnect' : 'Sign in to join'}
                    </Link>
                  </Button>
                )}
                {isAdmin && <Button asChild variant="ghost" size="lg"><Link href={`/e/${event.slug}/admin`}>Manage event</Link></Button>}
              </div>
            </div>
            {event.bannerUrl
              ? <img src={event.bannerUrl} alt={`${event.name} event artwork`} className="w-full aspect-[5/4] object-cover rounded-[2rem]" />
              : <GatheringArtwork compact />}
          </div>
        </section>

        {/* Stats strip */}
        <section className="border-y border-border bg-card/50">
          <div className="container mx-auto max-w-6xl px-4 py-6">
            <div className="grid grid-cols-3 gap-6 text-center">
              {[
                { value: stats.sessionCount, label: 'Sessions' },
                { value: stats.participantCount, label: 'Participants' },
                { value: stats.trackCount, label: 'Tracks' },
              ].map((item) => (
                <div key={item.label}>
                  <div className="text-2xl sm:text-3xl font-bold tabular-nums">{item.value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="container mx-auto max-w-6xl px-4 py-10 space-y-10 flex-1">
          {recent.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display text-lg font-bold flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" strokeWidth={1.5} />
                  Recently added ideas
                </h2>
                <Link href={`/e/${event.slug}/sessions`} className="text-xs text-muted-foreground hover:text-primary transition-colors">View all →</Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {recent.map((session) => (
                  <Link key={session.id} href={`/e/${event.slug}/sessions/${session.id}`}>
                    <Card accent="left" accentColor={session.track_color || 'hsl(var(--signal))'} interactive className="h-full">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-1">
                          {session.format && <span className="text-xs text-muted-foreground">{session.format}</span>}
                          {session.track_name && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: session.track_color || undefined }} />
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
            <section>
              <div className="section-rule mb-4">About</div>
              <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{event.description}</p>
            </section>
          )}

          {canJoin && (proposing || voting) && (
            <section className="rounded-2xl border p-6 sm:p-8 flex flex-wrap items-center justify-between gap-4">
              <div className="max-w-xl">
                <h2 className="text-xl font-semibold mb-1">Join to take part</h2>
                <p className="text-sm text-muted-foreground">Proposing sessions and voting are for members. Joining makes you an attendee of this gathering; it is never published.</p>
              </div>
              <JoinGatheringButton />
            </section>
          )}

          <section className="rounded-2xl bg-secondary/50 p-6 sm:p-8">
            <h2 className="text-2xl font-semibold mb-6">{eventIsOver ? 'Keep the connections going.' : 'There’s more than one way to take part.'}</h2>
            <div className="grid sm:grid-cols-3 gap-6">
              {[
                !proposing
                  ? { icon: Calendar, title: 'Explore the gathering', description: 'Explore the program and the sessions we made together.', href: 'schedule', action: 'Explore the schedule' }
                  : { icon: FileText, title: 'Bring an idea', description: 'Start a session around something you want to share or explore.', href: 'propose', action: 'Propose a session' },
                !voting
                  ? { icon: Vote, title: 'Follow an idea', description: 'Discover the questions and conversations that brought people together.', href: 'sessions', action: 'Explore sessions' }
                  : { icon: Vote, title: 'Shape the program', description: `Use your ${event.voteCreditsPerUser} credits to support the sessions that matter to you.`, href: 'sessions', action: 'Discover sessions' },
                { icon: Users, title: 'Find your people', description: 'Meet the people bringing this gathering to life.', href: 'participants', action: 'Meet the community' },
              ].map((item) => (
                <div key={item.title}>
                  <item.icon className="h-5 w-5 text-primary mb-3" />
                  <h3 className="font-semibold mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">{item.description}</p>
                  <Link href={`/e/${event.slug}/${item.href}`} className="text-sm font-medium text-primary hover:underline">{item.action}</Link>
                </div>
              ))}
            </div>
          </section>

          {isMember && (
            <section>
              <div className="section-rule mb-4">Quick Actions</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { href: `/e/${event.slug}/${proposing ? 'propose' : 'sessions'}`, icon: FileText, label: proposing ? 'Propose' : 'Sessions' },
                  { href: `/e/${event.slug}/my-votes`, icon: Vote, label: 'My Votes' },
                  { href: `/e/${event.slug}/my-schedule`, icon: Calendar, label: 'Saved' },
                  { href: `/e/${event.slug}/participants`, icon: Users, label: 'People' },
                ].map(({ href, icon: Icon, label }) => (
                  <Link key={href} href={href}>
                    <Card interactive className="h-full">
                      <CardContent className="p-4 text-center">
                        <Icon className="h-5 w-5 mx-auto mb-2 text-primary" strokeWidth={1.5} />
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
