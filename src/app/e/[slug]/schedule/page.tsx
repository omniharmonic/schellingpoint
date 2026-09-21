'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Calendar, MapPin, Clock, User, Search, Heart } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FilterChip } from '@/components/ui/filter-chip'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ExportScheduleButton } from '@/components/AddToCalendar'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api/client'
import { useTracks } from '@/hooks/useTracks'
import { setFavorite } from '@/components/SessionCard'
import { EN_DASH, plural } from '@/lib/format'
import { formatLabel } from '@/lib/sessions/constants'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

type Session = SessionView
type TimeSlot = NonNullable<SessionView['time_slot']>
type SortBy = 'time' | 'venue'

function formatTime(isoString: string, timeZone: string): string {
  return new Date(isoString).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatDayTab(isoString: string, timeZone: string): string {
  return new Date(isoString).toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' })
}

/** YYYY-MM-DD of an instant in the event's timezone. */
function getDateKey(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoString))
}

/** One sticky group heading for a time slot, a venue or the self-hosted block. */
function GroupHeading({ icon, children, trailing }: { icon: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="sticky-under-header z-10 -mx-4 mb-2 bg-background/95 px-4 py-1.5 backdrop-blur-sm sm:mx-0 sm:px-0">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          {icon}
          <span>{children}</span>
        </h2>
        <div className="h-px flex-1 bg-border" aria-hidden />
        {trailing}
      </div>
    </div>
  )
}

interface ScheduleCardProps {
  session: Session
  eventSlug: string
  timeZone: string
  signedIn: boolean
  isFavorited: boolean
  toggling: boolean
  onToggleFavorite: (e: React.MouseEvent, id: string) => void
  /** Which secondary details to show under the title. */
  show: { time?: boolean; venue?: boolean; track?: boolean }
}

function ScheduleCard({ session, eventSlug, timeZone, signedIn, isFavorited, toggling, onToggleFavorite, show }: ScheduleCardProps) {
  const href = `/e/${eventSlug}/sessions/${session.id}`
  const startsAt = session.time_slot?.start_time ?? session.self_hosted_start_time
  return (
    <Card
      className={cn(
        'card-hover h-full',
        session.is_self_hosted ? 'border-signal-amber/30 hover:border-signal-amber/50' : 'schedule-session hover:border-primary/50'
      )}
      style={session.is_self_hosted ? undefined : ({ '--session-color': session.track?.color || 'hsl(var(--primary))' } as React.CSSProperties)}
    >
      <CardContent className="p-3 pt-3">
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <Link href={href} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{session.title}</h3>
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              {session.is_self_hosted ? (
                <Badge variant="amber">Self-hosted</Badge>
              ) : (
                <Badge variant="secondary">{formatLabel(session.format)}</Badge>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => onToggleFavorite(e, session.id)}
                disabled={toggling}
                className={cn('-my-2 -mr-2', isFavorited ? 'text-favorite hover:text-favorite' : 'text-muted-foreground hover:text-favorite')}
                aria-pressed={isFavorited}
                aria-label={isFavorited ? `Remove ${session.title} from my schedule` : `Save ${session.title} to my schedule`}
                title={isFavorited ? 'Remove from my schedule' : signedIn ? 'Save to my schedule' : 'Sign in to save this session'}
              >
                <Heart className={cn('h-4 w-4', isFavorited && 'fill-favorite')} aria-hidden />
              </Button>
            </div>
          </div>

          <Link href={href} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {show.time && startsAt && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3 shrink-0" aria-hidden />
                  {formatTime(startsAt, timeZone)}
                </span>
              )}
              <span className="flex min-w-0 items-center gap-1">
                <User className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{hostByline(session)}</span>
              </span>
              {show.venue && session.venue && (
                <span className="flex min-w-0 items-center gap-1">
                  <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{session.venue.name}</span>
                </span>
              )}
              {show.track && session.track && (
                <span className="flex min-w-0 items-center gap-1">
                  {session.track.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: session.track.color }} aria-hidden />}
                  <span className="truncate">{session.track.name}</span>
                </span>
              )}
            </div>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}

