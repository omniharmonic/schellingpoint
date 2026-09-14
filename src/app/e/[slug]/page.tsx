'use client';

import { isParticipationOpen } from '@/lib/events/lifecycle';
import * as React from 'react';
import { GatheringArtwork } from '@/components/GatheringArtwork';
import Link from 'next/link';
import {
  Calendar,
  MapPin,
  Users,
  Vote,
  FileText,
  Clock,
  ArrowRight,
  Presentation,
  Settings,
  Loader2,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SiteHeader } from '@/components/SiteHeader';
import { Footer } from '@/components/Footer';
import { useEvent, useEventRole } from '@/contexts/EventContext';
import { useAuth } from '@/hooks/useAuth';
import { formatCalendarDate } from '@/lib/events/dates';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

interface EventStats {
  sessionCount: number;
  participantCount: number;
  trackCount: number;
}

interface TopSession {
  id: string;
  title: string;
  host_name: string | null;
  format: string | null;
  total_votes: number;
  track?: { name: string; color: string | null } | null;
}

export default function EventPage() {
  const event = useEvent();
  const { isAdmin, isMember } = useEventRole();
  const { user } = useAuth();

  const [stats, setStats] = React.useState<EventStats | null>(null);
  const [topSessions, setTopSessions] = React.useState<TopSession[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  // Calculate event duration in days
  const dayCount = React.useMemo(() => {
    const start = new Date(event.startDate);
    const end = new Date(event.endDate);
    return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  }, [event.startDate, event.endDate]);

  // Fetch stats and top sessions
  React.useEffect(() => {
    const fetchData = async () => {
      try {
        const [sessionsRes, membersRes, tracksRes, topRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&select=id`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          }),
          fetch(`${SUPABASE_URL}/rest/v1/event_members?event_id=eq.${event.id}&select=id`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          }),
          fetch(`${SUPABASE_URL}/rest/v1/tracks?event_id=eq.${event.id}&select=id`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          }),
          fetch(`${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&status=in.(approved,scheduled)&select=id,title,host_name,format,total_votes,track:tracks(name,color)&order=total_votes.desc&limit=4`, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          }),
        ]);

        const [sessions, members, tracks, top] = await Promise.all([
          sessionsRes.ok ? sessionsRes.json() : [],
          membersRes.ok ? membersRes.json() : [],
          tracksRes.ok ? tracksRes.json() : [],
          topRes.ok ? topRes.json() : [],
        ]);

        setStats({
          sessionCount: sessions.length,
          participantCount: members.length,
          trackCount: tracks.length,
        });
        setTopSessions(top);
      } catch (err) {
        console.error('Error fetching event data:', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [event.id]);

  const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'amber' }> = {
    draft: { label: 'Draft', variant: 'secondary' },
    published: { label: 'Open', variant: 'default' },
    proposals_open: { label: 'Proposals Open', variant: 'default' },
    voting_open: { label: 'Voting Open', variant: 'default' },
    scheduling: { label: 'Scheduling', variant: 'amber' },
    live: { label: 'Live Now', variant: 'destructive' },
    completed: { label: 'Completed', variant: 'secondary' },
    archived: { label: 'Archived', variant: 'outline' },
  };

  const eventIsOver = event.status === 'completed' || event.status === 'archived';
  const badge = statusConfig[event.status] || statusConfig.draft;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      <main id="event-main">
      <section className="container mx-auto px-5 py-10 sm:py-16">
        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16 items-center">
          <div>
            <div className="flex items-center gap-3 mb-6">{event.logoUrl && <img src={event.logoUrl} alt="" className="h-12 w-12 rounded-xl object-contain border bg-card"/>}<Badge variant={badge.variant}>{badge.label}</Badge></div>
            <h1 className="font-display text-5xl sm:text-6xl font-semibold tracking-tight mb-5 break-words">{event.name}</h1>
            <p className="text-lg text-muted-foreground mb-7 max-w-xl leading-relaxed">{event.tagline || 'A gathering shaped by the people who show up. Bring your curiosity and help make it happen.'}</p>
            <div className="flex flex-col gap-3 text-sm text-muted-foreground mb-8">
              <span className="flex items-center gap-2"><Calendar className="h-4 w-4"/>{formatCalendarDate(event.startDate, { month: 'long', day: 'numeric' })} – {formatCalendarDate(event.endDate, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              {event.locationName && <span className="flex items-center gap-2"><MapPin className="h-4 w-4"/>{event.locationName}</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg"><Link href={`/e/${event.slug}/${event.status === 'live' || event.status === 'completed' ? 'schedule' : 'sessions'}`}>{event.status === 'live' || event.status === 'completed' ? 'Explore the schedule' : 'Explore sessions'}<ArrowRight className="ml-3 h-4 w-4"/></Link></Button>
              <Button asChild variant="outline" size="lg"><Link href={event.ticketingEnabled && !eventIsOver ? `/e/${event.slug}/tickets` : user ? `/e/${event.slug}/dashboard` : `/login?redirect=${encodeURIComponent(`/e/${event.slug}/dashboard`)}`}>{event.ticketingEnabled && !eventIsOver ? 'Get tickets' : user ? 'Your gathering' : eventIsOver ? 'Sign in to reconnect' : 'Join the gathering'}</Link></Button>
              {isAdmin && <Button asChild variant="ghost" size="lg"><Link href={`/e/${event.slug}/admin`}>Manage event</Link></Button>}
            </div>
          </div>
          {event.bannerUrl ? <img src={event.bannerUrl} alt={`${event.name} event artwork`} className="w-full aspect-[5/4] object-cover rounded-[2rem]"/> : <GatheringArtwork compact/>}
        </div>
      </section>

      {/* Stats strip */}
      <section className="border-y border-border bg-card/50">
        <div className="container mx-auto max-w-6xl px-4 py-6">
          {isLoading ? (
            <div className="flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : stats && (
            <div className="grid grid-cols-3 gap-6 text-center">
              <div>
                <div className="text-2xl sm:text-3xl font-bold tabular-nums">
                  {stats.sessionCount}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Sessions
                </div>
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-bold tabular-nums">
                  {stats.participantCount}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Participants
                </div>
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-bold tabular-nums">
                  {stats.trackCount}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Tracks
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Main content */}
      <div className="container mx-auto max-w-6xl px-4 py-10 space-y-10 flex-1">
        {/* Ideas people are gathering around */}
        {topSessions.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-bold flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" strokeWidth={1.5} />
                Ideas people are gathering around
              </h2>
              <Link
                href={`/e/${event.slug}/sessions`}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                View all →
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {topSessions.map((session, i) => (
                <Link key={session.id} href={`/e/${event.slug}/sessions/${session.id}`}>
                  <Card
                    accent="left"
                    accentColor={session.track?.color || 'hsl(var(--signal))'}
                    interactive
                    className="h-full"
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            {session.format && (
                              <span className="text-xs text-muted-foreground">
                                {session.format}
                              </span>
                            )}
                            {session.track && (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: session.track.color || undefined }} />
                                {session.track.name}
                              </span>
                            )}
                          </div>
                          <h3 className="font-display font-semibold text-sm leading-snug line-clamp-2">
                            {session.title}
                          </h3>
                          {session.host_name && (
                            <p className="text-xs text-muted-foreground mt-1">{session.host_name}</p>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-lg font-bold tabular-nums text-primary">
                            {session.total_votes}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            votes
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* About */}
        {event.description && (
          <section>
            <div className="section-rule mb-4">About</div>
            <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {event.description}
            </p>
          </section>
        )}

        <section className="rounded-2xl bg-secondary/50 p-6 sm:p-8">
          <h2 className="text-2xl font-semibold mb-6">{eventIsOver ? 'Keep the connections going.' : 'There’s more than one way to take part.'}</h2>
          <div className="grid sm:grid-cols-3 gap-6">
            {[
              !isParticipationOpen(event, 'propose') ? { icon: Calendar, title: 'Explore the gathering', description: 'Explore the program and the sessions we made together.', href: 'schedule', action: 'Explore the schedule' } : { icon: FileText, title: 'Bring an idea', description: 'Start a session around something you want to share or explore.', href: 'propose', action: 'Propose a session' },
              !isParticipationOpen(event, 'vote') ? { icon: Vote, title: 'Follow an idea', description: 'Discover the questions and conversations that brought people together.', href: 'sessions', action: 'Explore sessions' } : { icon: Vote, title: 'Shape the program', description: `Use your ${event.voteCreditsPerUser} credits to support the sessions that matter to you.`, href: 'sessions', action: 'Discover sessions' },
              { icon: Users, title: 'Find your people', description: 'Meet the people bringing this gathering to life.', href: 'participants', action: 'Meet the community' },
            ].map(item => <div key={item.title}><item.icon className="h-5 w-5 text-primary mb-3"/><h3 className="font-semibold mb-2">{item.title}</h3><p className="text-sm text-muted-foreground leading-relaxed mb-3">{item.description}</p><Link href={`/e/${event.slug}/${item.href}`} className="text-sm font-medium text-primary hover:underline">{item.action}</Link></div>)}
          </div>
        </section>

        {/* Quick actions (logged in members) */}
        {isMember && (
          <section>
            <div className="section-rule mb-4">Quick Actions</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { href: `/e/${event.slug}/${isParticipationOpen(event, 'propose') ? 'propose' : 'sessions'}`, icon: FileText, label: isParticipationOpen(event, 'propose') ? 'Propose' : 'Sessions' },
                { href: `/e/${event.slug}/my-votes`, icon: Vote, label: 'My Votes' },
                { href: `/e/${event.slug}/my-schedule`, icon: Calendar, label: 'Saved' },
                { href: `/e/${event.slug}/participants`, icon: Users, label: 'People' },
              ].map(({ href, icon: Icon, label }) => (
                <Link key={href} href={href}>
                  <Card interactive className="h-full">
                    <CardContent className="p-4 text-center">
                      <Icon className="h-5 w-5 mx-auto mb-2 text-primary" strokeWidth={1.5} />
                      <span className="text-xs text-muted-foreground">
                        {label}
                      </span>
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
  );
}
