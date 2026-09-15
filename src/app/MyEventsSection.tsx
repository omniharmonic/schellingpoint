import Link from 'next/link';
import { Calendar, MapPin, Settings, Plus, ArrowRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getViewer } from '@/lib/auth/viewer';
import { getOrganizedEvents, type OrganizedEvent } from '@/lib/events';

// Status badge configuration
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

/**
 * Gatherings the signed-in viewer organizes. A server component: the session cookie is read
 * on the server and nothing about other people's memberships reaches the browser.
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
    <section className="py-12 sm:py-16">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl sm:text-3xl font-bold">My Events</h2>
          <Button asChild>
            <Link href="/create">
              <Plus className="mr-2 h-4 w-4" />
              Create New Event
            </Link>
          </Button>
        </div>

        {events.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {events.map((event) => {
              const badge = statusBadgeConfig[event.status] || statusBadgeConfig.draft;

              return (
                <Card key={event.id} className="group border-foreground/20 border-t-8 border-t-primary">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {event.logo_url && (
                          <img
                            src={event.logo_url}
                            alt={event.name}
                            className="w-10 h-10 rounded-lg bg-muted"
                          />
                        )}
                        <div className="min-w-0">
                          <h3 className="text-2xl font-semibold tracking-tight leading-tight break-words">
                            {event.name}
                          </h3>
                          <span className="text-xs text-muted-foreground capitalize">
                            {event.role}
                          </span>
                          {!event.has_identity && (
                            <span className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                              Network identity not yet created
                            </span>
                          )}
                        </div>
                      </div>
                      <Badge variant={badge.variant} className="flex-shrink-0">
                        {badge.label}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap gap-3 text-sm text-muted-foreground mb-4">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="h-4 w-4" />
                        <span>{formatDateRange(event.start_date, event.end_date)}</span>
                      </div>
                      {event.location_name && (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="h-4 w-4" />
                          <span>{event.location_name}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Button asChild variant="outline" size="sm" className="flex-1">
                        <Link href={`/e/${event.slug}`}>
                          View Event
                        </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/e/${event.slug}/admin`} aria-label={`Manage ${event.name}`}>
                          <Settings className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground mb-4">
              You haven&apos;t created any events yet.
            </p>
            <Button asChild>
              <Link href="/create">
                Create Your First Event
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </Card>
        )}
      </div>
    </section>
  );
}
