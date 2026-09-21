'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Calendar, Heart, Clock, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { FilterChip } from '@/components/ui/filter-chip'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ExportScheduleButton } from '@/components/AddToCalendar'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { useTracks } from '@/hooks/useTracks'
import { setFavorite } from '@/components/SessionCard'
import { apiFetch } from '@/lib/api/client'
import { EN_DASH, plural } from '@/lib/format'
import { formatLabel } from '@/lib/sessions/constants'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'
import { cn } from '@/lib/utils'

/** A saved session with the time it happens (a slot, or the host's own time when self-hosted). */
type Saved = SessionView & { when: { start_time: string; end_time: string | null } | null }
type SortBy = 'time' | 'venue'

function withWhen(session: SessionView): Saved {
  const start = session.time_slot?.start_time ?? (session.is_self_hosted ? session.self_hosted_start_time : null)
  const end = session.time_slot?.end_time ?? (session.is_self_hosted ? session.self_hosted_end_time : null)
  return { ...session, when: start ? { start_time: start, end_time: end } : null }
}

// Get date key using local timezone (prevents duplicate days from UTC conversion)
function getDateKey(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoString))
}

function formatTime(isoString: string, timeZone: string): string {
  return new Date(isoString).toLocaleTimeString([], { timeZone, hour: 'numeric', minute: '2-digit' })
}

