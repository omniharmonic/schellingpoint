'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Calendar, MapPin, Clock, User, Search, Heart } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ExportScheduleButton } from '@/components/AddToCalendar'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api/client'
import { useTracks } from '@/hooks/useTracks'
import { setFavorite } from '@/components/SessionCard'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

type Session = SessionView
type TimeSlot = NonNullable<SessionView['time_slot']>

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

export default function SchedulePage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()

  const { tracks } = useTracks(event.slug)
  const tz = event.timezone
  const [sessions, setSessions] = React.useState<Session[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null)
  const [trackFilter, setTrackFilter] = React.useState<string>('all')
  const [sortBy, setSortBy] = React.useState<'time' | 'venue'>('time')
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
        if (mounted) setLoadError(err instanceof Error ? err.message : 'The schedule could not load')
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
    } catch (err) {
      console.error('Error toggling favorite:', err instanceof Error ? err.message : err)
      flip(isFavorited)
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
        const slotDate = getDateKey(session.self_hosted_start_time, tz)
        if (slotDate !== selectedDay) return false
      } else {
        if (!session.time_slot) return false
        const slotDate = getDateKey(session.time_slot.start_time, tz)
        if (slotDate !== selectedDay) return false
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
      if (session.is_self_hosted) {
        const key = 'self-hosted'
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(session)
      } else if (session.time_slot) {
        const slotId = session.time_slot.id
        if (!grouped[slotId]) grouped[slotId] = []
        grouped[slotId].push(session)
      }
    })
    return grouped
  }, [filteredSessions])

  // Group sessions by venue for venue sort mode
  const sessionsByVenue = React.useMemo(() => {
    if (sortBy !== 'venue') return null
    const grouped: Record<string, Session[]> = {}
    filteredSessions.forEach((session) => {
      const venueName = session.is_self_hosted ? 'Self-Hosted' : (session.venue?.name || 'Unassigned')
      if (!grouped[venueName]) {
        grouped[venueName] = []
      }
      grouped[venueName].push(session)
    })
    // Sort sessions within each venue by start time
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
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="page-heading">
          <div>
            <h1 className="text-2xl font-bold">Schedule</h1>
            <p className="text-muted-foreground mt-1">
              Browse sessions by day
            </p>
          </div>
          <div className="flex gap-2">
            <ExportScheduleButton
              eventSlug={event.slug}
              eventName={event.name}
              favoritesOnly={false}
              variant="outline"
              size="sm"
            />
          </div>
        </div>

        {loadError && (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{loadError}</div>
        )}

        {sessions.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Calendar className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold mb-2">No sessions scheduled yet</h2>
              <p className="text-muted-foreground">
                Check back later once the schedule has been published.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Day Tabs and Controls */}
            <div className="space-y-3">
              <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
                {days.map((day) => (
                  <Button
                    key={day.key}
                    variant={selectedDay === day.key ? 'default' : 'outline'}
                    onClick={() => setSelectedDay(day.key)}
                    aria-label={day.label}
                    aria-pressed={selectedDay === day.key}
                    className={cn(
                      'calendar-day whitespace-nowrap flex-col items-start gap-1 h-auto',
                      selectedDay === day.key && 'btn-primary-glow'
                    )}
                  >
                    <span className="text-xs font-medium opacity-75">{day.label.split(',')[0]}</span><span className="text-lg font-semibold">{day.label.split(',').slice(1).join(',').trim() || day.label}</span>
                  </Button>
                ))}
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Search the schedule"
                  placeholder="Search the schedule"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>

              {/* Track filter and sort toggle */}
              <div className="space-y-3 sm:space-y-0 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
                {/* Sort toggle */}
                <div className="flex items-center gap-1.5 bg-muted/50 rounded-lg p-1">
                  <button
                    onClick={() => setSortBy('time')}
                    className={cn(
                      'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 min-h-[36px]',
                      sortBy === 'time'
                        ? 'bg-background shadow-sm'
                        : 'hover:bg-background/50'
                    )}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    By Time
                  </button>
                  <button
                    onClick={() => setSortBy('venue')}
                    className={cn(
                      'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 min-h-[36px]',
                      sortBy === 'venue'
                        ? 'bg-background shadow-sm'
                        : 'hover:bg-background/50'
                    )}
                  >
                    <MapPin className="h-3.5 w-3.5" />
                    By Venue
                  </button>
                </div>

                <button
                  onClick={() => setShowSelfHosted(!showSelfHosted)}
                  className={cn(
                    'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 min-h-[36px] border',
                    showSelfHosted
                      ? 'bg-orange-500/10 border-orange-500/50 text-orange-700 dark:text-orange-400'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  )}
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Self-Hosted
                </button>

                {/* Track filter */}
                {tracks.length > 0 && (
                  <div className="w-full sm:w-auto overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                    <div className="flex items-center gap-1.5 sm:gap-2 pb-2 sm:pb-0 sm:flex-wrap">
                      <span className="text-xs text-muted-foreground mr-1 whitespace-nowrap">Track:</span>
                      <button
                        onClick={() => setTrackFilter('all')}
                        className={cn(
                          'px-3 py-1.5 text-xs rounded-md transition-colors whitespace-nowrap min-h-[32px]',
                          trackFilter === 'all'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted hover:bg-muted/80'
                        )}
                      >
                        All
                      </button>
                      {tracks.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setTrackFilter(t.id)}
                          className={cn(
                            'px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap min-h-[32px]',
                            trackFilter === t.id
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted hover:bg-muted/80'
                          )}
                        >
                          {t.color && (
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: t.color }}
                            />
                          )}
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sessions for selected day */}
            <div className="space-y-4">
              {sortBy === 'time' ? (
                // Group by time slot
                <>
                  {filteredSlots.map((slot) => {
                    const slotSessions = sessionsBySlot[slot.id] || []
                    if (slotSessions.length === 0) return null

                    const startTime = formatTime(slot.start_time, tz)
                    const endTime = formatTime(slot.end_time, tz)

                    return (
                      <div key={slot.id}>
                        {/* Time header - more compact */}
                        <div className="sticky top-[104px] z-10 bg-background/95 backdrop-blur-sm py-1.5 -mx-4 px-4 sm:mx-0 sm:px-0 mb-2">
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5 text-foreground font-semibold text-lg">
                              <Clock className="h-3.5 w-3.5" />
                              <span>{startTime} - {endTime}</span>
                            </div>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                        </div>

                        {/* Session cards - compact layout */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {slotSessions.map((session) => (
                            <Card key={session.id} className="schedule-session h-full card-hover hover:border-primary/50" style={{ '--session-color': session.track?.color || 'hsl(var(--primary))' } as React.CSSProperties}>
                              <CardContent className="p-3">
                                <div className="space-y-1.5">
                                  {/* Title row with favorite button */}
                                  <div className="flex items-start justify-between gap-2">
                                    <Link href={`/e/${event.slug}/sessions/${session.id}`} className="flex-1 min-w-0">
                                      <h3 className="font-semibold text-sm leading-snug line-clamp-2">{session.title}</h3>
                                    </Link>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                      <Badge variant="secondary" className="capitalize text-xs">
                                        {session.format}
                                      </Badge>
                                      {user && (
                                        <button
                                          onClick={(e) => handleToggleFavorite(e, session.id)}
                                          disabled={togglingIds.has(session.id)}
                                          className={cn(
                                            'p-1.5 rounded-full transition-colors',
                                            favoriteIds.has(session.id)
                                              ? 'text-red-500'
                                              : 'text-muted-foreground hover:text-red-500'
                                          )}
                                          aria-label={favoriteIds.has(session.id) ? 'Remove from favorites' : 'Add to favorites'}
                                        >
                                          <Heart className={cn('h-4 w-4', favoriteIds.has(session.id) && 'fill-current')} />
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Host and venue inline */}
                                  <Link href={`/e/${event.slug}/sessions/${session.id}`} className="block">
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                      <div className="flex items-center gap-1 truncate">
                                          <User className="h-3 w-3 flex-shrink-0" />
                                          <span className="truncate">{hostByline(session)}</span>
                                        </div>
                                      {session.venue && (
                                        <div className="flex items-center gap-1 truncate">
                                          <MapPin className="h-3 w-3 flex-shrink-0" />
                                          <span className="truncate">{session.venue.name}</span>
                                        </div>
                                      )}
                                      {session.track && (
                                        <div className="flex items-center gap-1 truncate">
                                          {session.track.color && (
                                            <span
                                              className="w-2 h-2 rounded-full flex-shrink-0"
                                              style={{ backgroundColor: session.track.color }}
                                            />
                                          )}
                                          <span className="truncate">{session.track.name}</span>
                                        </div>
                                      )}
                                    </div>
                                  </Link>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </div>
                    )
                  })}

                  {/* Self-hosted sessions */}
                  {sessionsBySlot['self-hosted'] && sessionsBySlot['self-hosted'].length > 0 && (
                    <div>
                      <div className="sticky top-[104px] z-10 bg-background/95 backdrop-blur-sm py-1.5 -mx-4 px-4 sm:mx-0 sm:px-0 mb-2">
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5 text-orange-600 dark:text-orange-400 font-semibold text-sm">
                            <MapPin className="h-3.5 w-3.5" />
                            <span>Self-Hosted</span>
                          </div>
                          <div className="flex-1 h-px bg-border" />
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {sessionsBySlot['self-hosted'].map((session) => (
                          <Card key={session.id} className="h-full card-hover border-orange-500/30 hover:border-orange-500/50">
                            <CardContent className="p-3">
                              <div className="space-y-1.5">
                                {/* Title row with favorite button */}
                                <div className="flex items-start justify-between gap-2">
                                  <Link href={`/e/${event.slug}/sessions/${session.id}`} className="flex-1 min-w-0">
                                    <h3 className="font-semibold text-sm leading-snug line-clamp-2">{session.title}</h3>
                                  </Link>
                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                    <Badge variant="secondary" className="text-xs bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30">
                                      Self-Hosted
                                    </Badge>
                                    {user && (
                                      <button
                                        onClick={(e) => handleToggleFavorite(e, session.id)}
                                        disabled={togglingIds.has(session.id)}
                                        className={cn(
                                          'p-1.5 rounded-full transition-colors',
                                          favoriteIds.has(session.id)
                                            ? 'text-red-500'
                                            : 'text-muted-foreground hover:text-red-500'
                                        )}
                                        aria-label={favoriteIds.has(session.id) ? 'Remove from favorites' : 'Add to favorites'}
                                      >
                                        <Heart className={cn('h-4 w-4', favoriteIds.has(session.id) && 'fill-current')} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <Link href={`/e/${event.slug}/sessions/${session.id}`} className="block">
                                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                    {session.self_hosted_start_time && (
                                      <div className="flex items-center gap-1">
                                        <Clock className="h-3 w-3 flex-shrink-0" />
                                        <span>{formatTime(session.self_hosted_start_time, tz)}</span>
                                      </div>
                                    )}
                                    <div className="flex items-center gap-1 truncate">
                                        <User className="h-3 w-3 flex-shrink-0" />
                                        <span className="truncate">{hostByline(session)}</span>
                                      </div>
                                  </div>
                                </Link>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                // Group by venue
                <>
                  {sessionsByVenue && Object.entries(sessionsByVenue)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([venueName, venueSessions]) => (
                      <div key={venueName}>
                        {/* Venue header */}
                        <div className="sticky top-[104px] z-10 bg-background/95 backdrop-blur-sm py-1.5 -mx-4 px-4 sm:mx-0 sm:px-0 mb-2">
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5 text-foreground font-semibold text-lg">
                              <MapPin className="h-3.5 w-3.5" />
                              <span>{venueName}</span>
                            </div>
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-xs text-muted-foreground">{venueSessions.length} sessions</span>
                          </div>
                        </div>

                        {/* Session cards - compact layout */}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {venueSessions.map((session) => (
                            <Card key={session.id} className="schedule-session h-full card-hover hover:border-primary/50" style={{ '--session-color': session.track?.color || 'hsl(var(--primary))' } as React.CSSProperties}>
                              <CardContent className="p-3">
                                <div className="space-y-1.5">
                                  {/* Title row with favorite button */}
                                  <div className="flex items-start justify-between gap-2">
                                    <Link href={`/e/${event.slug}/sessions/${session.id}`} className="flex-1 min-w-0">
                                      <h3 className="font-semibold text-sm leading-snug line-clamp-2">{session.title}</h3>
                                    </Link>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                      <Badge variant="secondary" className="capitalize text-xs">
                                        {session.format}
                                      </Badge>
                                      {user && (
                                        <button
                                          onClick={(e) => handleToggleFavorite(e, session.id)}
                                          disabled={togglingIds.has(session.id)}
                                          className={cn(
                                            'p-1.5 rounded-full transition-colors',
                                            favoriteIds.has(session.id)
                                              ? 'text-red-500'
                                              : 'text-muted-foreground hover:text-red-500'
                                          )}
                                          aria-label={favoriteIds.has(session.id) ? 'Remove from favorites' : 'Add to favorites'}
                                        >
                                          <Heart className={cn('h-4 w-4', favoriteIds.has(session.id) && 'fill-current')} />
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Host and time inline */}
                                  <Link href={`/e/${event.slug}/sessions/${session.id}`} className="block">
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                      {session.time_slot && (
                                        <div className="flex items-center gap-1">
                                          <Clock className="h-3 w-3 flex-shrink-0" />
                                          <span>{formatTime(session.time_slot.start_time, tz)}</span>
                                        </div>
                                      )}
                                      <div className="flex items-center gap-1 truncate">
                                          <User className="h-3 w-3 flex-shrink-0" />
                                          <span className="truncate">{hostByline(session)}</span>
                                        </div>
                                      {session.track && (
                                        <div className="flex items-center gap-1 truncate">
                                          {session.track.color && (
                                            <span
                                              className="w-2 h-2 rounded-full flex-shrink-0"
                                              style={{ backgroundColor: session.track.color }}
                                            />
                                          )}
                                          <span className="truncate">{session.track.name}</span>
                                        </div>
                                      )}
                                    </div>
                                  </Link>
                                </div>
                              </CardContent>
                            </Card>
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