export default function SchedulePage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { toast } = useToast()

  const { tracks } = useTracks(event.slug)
  const tz = event.timezone
  const [sessions, setSessions] = React.useState<Session[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null)
  const [trackFilter, setTrackFilter] = React.useState<string>('all')
  const [sortBy, setSortBy] = React.useState<SortBy>('time')
  const [showSelfHosted, setShowSelfHosted] = React.useState(true)
  const [search, setSearch] = React.useState('')
  const [favoriteIds, setFavoriteIds] = React.useState<Set<string>>(new Set())
  const [togglingIds, setTogglingIds] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    let mounted = true
    apiFetch<{ sessions: Session[] }>(`/api/v1/events/${encodeURIComponent(event.slug)}/sessions?status=scheduled&timed=1&sort=time`)
      .then((data) => {
        if (!mounted) return
        setSessions(data.sessions)
        setFavoriteIds(new Set(data.sessions.filter((s) => s.is_favorite).map((s) => s.id)))
        setLoadError(null)
      })
      .catch((err) => {
        if (mounted) setLoadError(err instanceof Error ? err.message : 'The schedule could not be loaded.')
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [event.slug, user?.id])

  // Slots that hold at least one scheduled session, in time order.
  const timeSlots = React.useMemo(() => {
    const byId = new Map<string, TimeSlot>()
    for (const s of sessions) if (s.time_slot) byId.set(s.time_slot.id, s.time_slot)
    return [...byId.values()].sort((a, b) => a.start_time.localeCompare(b.start_time))
  }, [sessions])

  const handleToggleFavorite = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/schedule`)}`)
      return
    }
    const isFavorited = favoriteIds.has(sessionId)
    const flip = (on: boolean) => setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
    flip(!isFavorited)
    setTogglingIds((prev) => new Set(prev).add(sessionId))
    try {
      await setFavorite(event.slug, sessionId, !isFavorited)
      toast({
        title: isFavorited ? 'Removed from my schedule' : 'Saved to my schedule',
        variant: 'success',
        action: isFavorited ? undefined : { label: 'View my schedule', onClick: () => router.push(`/e/${event.slug}/my-schedule`) },
      })
    } catch (err) {
      flip(isFavorited)
      toast({ title: 'Your saved schedule could not be updated', description: err instanceof Error ? err.message : 'Please try again.', variant: 'destructive' })
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }

  // Get unique days from time slots
  const days = React.useMemo(() => {
    const dayMap = new Map<string, string>()
    const starts = [
      ...timeSlots.map((slot) => slot.start_time),
      ...sessions.filter((s) => s.is_self_hosted && s.self_hosted_start_time).map((s) => s.self_hosted_start_time as string),
    ].sort()
    starts.forEach((start) => {
      const key = getDateKey(start, tz)
      if (!dayMap.has(key)) dayMap.set(key, start)
    })
    return Array.from(dayMap.entries()).map(([key, time]) => ({
      key,
      label: formatDayTab(time, tz),
    }))
  }, [timeSlots, sessions, tz])

  React.useEffect(() => {
    if (!selectedDay && days.length > 0) setSelectedDay(days[0].key)
  }, [days, selectedDay])

  // Filter time slots and sessions for selected day
  const filteredSlots = React.useMemo(() => {
    if (!selectedDay) return []
    return timeSlots.filter((slot) => getDateKey(slot.start_time, tz) === selectedDay)
  }, [timeSlots, selectedDay, tz])

  // Filter sessions by selected day, track, and search
  const filteredSessions = React.useMemo(() => {
    let filtered = sessions.filter((session) => {
      if (session.is_self_hosted) {
        if (!showSelfHosted) return false
        if (!session.self_hosted_start_time) return false
        if (getDateKey(session.self_hosted_start_time, tz) !== selectedDay) return false
      } else {
        if (!session.time_slot) return false
        if (getDateKey(session.time_slot.start_time, tz) !== selectedDay) return false
      }
      if (trackFilter !== 'all' && session.track?.id !== trackFilter) return false
      return true
    })
    if (search) {
      const searchLower = search.toLowerCase()
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(searchLower) ||
          s.description?.toLowerCase().includes(searchLower) ||
          hostByline(s).toLowerCase().includes(searchLower)
      )
    }
    return filtered
  }, [sessions, selectedDay, trackFilter, showSelfHosted, search, tz])

  // Group sessions by time slot for the selected day
  const sessionsBySlot = React.useMemo(() => {
    const grouped: Record<string, Session[]> = {}
    filteredSessions.forEach((session) => {
      const key = session.is_self_hosted ? 'self-hosted' : session.time_slot?.id
      if (!key) return
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(session)
    })
    return grouped
  }, [filteredSessions])

  // Group sessions by venue for venue sort mode
  const sessionsByVenue = React.useMemo(() => {
    if (sortBy !== 'venue') return null
    const grouped: Record<string, Session[]> = {}
    filteredSessions.forEach((session) => {
      const venueName = session.is_self_hosted ? 'Self-hosted' : (session.venue?.name || 'Unassigned')
      if (!grouped[venueName]) grouped[venueName] = []
      grouped[venueName].push(session)
    })
    Object.values(grouped).forEach((arr) => {
      arr.sort((a, b) => {
        const aTime = a.time_slot?.start_time || a.self_hosted_start_time || ''
        const bTime = b.time_slot?.start_time || b.self_hosted_start_time || ''
        return aTime.localeCompare(bTime)
      })
    })
    return grouped
  }, [filteredSessions, sortBy])

  if (authLoading || isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading the schedule">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  const cardProps = {
    eventSlug: event.slug,
    timeZone: tz,
    signedIn: !!user,
    onToggleFavorite: handleToggleFavorite,
  }
  const selfHostedSessions = sessionsBySlot['self-hosted'] ?? []
  const filtersActive = !!search || trackFilter !== 'all' || !showSelfHosted

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Schedule"
          subtitle="Browse sessions by day."
          actions={
            sessions.length > 0 ? (
              <ExportScheduleButton eventSlug={event.slug} eventName={event.name} favoritesOnly={false} variant="outline" size="sm" />
            ) : undefined
          }
        />

        {loadError && (
          <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</div>
        )}

        {sessions.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Calendar className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden />
              <h2 className="mb-2 text-lg font-semibold">No sessions scheduled yet</h2>
              <p className="mb-4 text-muted-foreground">
                The schedule appears here once organizers publish it. Until then, browse the proposals.
              </p>
              <Button asChild variant="outline">
                <Link href={`/e/${event.slug}/sessions`}>Browse sessions</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
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

              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  aria-label="Search the schedule"
                  placeholder="Search the schedule"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>

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

                <FilterChip pressed={showSelfHosted} onClick={() => setShowSelfHosted(!showSelfHosted)} icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}>
                  Self-hosted
                </FilterChip>

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

            <div className="space-y-4">
              {sortBy === 'time' ? (
                <>
                  {filteredSlots.map((slot) => {
                    const slotSessions = sessionsBySlot[slot.id] || []
                    if (slotSessions.length === 0) return null
                    return (
                      <div key={slot.id}>
                        <GroupHeading icon={<Clock className="h-3.5 w-3.5" aria-hidden />}>
                          {formatTime(slot.start_time, tz)} {EN_DASH} {formatTime(slot.end_time, tz)}
                        </GroupHeading>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {slotSessions.map((session) => (
                            <ScheduleCard
                              key={session.id}
                              session={session}
                              {...cardProps}
                              isFavorited={favoriteIds.has(session.id)}
                              toggling={togglingIds.has(session.id)}
                              show={{ venue: true, track: true }}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}

                  {selfHostedSessions.length > 0 && (
                    <div>
                      <GroupHeading icon={<MapPin className="h-3.5 w-3.5 text-signal-amber" aria-hidden />}>Self-hosted</GroupHeading>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {selfHostedSessions.map((session) => (
                          <ScheduleCard
                            key={session.id}
                            session={session}
                            {...cardProps}
                            isFavorited={favoriteIds.has(session.id)}
                            toggling={togglingIds.has(session.id)}
                            show={{ time: true }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {sessionsByVenue && Object.entries(sessionsByVenue)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([venueName, venueSessions]) => (
                      <div key={venueName}>
                        <GroupHeading
                          icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}
                          trailing={<span className="text-xs text-muted-foreground">{plural(venueSessions.length, 'session')}</span>}
                        >
                          {venueName}
                        </GroupHeading>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {venueSessions.map((session) => (
                            <ScheduleCard
                              key={session.id}
                              session={session}
                              {...cardProps}
                              isFavorited={favoriteIds.has(session.id)}
                              toggling={togglingIds.has(session.id)}
                              show={{ time: true, track: true }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                </>
              )}

              {filteredSessions.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center">
                    <p className="text-muted-foreground">
                      {search
                        ? 'No sessions match your search.'
                        : trackFilter !== 'all'
                          ? 'No sessions match the selected track.'
                          : 'No sessions scheduled for this day yet.'}
                    </p>
                    {filtersActive && (
                      <Button variant="outline" size="sm" className="mt-4" onClick={() => { setSearch(''); setTrackFilter('all'); setShowSelfHosted(true) }}>
                        Clear filters
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
