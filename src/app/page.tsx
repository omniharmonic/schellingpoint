import Link from 'next/link';
import { NetworkMark } from '@/components/GatheringArtwork';
import { GatheringHero, GatheringStory } from '@/components/landing/GatheringStory';
import { Calendar, MapPin, Users, ArrowRight, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Footer } from '@/components/Footer';
import { SiteHeader } from '@/components/SiteHeader';
import { getDirectoryEvents, type DirectoryEvent } from '@/lib/events';
import { eventStatusBadge } from '@/lib/labels';
import { formatDateRange, plural } from '@/lib/format';
import { MyEventsSection } from './MyEventsSection';

// Event identity and calendar date lead each poster.
function EventCard({ event, featured = false }: { event: DirectoryEvent; featured?: boolean }) {
  const badge = eventStatusBadge(event.status);
  const date = new Date(event.start_date);
  const dates = formatDateRange(event.start_date, event.end_date, 'UTC');
  return <Link href={`/e/${event.slug}`} aria-label={`${event.name}, ${dates}`} className={`block group ${featured ? 'min-w-[300px] sm:min-w-[400px]' : ''}`}>
    <article className="event-poster">
      <div className={`event-poster-art ${event.banner_url ? 'event-poster-image' : ''}`}>
        {event.banner_url ? <img src={event.banner_url} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"/> : <NetworkMark/>}
        <div className="event-poster-date" aria-hidden="true"><span>{date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}</span><strong>{date.getUTCDate()}</strong></div>
        <Badge variant={badge.badge} className="absolute top-5 right-5 bg-card">{badge.label}</Badge>
        <span className="absolute bottom-4 right-4 rounded-full w-11 h-11 bg-card text-foreground flex items-center justify-center"><ArrowRight className="h-5 w-5 -rotate-45 group-hover:rotate-0 transition-transform" aria-hidden="true"/></span>
      </div>
      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-3 mb-3">{event.logo_url && <img src={event.logo_url} alt="" className="w-10 h-10 object-contain rounded-lg"/>}<h3 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-tight break-words">{event.name}</h3></div>
        {event.tagline && <p className="text-base text-muted-foreground mb-5 line-clamp-2">{event.tagline}</p>}
        <div className="border-t pt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-2"><Calendar className="h-4 w-4 shrink-0" aria-hidden="true"/>{dates}</span>
          {event.location_name && <span className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0" aria-hidden="true"/>{event.location_name}</span>}
          {typeof event.attendee_count === 'number' && <span className="flex items-center gap-2"><Users className="h-4 w-4 shrink-0" aria-hidden="true"/>{plural(event.attendee_count, 'person', 'people')}</span>}
        </div>
      </div>
    </article>
  </Link>
}

// Featured gatherings carousel
function FeaturedEventsCarousel({ events }: { events: DirectoryEvent[] }) {
  if (events.length === 0) return null;

  return (
    <section className="py-12 sm:py-16 bg-muted/30" aria-labelledby="featured-heading">
      <div className="container mx-auto px-5">
        <div className="flex items-center justify-between mb-6">
          <h2 id="featured-heading" className="text-2xl sm:text-3xl font-semibold tracking-tight">Featured gatherings</h2>
        </div>

        <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide -mx-5 px-5">
          {events.map((event) => (
            <EventCard key={event.id} event={event} featured />
          ))}
        </div>
      </div>
    </section>
  );
}

// Upcoming gatherings grid
function UpcomingEventsGrid({ events, showViewAll }: { events: DirectoryEvent[]; showViewAll: boolean }) {
  return (
    <section id="upcoming" className="py-12 sm:py-16 scroll-mt-20" aria-labelledby="upcoming-heading">
      <div className="container mx-auto px-5">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h2 id="upcoming-heading" className="text-4xl sm:text-5xl font-semibold tracking-tight">Find your next gathering</h2>
          {showViewAll && (
            <Button asChild variant="ghost">
              <Link href="/events">
                View all
                <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>

        {events.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground mb-4">The next gathering could start with you.</p>
            <Button asChild>
              <Link href="/create">
                Create a gathering
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </Card>
        )}
      </div>
    </section>
  );
}

// Create-a-gathering call to action
function CreateEventCTA() {
  return <section className="mx-5 md:mx-10 my-12 md:my-20 rounded-[2rem] bg-primary text-primary-foreground p-8 md:p-16 flex flex-col lg:flex-row justify-between items-start lg:items-end gap-8">
    <div><h2 className="text-4xl sm:text-6xl font-semibold tracking-tight max-w-xl leading-[1.03]">Your people.<br/>Your possibilities.</h2><p className="text-base text-primary-foreground/75 mt-6 max-w-md leading-relaxed">A few good questions. A place to meet. A community ready to make something happen.</p></div>
    <Button asChild size="lg" variant="secondary" className="shrink-0 rounded-full">
      <Link href="/create">Create a gathering <Plus className="ml-2 h-5 w-5" aria-hidden="true"/></Link>
    </Button>
  </section>
}

// Public, non-draft, non-archived gatherings with member counts (server-side, plan §3.1).
async function fetchEvents() {
  let events: DirectoryEvent[];
  try {
    events = await getDirectoryEvents();
  } catch (error) {
    console.error('Error fetching events:', error);
    return { featuredEvents: [], upcomingEvents: [], allEvents: [], loadFailed: true };
  }

  const now = new Date();
  const featuredEvents = events.filter(e => e.is_featured);
  const upcomingEvents = events.filter(e => new Date(`${e.end_date.slice(0, 10)}T23:59:59`) >= now && e.status !== 'completed');

  return { featuredEvents, upcomingEvents, allEvents: events, loadFailed: false };
}

/**
 * Platform landing page
 *
 * Gathering discovery hub showing:
 * - Hero section with CTA
 * - My gatherings (for signed-in organizers, right under the hero)
 * - Featured gatherings carousel
 * - Upcoming gatherings grid
 * - Create-a-gathering CTA
 */
// Upcoming gatherings shown on the homepage; the full list lives at /events.
const HOMEPAGE_UPCOMING_LIMIT = 6;

// Reads the session cookie (My gatherings) and live listings on every request.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const { featuredEvents, upcomingEvents, allEvents, loadFailed } = await fetchEvents();
  const pastEvents = allEvents.filter(e => !upcomingEvents.some(upcoming => upcoming.id === e.id));

  const displayedUpcoming = upcomingEvents.slice(0, HOMEPAGE_UPCOMING_LIMIT);
  const hasMoreUpcoming = upcomingEvents.length > HOMEPAGE_UPCOMING_LIMIT;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />
      <main className="flex-1">
        <GatheringHero />
        <MyEventsSection />
        <section aria-label="Built for participant-led events" className="utility-strip">
          <div><h2>A shared agenda</h2><p>People propose. The community chooses. Organizers make room.</p></div>
          <div><h2>Your identity comes with you</h2><p>Sign in with Bluesky or email. Keep one profile across gatherings.</p></div>
          <div><h2>Tickets that support the commons</h2><p>Free or paid admission. Organizers choose a platform contribution from 1%.</p></div>
        </section>
        <GatheringStory />

        {featuredEvents.length > 0 && (
          <FeaturedEventsCarousel events={featuredEvents} />
        )}

        {loadFailed ? <section className="container mx-auto px-5 py-12" id="upcoming"><div role="alert" className="rounded-2xl border bg-card p-6"><h2 className="text-xl font-semibold mb-2">We couldn’t load the gatherings.</h2><p className="text-muted-foreground mb-4">Please refresh to try again.</p><Button asChild variant="outline"><a href="/">Try again</a></Button></div></section> : <UpcomingEventsGrid
          events={displayedUpcoming}
          showViewAll={hasMoreUpcoming}
        />}

        {pastEvents.length > 0 && <section className="container mx-auto px-5 py-10" aria-labelledby="past-heading"><h2 id="past-heading" className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">Previously, together.</h2><p className="text-muted-foreground mb-6">Revisit the ideas and people behind past gatherings.</p><div className="grid md:grid-cols-2 gap-6">{pastEvents.map(event => <EventCard key={event.id} event={event}/>)}</div></section>}

        <CreateEventCTA />
      </main>

      <Footer variant="minimal" />
    </div>
  );
}