function formatDayLabel(dateKey: string): string {
  const date = new Date(dateKey + 'T12:00:00')
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/** One sticky group heading for a time or a venue. */
function GroupHeading({ icon, children, trailing }: { icon: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="sticky-under-header z-10 mb-3 border-b bg-background/95 py-2 backdrop-blur">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {icon}
        <span>{children}</span>
        {trailing}
      </h2>
    </div>
  )
}

interface SavedCardProps {
  session: Saved
  eventSlug: string
  timeZone: string
  removing: boolean
  onRemove: (session: Saved) => void
  show: { duration?: boolean; time?: boolean; venue?: boolean }
  dashed?: boolean
}

function SavedCard({ session, eventSlug, timeZone, removing, onRemove, show, dashed }: SavedCardProps) {
  return (
    <Card className={cn('transition-all hover:border-primary/50 hover:shadow-md', dashed && 'border-dashed')}>
      <CardContent className="p-4 pt-4">
        <div className="flex items-start justify-between gap-4">
          <Link href={`/e/${eventSlug}/sessions/${session.id}`} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={dashed ? 'outline' : 'secondary'}>{formatLabel(session.format)}</Badge>
              {show.duration && session.duration != null && <span className="text-xs text-muted-foreground">{session.duration} min</span>}
              {show.time && session.when && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" aria-hidden />
                  {formatTime(session.when.start_time, timeZone)}
                </span>
              )}
              {session.track && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {session.track.color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: session.track.color }} aria-hidden />}
                  {session.track.name}
                </span>
              )}
            </div>
            <h3 className="font-medium">{session.title}</h3>
            <p className="text-sm text-muted-foreground">{hostByline(session)}</p>
            {show.venue && (session.venue || session.is_self_hosted) && (
              <p className="mt-2 flex items-center gap-1 text-sm text-primary">
                <MapPin className="h-3.5 w-3.5" aria-hidden />
                {session.is_self_hosted ? 'Self-hosted' : session.venue?.name}
              </p>
            )}
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onRemove(session)}
            aria-label={`Remove ${session.title} from my schedule`}
            title="Remove from my schedule"
            aria-pressed
            loading={removing}
            className="-mr-2 -mt-1 shrink-0 text-favorite hover:text-favorite"
          >
            {!removing && <Heart className="h-4 w-4 fill-favorite" aria-hidden />}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default function MySchedulePage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { toast } = useToast()

  const { tracks } = useTracks(event.slug)
  const [favorites, setFavorites] = React.useState<Saved[]>([])
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null)
  const [trackFilter, setTrackFilter] = React.useState<string>('all')
  const [sortBy, setSortBy] = React.useState<SortBy>('time')

  React.useEffect(() => {
    if (!authLoading && !user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/my-schedule`)}`)
    }
  }, [user, authLoading, router, event.slug])

  React.useEffect(() => {
    if (!user) return
    let mounted = true
    apiFetch<{ sessions: SessionView[] }>(`/api/v1/events/${encodeURIComponent(event.slug)}/sessions?favorites=1&sort=time`)
      .then((data) => {
        if (mounted) setFavorites(data.sessions.map(withWhen))
      })
      .catch((err) => {
        if (mounted) setSaveError(err instanceof Error ? err.message : 'Your saved sessions could not be loaded.')
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [user, event.slug])

  const handleRemoveFavorite = async (session: Saved) => {
    if (!user || removing) return
    setRemoving(session.id)
    setSaveError(null)
    try {
      await setFavorite(event.slug, session.id, false)
      setFavorites((prev) => prev.filter((s) => s.id !== session.id))
      toast({
        title: 'Removed from my schedule',
        variant: 'success',
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await setFavorite(event.slug, session.id, true)
              setFavorites((prev) => (prev.some((s) => s.id === session.id) ? prev : [...prev, session]))
            } catch (err) {
              setSaveError(err instanceof Error ? err.message : 'The session could not be saved again.')
            }
          },
        },
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'This saved session could not be removed. Please try again.')
    } finally {
      setRemoving(null)
    }
  }

  // Group by time slot (must be before any conditional returns to maintain hook order)
  const scheduledSessions = favorites.filter((s) => s.when)
  const unscheduledSessions = favorites.filter((s) => !s.when)

  // Get unique days from scheduled sessions
  const days = React.useMemo(() => {
    const daySet = new Map<string, Date>()
    scheduledSessions.forEach((session) => {
      if (session.when?.start_time) {
        const dateKey = getDateKey(session.when.start_time, event.timezone)
        if (!daySet.has(dateKey)) daySet.set(dateKey, new Date(session.when.start_time))
      }
    })
    return Array.from(daySet.entries())
      .sort((a, b) => a[1].getTime() - b[1].getTime())
      .map(([key]) => ({ key, label: formatDayLabel(key) }))
  }, [scheduledSessions, event.timezone])

  // Auto-select first day if none selected (or the selected day disappeared)
  React.useEffect(() => {
    if (days.length > 0 && (!selectedDay || !days.some((d) => d.key === selectedDay))) setSelectedDay(days[0].key)
  }, [days, selectedDay])

  // Filter sessions by selected day and track
  const filteredScheduledSessions = React.useMemo(() => {
    return scheduledSessions.filter((session) => {
      if (!session.when?.start_time) return false
      if (selectedDay && getDateKey(session.when.start_time, event.timezone) !== selectedDay) return false
      if (trackFilter !== 'all' && session.track?.id !== trackFilter) return false
      return true
    })
  }, [scheduledSessions, selectedDay, trackFilter, event.timezone])

  // Filter unscheduled by track
  const filteredUnscheduledSessions = React.useMemo(() => {
    if (trackFilter === 'all') return unscheduledSessions
    return unscheduledSessions.filter((session) => session.track?.id === trackFilter)
  }, [unscheduledSessions, trackFilter])

  // Group filtered sessions by time
  const groupedByTime: Record<string, Saved[]> = React.useMemo(() => {
    const groups: Record<string, Saved[]> = {}
    filteredScheduledSessions.forEach((session) => {
      const startTime = formatTime(session.when!.start_time, event.timezone)
      if (!groups[startTime]) groups[startTime] = []
      groups[startTime].push(session)
    })
    return groups
  }, [filteredScheduledSessions, event.timezone])

  // Group filtered sessions by venue
  const groupedByVenue = React.useMemo(() => {
    if (sortBy !== 'venue') return null
    const groups: Record<string, Saved[]> = {}
    filteredScheduledSessions.forEach((session) => {
      const venueName = session.is_self_hosted ? 'Self-hosted' : (session.venue?.name || 'Unassigned')
      if (!groups[venueName]) groups[venueName] = []
      groups[venueName].push(session)
    })
    Object.values(groups).forEach((arr) => {
      arr.sort((a, b) => (a.when?.start_time || '').localeCompare(b.when?.start_time || ''))
    })
    return groups
  }, [filteredScheduledSessions, sortBy])

  // Sort time slots
  const sortedTimeSlots = React.useMemo(() => {
    return Object.keys(groupedByTime).sort((a, b) => {
      const sessionA = groupedByTime[a][0]
      const sessionB = groupedByTime[b][0]
      return new Date(sessionA.when!.start_time).getTime() - new Date(sessionB.when!.start_time).getTime()
    })
  }, [groupedByTime])

  // Loading state - AFTER all hooks
  if (authLoading || isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading your schedule">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  const cardProps = { eventSlug: event.slug, timeZone: event.timezone, onRemove: handleRemoveFavorite }
  const dayEmpty = (
    <div className="py-8 text-center">
      <p className="text-muted-foreground">
        {trackFilter !== 'all' ? 'No saved sessions match the selected track.' : 'No sessions saved for this day.'}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {trackFilter !== 'all' && <Button variant="outline" size="sm" onClick={() => setTrackFilter('all')}>Clear track filter</Button>}
        <Button variant="outline" size="sm" asChild><Link href={`/e/${event.slug}/schedule`}>Browse the schedule</Link></Button>
      </div>
    </div>
  )

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {saveError && (
          <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{saveError}</div>
        )}

        <PageHeader
          title="My schedule"
          subtitle="Sessions you’ve saved to attend."
          actions={
            favorites.length > 0 ? (
              <ExportScheduleButton eventSlug={event.slug} eventName={event.name} favoritesOnly variant="outline" size="sm" />
            ) : undefined
          }
        />

        {favorites.length === 0 ? (
          <div className="py-12 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Calendar className="h-8 w-8 text-muted-foreground" aria-hidden />
            </div>
            <h2 className="mb-2 text-xl font-semibold">No sessions saved yet</h2>
            <p className="mb-4 text-muted-foreground">
              Browse sessions and tap the heart to add them to your schedule.
            </p>
            <Button asChild>
              <Link href={`/e/${event.slug}/sessions`}>Browse sessions</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="space-y-3">
              {days.length > 1 && (
                <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                  <div className="flex gap-2 pb-2 sm:flex-wrap sm:pb-0" role="group" aria-label="Day">
                    {days.map((day) => (
                      <FilterChip key={day.key} pressed={selectedDay === day.key} onClick={() => setSelectedDay(day.key)}>
                        {day.label}
                      </FilterChip>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl<SortBy>
                  aria-label="Group by"
                  value={sortBy}
                  onValueChange={setSortBy}
                  options={[
                    { value: 'time', label: 'By time', icon: <Clock className="h-3.5 w-3.5" aria-hidden /> },
                    { value: 'venue', label: 'By venue', icon: <MapPin className="h-3.5 w-3.5" aria-hidden /> },
                  ]}
                />

                {tracks.length > 0 && (
                  <div className="-mx-4 w-full overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
                    <div className="flex items-center gap-2 pb-2 sm:flex-wrap sm:pb-0" role="group" aria-label="Track">
                      <span className="mr-1 whitespace-nowrap text-xs text-muted-foreground">Track:</span>
                      <FilterChip pressed={trackFilter === 'all'} onClick={() => setTrackFilter('all')}>All</FilterChip>
                      {tracks.map((t) => (
                        <FilterChip
                          key={t.id}
                          pressed={trackFilter === t.id}
                          onClick={() => setTrackFilter(t.id)}
                          icon={t.color ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} aria-hidden /> : undefined}
                        >
                          {t.name}
                        </FilterChip>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {sortBy === 'time' ? (
              sortedTimeSlots.length > 0 ? (
                <div className="space-y-6">
                  {sortedTimeSlots.map((timeLabel) => {
                    const sessions = groupedByTime[timeLabel]
                    const endTime = sessions[0].when!.end_time ? formatTime(sessions[0].when!.end_time!, event.timezone) : null
                    return (
                      <div key={timeLabel}>
                        <GroupHeading
                          icon={<Clock className="h-5 w-5 text-primary" aria-hidden />}
                          trailing={endTime ? <span className="font-normal text-muted-foreground">{EN_DASH} {endTime}</span> : undefined}
                        >
                          {timeLabel}
                        </GroupHeading>
                        <div className="grid gap-4 md:grid-cols-2">
                          {sessions.map((session) => (
                            <SavedCard key={session.id} session={session} {...cardProps} removing={removing === session.id} show={{ duration: true, venue: true }} />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : filteredScheduledSessions.length === 0 && selectedDay ? dayEmpty : null
            ) : (
              groupedByVenue && Object.keys(groupedByVenue).length > 0 ? (
                <div className="space-y-6">
                  {Object.entries(groupedByVenue)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([venueName, sessions]) => (
                      <div key={venueName}>
                        <GroupHeading
                          icon={<MapPin className="h-5 w-5 text-primary" aria-hidden />}
                          trailing={<span className="text-sm font-normal text-muted-foreground">· {plural(sessions.length, 'session')}</span>}
                        >
                          {venueName}
                        </GroupHeading>
                        <div className="grid gap-4 md:grid-cols-2">
                          {sessions.map((session) => (
                            <SavedCard key={session.id} session={session} {...cardProps} removing={removing === session.id} show={{ time: true }} />
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              ) : filteredScheduledSessions.length === 0 && selectedDay ? dayEmpty : null
            )}

            {filteredUnscheduledSessions.length > 0 && (
              <div>
                <h2 className="mb-4 text-base font-semibold text-muted-foreground">Not yet scheduled</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {filteredUnscheduledSessions.map((session) => (
                    <SavedCard key={session.id} session={session} {...cardProps} removing={removing === session.id} show={{ duration: true }} dashed />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
