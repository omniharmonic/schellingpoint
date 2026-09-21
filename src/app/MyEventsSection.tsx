import Link from 'next/link';
import { Calendar, MapPin, Plus, ArrowRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getViewer } from '@/lib/auth/viewer';
import { getOrganizedEvents, type OrganizedEvent } from '@/lib/events';
import { eventStatusBadge } from '@/lib/labels';
import { formatDateRange } from '@/lib/format';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
};

/**
 * Gatherings the signed-in viewer organizes. A server component: the session cookie is read
 * on the server and nothing about other people's memberships reaches the browser. Rendered
 * directly under the hero so an organizer finds their gatherings without scrolling the
 * marketing page; the header's "My gatherings" menu item links to `#my-gatherings`.
 */
export async function MyEventsSection() {
  const viewer = await getViewer();
  if (!viewer) return null;

  let events: OrganizedEvent[] = [];
  try {
    events = await getOrganizedEvents(viewer.accountId);
  } catch (err) {
    console.error('Error fetching my events:', err);
  }

  return (
    <section id="my-gatherings" className="py-12 sm:py-16 scroll-mt-20" aria-labelledby="my-gatherings-heading">
      <div className="container mx-auto px-5">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h2 id="my-gatherings-heading" className="text-2xl sm:text-3xl font-semibold tracking-tight">My gatherings</h2>
          <Button asChild>
            <Link href="/create">
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Create a gathering
            </Link>
          </Button>
        </div>

        {events.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {events.map((event) => {
              const badge = eventStatusBadge(event.status);

              return (
                <Card key={event.id} className="group border-foreground/20 border-t-8 border-t-primary">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {event.logo_url && (
                          <img src={event.logo_url} alt="" className="w-10 h-10 rounded-lg bg-muted object-contain" />
                        )}
                        <div className="min-w-0">
                          <h3 className="text-2xl font-semibold tracking-tight leading-tight break-words">
                            {event.name}
                          </h3>
                          <span className="text-xs text-muted-foreground">{ROLE_LABELS[event.role] ?? event.role}</span>
                        </div>
                      </div>
                      <Badge variant={badge.badge} className="flex-shrink-0">
                        {badge.label}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap gap-3 text-sm text-muted-foreground mb-4">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="h-4 w-4" aria-hidden="true" />
                        <span>{formatDateRange(event.start_date, event.end_date, 'UTC')}</span>
                      </div>
                      {event.location_name && (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="h-4 w-4" aria-hidden="true" />
                          <span>{event.location_name}</span>
                        </div>
                      )}
                    </div>

                    {!event.has_identity && (
                      <Link
                        href={`/e/${event.slug}/admin/atproto`}
                        className="mb-4 flex items-center gap-1.5 text-xs text-signal-amber hover:underline"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        Not published to the network yet — set it up
                      </Link>
                    )}

                    <div className="flex gap-2">
                      <Button asChild variant="outline" size="sm" className="flex-1">
                        <Link href={`/e/${event.slug}`}>Gathering page</Link>
                      </Button>
                      <Button asChild size="sm" className="flex-1">
                        <Link href={`/e/${event.slug}/admin`}>Organizer workspace</Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground mb-4">You haven’t created a gathering yet.</p>
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
