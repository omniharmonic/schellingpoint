import type { Metadata } from 'next';
import Link from 'next/link';
import { Calendar, MapPin, Users, ArrowRight, Plus } from 'lucide-react';
import { NetworkMark } from '@/components/GatheringArtwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Footer } from '@/components/Footer';
import { SiteHeader } from '@/components/SiteHeader';
import { createClient } from '@/lib/supabase/server';
import type { EventRow } from '@/types/event';

export const metadata: Metadata = {
  title: 'All gatherings | Schelling Point',
  description: 'Browse every public gathering on Schelling Point — upcoming unconferences, hackathons, and community events, plus the ones that came before.',
};

type DirectoryEvent = EventRow & { attendee_count?: number };

// Status badge configuration (mirrors the homepage directory)
const statusBadgeConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  published: { label: 'Open', variant: 'default' },
  proposals_open: { label: 'Proposals Open', variant: 'success' },
  voting_open: { label: 'Voting Open', variant: 'success' },
  scheduling: { label: 'Scheduling', variant: 'secondary' },
  live: { label: 'Live Now', variant: 'destructive' },
  completed: { label: 'Completed', variant: 'secondary' },
  archived: { label: 'Archived', variant: 'outline' },
};

// Format date range
function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);

  const startMonth = start.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  const startDay = start.getUTCDate();
  const endMonth = end.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  const endDay = end.getUTCDate();
  const year = end.getUTCFullYear();

  if (startMonth === endMonth) {
    return `${startMonth} ${startDay}-${endDay}, ${year}`;
  }
  return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;
}

// Same poster card as the homepage directory (src/app/page.tsx). Kept in sync by hand:
// page files cannot export shared components, and this directory owns no shared module.
function EventCard({ event }: { event: DirectoryEvent }) {
  const badge = statusBadgeConfig[event.status] || statusBadgeConfig.draft;
  const date = new Date(event.start_date);
  return <Link href={`/e/${event.slug}`} aria-label={`${event.name}, ${formatDateRange(event.start_date, event.end_date)}`} className="block group">
    <article className="event-poster">
      <div className={`event-poster-art ${event.banner_url ? 'event-poster-image' : ''}`}>
        {event.banner_url ? <img src={event.banner_url} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"/> : <NetworkMark/>}
        <div className="event-poster-date" aria-hidden="true"><span>{date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}</span><strong>{date.getUTCDate()}</strong></div>
        <Badge variant={badge.variant} className="absolute top-5 right-5 border bg-white text-[#203b30]">{badge.label}</Badge>
        <span className="absolute bottom-4 right-4 rounded-full w-11 h-11 bg-white text-[#203b30] flex items-center justify-center"><ArrowRight className="h-5 w-5 -rotate-45 group-hover:rotate-0 transition-transform"/></span>
      </div>
      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-3 mb-3">{event.logo_url && <img src={event.logo_url} alt="" className="w-10 h-10 object-contain rounded-lg"/>}<h3 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-tight break-words">{event.name}</h3></div>
        {event.tagline && <p className="text-base text-muted-foreground mb-5 line-clamp-2">{event.tagline}</p>}
        <div className="border-t pt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-2"><Calendar className="h-4 w-4 shrink-0"/>{formatDateRange(event.start_date, event.end_date)}</span>
          {event.location_name && <span className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0"/>{event.location_name}</span>}
          {typeof event.attendee_count === 'number' && <span className="flex items-center gap-2"><Users className="h-4 w-4 shrink-0"/>{event.attendee_count} attendees</span>}
        </div>
      </div>
    </article>
  </Link>
}

// Mirrors the homepage query: public, non-draft, non-archived events with attendee counts.
async function fetchDirectory() {
  const supabase = await createClient();

  const { data: events, error } = await supabase
    .from('events')
    .select('*')
    .eq('visibility', 'public')
    .not('status', 'in', '("draft","archived")')
    .order('start_date', { ascending: true });

  if (error || !events) {
    console.error('Error fetching events directory:', error);
    return { upcomingEvents: [] as DirectoryEvent[], pastEvents: [] as DirectoryEvent[], loadFailed: true };
  }

  const eventIds = events.map(e => e.id);
  const { data: memberCounts } = eventIds.length
    ? await supabase.from('event_members').select('event_id').in('event_id', eventIds)
    : { data: [] as { event_id: string }[] };

  const attendeeCounts: Record<string, number> = {};
  (memberCounts ?? []).forEach(m => {
    attendeeCounts[m.event_id] = (attendeeCounts[m.event_id] || 0) + 1;
  });

  const eventsWithCounts: DirectoryEvent[] = events.map(e => ({
    ...e,
    attendee_count: attendeeCounts[e.id] || 0,
  }));

  const now = new Date();
  const isUpcoming = (e: DirectoryEvent) =>
    new Date(`${e.end_date.slice(0, 10)}T23:59:59`) >= now && e.status !== 'completed';

  const upcomingEvents = eventsWithCounts.filter(isUpcoming);
  // Most recent past gatherings first
  const pastEvents = eventsWithCounts
    .filter(e => !isUpcoming(e))
    .sort((a, b) => b.start_date.localeCompare(a.start_date));

  return { upcomingEvents, pastEvents, loadFailed: false };
}

/**
 * Events Directory
 *
 * Every public gathering on the platform: upcoming first, then past.
 */
export default async function EventsDirectoryPage() {
  const { upcomingEvents, pastEvents, loadFailed } = await fetchDirectory();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="py-12 sm:py-16">
          <div className="container mx-auto px-4">
            <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
              <div>
                <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">All gatherings</h1>
                <p className="text-muted-foreground mt-3 max-w-xl">Every public gathering on Schelling Point, from what&apos;s coming up to what came before.</p>
              </div>
              <Button asChild>
                <Link href="/create">
                  <Plus className="mr-2 h-4 w-4" />
                  Create your gathering
                </Link>
              </Button>
            </div>

            {loadFailed ? (
              <div role="alert" className="rounded-2xl border bg-card p-6">
                <h2 className="text-xl font-semibold mb-2">We couldn&apos;t load the gatherings.</h2>
                <p className="text-muted-foreground mb-4">Please refresh to try again.</p>
                <Button asChild variant="outline"><a href="/events">Try again</a></Button>
              </div>
            ) : (
              <>
                <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-6">Upcoming gatherings</h2>
                {upcomingEvents.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {upcomingEvents.map((event) => (
                      <EventCard key={event.id} event={event} />
                    ))}
                  </div>
                ) : (
                  <Card className="p-8 text-center">
                    <p className="text-muted-foreground mb-4">Nothing on the calendar yet. The next gathering could start with you.</p>
                    <Button asChild>
                      <Link href="/create">
                        Create an event
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                  </Card>
                )}
              </>
            )}
          </div>
        </section>

        {!loadFailed && pastEvents.length > 0 && (
          <section className="container mx-auto px-4 pb-16">
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-2">Past gatherings</h2>
            <p className="text-muted-foreground mb-6">Revisit the ideas and people behind past gatherings.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {pastEvents.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          </section>
        )}
      </main>

      <Footer variant="minimal" />
    </div>
  );
}
