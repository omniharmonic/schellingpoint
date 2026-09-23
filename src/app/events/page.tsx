import type { Metadata } from 'next';
import Link from 'next/link';
import { Calendar, MapPin, Users, ArrowRight, Plus, Search, Video } from 'lucide-react';
import { NetworkMark } from '@/components/GatheringArtwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Footer } from '@/components/Footer';
import { SiteHeader } from '@/components/SiteHeader';
import { getDirectoryEvents, type DirectoryEvent } from '@/lib/events';
import { eventStatusBadge } from '@/lib/labels';
import { formatDateRange, plural } from '@/lib/format';

export const metadata: Metadata = {
  title: 'All gatherings | unconference',
  description: 'Browse every public gathering on unconference — unconferences, hackathons and community events you can search by name, place, topic and date.',
};

/**
 * A gathering is read as *virtual* when it names no physical place at all: no location name,
 * no address. That is a heuristic rather than a column, and it is the honest one available —
 * the schema has never had an "online" flag, and inventing a filter that silently excluded
 * half the directory would be worse than a filter that reads the same field a visitor does.
 */
function isVirtual(event: DirectoryEvent): boolean {
  return !event.location_name?.trim() && !event.location_address?.trim();
}

function tagsOf(event: DirectoryEvent): string[] {
  return (event.suggested_topics ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

function matchesQuery(event: DirectoryEvent, query: string): boolean {
  if (!query) return true;
  const haystack = [event.name, event.tagline, event.description, event.location_name, ...tagsOf(event)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

// Same poster card as the homepage directory (src/app/page.tsx). Kept in sync by hand:
// page files cannot export shared components, and this directory owns no shared module.
function EventCard({ event }: { event: DirectoryEvent }) {
  const badge = eventStatusBadge(event.status);
  const date = new Date(event.start_date);
  const dates = formatDateRange(event.start_date, event.end_date, 'UTC');
  const virtual = isVirtual(event);
  const tags = tagsOf(event).slice(0, 3);
  return <Link href={`/e/${event.slug}`} aria-label={`${event.name}, ${dates}`} className="block group">
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
        {tags.length > 0 && <div className="mb-4 flex flex-wrap gap-2">{tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}</div>}
        <div className="border-t pt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-2"><Calendar className="h-4 w-4 shrink-0" aria-hidden="true"/>{dates}</span>
          {virtual
            ? <span className="flex items-center gap-2"><Video className="h-4 w-4 shrink-0" aria-hidden="true"/>Online</span>
            : event.location_name && <span className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0" aria-hidden="true"/>{event.location_name}</span>}
          {typeof event.attendee_count === 'number' && <span className="flex items-center gap-2"><Users className="h-4 w-4 shrink-0" aria-hidden="true"/>{plural(event.attendee_count, 'person', 'people')}</span>}
        </div>
      </div>
    </article>
  </Link>
}

// Mirrors the homepage query: public, non-draft, non-archived events with attendee counts.
async function fetchDirectory() {
  try {
    return { events: await getDirectoryEvents(), loadFailed: false };
  } catch (error) {
    console.error('Error fetching events directory:', error);
    return { events: [] as DirectoryEvent[], loadFailed: true };
  }
}

type When = 'upcoming' | 'past' | 'all';
type Place = 'any' | 'in-person' | 'virtual';

interface DirectorySearch {
  q?: string;
  when?: string;
  place?: string;
  tag?: string;
}

/**
 * Gatherings directory (MT §11.1).
 *
 * Search, a date filter, a place filter and topic chips, all driven by the query string and
 * resolved on the server: the whole page works with JavaScript off, every filtered view has a
 * URL somebody can send to a friend, and the filters never reach for data the visitor could
 * not already see (public, non-draft, non-archived gatherings only).
 */
export const dynamic = 'force-dynamic';

export default async function EventsDirectoryPage({ searchParams }: { searchParams: Promise<DirectorySearch> }) {
  const params = await searchParams;
  const query = (params.q ?? '').trim().slice(0, 120).toLowerCase();
  const when: When = params.when === 'past' || params.when === 'all' ? params.when : 'upcoming';
  const place: Place = params.place === 'in-person' || params.place === 'virtual' ? params.place : 'any';
  const tag = (params.tag ?? '').trim().slice(0, 80);

  const { events, loadFailed } = await fetchDirectory();

  const now = new Date();
  const isUpcoming = (e: DirectoryEvent) =>
    new Date(`${e.end_date.slice(0, 10)}T23:59:59`) >= now && e.status !== 'completed';

  const filtered = events
    .filter((e) => (when === 'all' ? true : when === 'past' ? !isUpcoming(e) : isUpcoming(e)))
    .filter((e) => (place === 'any' ? true : place === 'virtual' ? isVirtual(e) : !isVirtual(e)))
    .filter((e) => (tag ? tagsOf(e).some((t) => t.toLowerCase() === tag.toLowerCase()) : true))
    .filter((e) => matchesQuery(e, query))
    .sort((a, b) => (when === 'past' ? b.start_date.localeCompare(a.start_date) : a.start_date.localeCompare(b.start_date)));

  // Topic chips come from what is actually in the directory, not from a fixed taxonomy.
  const tagCounts = new Map<string, number>();
  for (const event of events) for (const t of tagsOf(event)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([t]) => t);

  const href = (next: Partial<DirectorySearch>) => {
    const out = new URLSearchParams();
    const merged: DirectorySearch = { q: query || undefined, when, place, tag: tag || undefined, ...next };
    if (merged.q) out.set('q', merged.q);
    if (merged.when && merged.when !== 'upcoming') out.set('when', merged.when);
    if (merged.place && merged.place !== 'any') out.set('place', merged.place);
    if (merged.tag) out.set('tag', merged.tag);
    const qs = out.toString();
    return qs ? `/events?${qs}` : '/events';
  };

  const filterLink = (label: string, target: string, activeNow: boolean) =>
    <Link key={label} href={target} aria-current={activeNow ? 'true' : undefined}
      className={`rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeNow ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>
      {label}
    </Link>;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />
      <main id="main" className="flex-1">
        <section className="py-12 sm:py-16">
          <div className="container mx-auto px-5">
            <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
              <div>
                <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">All gatherings</h1>
                <p className="text-muted-foreground mt-3 max-w-xl">Every public gathering on unconference, from what’s coming up to what came before.</p>
              </div>
              <Button asChild>
                <Link href="/create">
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                  Create a gathering
                </Link>
              </Button>
            </div>

            <form action="/events" method="get" role="search" className="mb-6 flex flex-wrap items-center gap-3">
              <label htmlFor="events-q" className="sr-only">Search gatherings</label>
              <div className="relative min-w-[16rem] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="events-q" name="q" defaultValue={params.q ?? ''} placeholder="Search by name, place or topic" className="pl-9" maxLength={120} />
              </div>
              {when !== 'upcoming' ? <input type="hidden" name="when" value={when} /> : null}
              {place !== 'any' ? <input type="hidden" name="place" value={place} /> : null}
              {tag ? <input type="hidden" name="tag" value={tag} /> : null}
              <Button type="submit">Search</Button>
              {(query || tag || when !== 'upcoming' || place !== 'any') ? (
                <Button asChild variant="ghost"><Link href="/events">Clear</Link></Button>
              ) : null}
            </form>

            <div className="mb-8 space-y-3">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="When">
                {filterLink('Upcoming', href({ when: 'upcoming' }), when === 'upcoming')}
                {filterLink('Past', href({ when: 'past' }), when === 'past')}
                {filterLink('All dates', href({ when: 'all' }), when === 'all')}
              </div>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Where">
                {filterLink('Anywhere', href({ place: 'any' }), place === 'any')}
                {filterLink('In person', href({ place: 'in-person' }), place === 'in-person')}
                {filterLink('Online', href({ place: 'virtual' }), place === 'virtual')}
              </div>
              {topTags.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Topics">
                  {filterLink('Any topic', href({ tag: undefined }), !tag)}
                  {topTags.map((t) => filterLink(t, href({ tag: t }), tag.toLowerCase() === t.toLowerCase()))}
                </div>
              ) : null}
            </div>

            {loadFailed ? (
              <div role="alert" className="rounded-2xl border bg-card p-6">
                <h2 className="text-xl font-semibold mb-2">We couldn’t load the gatherings.</h2>
                <p className="text-muted-foreground mb-4">Please refresh to try again.</p>
                <Button asChild variant="outline"><a href="/events">Try again</a></Button>
              </div>
            ) : (
              <>
                <p className="mb-6 text-sm text-muted-foreground" role="status">
                  {plural(filtered.length, 'gathering', 'gatherings')}
                  {when === 'past' ? ' that already happened' : when === 'upcoming' ? ' coming up' : ''}
                  {place === 'virtual' ? ', online' : place === 'in-person' ? ', in person' : ''}
                  {tag ? ` about ${tag}` : ''}
                  {query ? ` matching “${query}”` : ''}.
                </p>
                {filtered.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filtered.map((event) => <EventCard key={event.id} event={event} />)}
                  </div>
                ) : (
                  <Card className="p-8 text-center">
                    <p className="text-muted-foreground mb-4">
                      {query || tag || place !== 'any'
                        ? 'Nothing here matches. Try fewer words, or clear the filters.'
                        : 'Nothing on the calendar yet. The next gathering could start with you.'}
                    </p>
                    <Button asChild>
                      <Link href={query || tag || place !== 'any' ? '/events' : '/create'}>
                        {query || tag || place !== 'any' ? 'Clear the filters' : 'Create a gathering'}
                        <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                      </Link>
                    </Button>
                  </Card>
                )}
              </>
            )}
          </div>
        </section>
      </main>

      <Footer variant="minimal" />
    </div>
  );
}
