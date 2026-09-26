'use client'

/**
 * The one schedule body (mobile shell design §4). `view="program"` is the published program,
 * `view="mine"` is the sessions the viewer saved; the two 500-line pages that each had their own
 * copy of the day logic, the grouping and the headings are gone.
 *
 * Shared: day chips, the By time / By venue control, track chips, the card, the group heading.
 * Program only: search, and the "Self-hosted" chip. My schedule only: the Happening-now strip and
 * the dashed "Not yet scheduled" tail. Signed-out viewers on the saved tab get the sign-in prompt
 * where the list would be.
 *
 * No vote counts anywhere (spec §5.3), and no leaderboard: sessions are ordered by time or by room.
 */

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Calendar, Clock, Heart, Loader2, MapPin, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FilterChip } from '@/components/ui/filter-chip'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/hooks/useAuth'
import { useTracks } from '@/hooks/useTracks'
import { useEvent } from '@/contexts/EventContext'
import { EN_DASH, plural } from '@/lib/format'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import { GroupHeading } from './GroupHeading'
import { HappeningNow } from './HappeningNow'
import { ScheduleCard, formatTime } from './ScheduleCard'
import { dateKey, dayLabel, useSchedule, type ScheduleSession, type ScheduleViewMode } from './useSchedule'

type GroupBy = 'time' | 'venue'

const SELF_HOSTED_GROUP = 'Self-hosted'

export function ScheduleView({ view }: { view: ScheduleViewMode }) {
  const router = useRouter()
  const event = useEvent()
  const { user, isLoading: authLoading } = useAuth()
  const { toast } = useToast()
  const { tracks } = useTracks(event.slug)
  const tz = event.timezone

  const signedOutOnMine = !authLoading && !user && view === 'mine'
  const data = useSchedule(event.slug, view, !signedOutOnMine && !authLoading)

  const [selectedDay, setSelectedDay] = React.useState<string | null>(null)
  const [trackFilter, setTrackFilter] = React.useState('all')
  const [groupBy, setGroupBy] = React.useState<GroupBy>('time')
  const [showSelfHosted, setShowSelfHosted] = React.useState(true)
  const [search, setSearch] = React.useState('')

  const onToggleFavorite = async (sessionId: string) => {
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/schedule${view === 'mine' ? '?view=mine' : ''}`)}`)
      return
    }
    const wasSaved = data.favoriteIds.has(sessionId)
    const result = await data.toggleFavorite(sessionId, !wasSaved)
    if (!result) {
      toast({
        title: 'Your saved schedule could not be updated',
        description: data.actionError ?? 'Please try again.',
        variant: 'destructive',
      })
      return
    }
    toast({
      title: result.saved ? 'Saved to my schedule' : 'Removed from my schedule',
      variant: 'success',
      action: wasSaved
        ? { label: 'Undo', onClick: () => void data.toggleFavorite(sessionId, true) }
        : view === 'program'
          ? { label: 'View my schedule', onClick: () => router.push(`/e/${event.slug}/schedule?view=mine`) }
          : undefined,
    })
  }

  const timed = React.useMemo(() => data.sessions.filter((s) => s.when), [data.sessions])
  const untimed = React.useMemo(() => data.sessions.filter((s) => !s.when), [data.sessions])

  // Days that hold at least one session with a time, in time order.
  const days = React.useMemo(() => {
    const first = new Map<string, string>()
    for (const start of timed.map((s) => s.when!.start_time).sort()) {
      const key = dateKey(start, tz)
      if (!first.has(key)) first.set(key, start)
    }
    return [...first.entries()].map(([key, start]) => ({ key, label: dayLabel(start, tz) }))
  }, [timed, tz])

  React.useEffect(() => {
    if (days.length > 0 && (!selectedDay || !days.some((d) => d.key === selectedDay))) setSelectedDay(days[0].key)
  }, [days, selectedDay])

  const searchTerm = view === 'program' ? search.trim().toLowerCase() : ''

  const filtered = React.useMemo(() => {
    return timed.filter((s) => {
      if (s.is_self_hosted && view === 'program' && !showSelfHosted) return false
      if (selectedDay && dateKey(s.when!.start_time, tz) !== selectedDay) return false
      if (trackFilter !== 'all' && s.track?.id !== trackFilter) return false
      if (
        searchTerm &&
        !s.title.toLowerCase().includes(searchTerm) &&
        !s.description?.toLowerCase().includes(searchTerm) &&
        !hostByline(s).toLowerCase().includes(searchTerm)
      ) {
        return false
      }
      return true
    })
  }, [timed, view, showSelfHosted, selectedDay, trackFilter, searchTerm, tz])

  const filteredUntimed = React.useMemo(() => {
    if (view !== 'mine') return []
    if (trackFilter === 'all') return untimed
    return untimed.filter((s) => s.track?.id === trackFilter)
  }, [untimed, view, trackFilter])

  /** [group label, sessions] in display order; the key is a start instant or a venue name. */
  const groups = React.useMemo<Array<{ key: string; label: React.ReactNode; count: number; rows: ScheduleSession[] }>>(() => {
    if (groupBy === 'venue') {
      const byVenue = new Map<string, ScheduleSession[]>()
      for (const s of filtered) {
        const name = s.is_self_hosted ? SELF_HOSTED_GROUP : (s.venue?.name || 'Unassigned')
        const list = byVenue.get(name)
        if (list) list.push(s)
        else byVenue.set(name, [s])
      }
      return [...byVenue.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, rows]) => ({
          key: name,
          label: name,
          count: rows.length,
          rows: [...rows].sort((a, b) => a.when!.start_time.localeCompare(b.when!.start_time)),
        }))
    }
    const byStart = new Map<string, ScheduleSession[]>()
    for (const s of filtered) {
      const key = s.when!.start_time
      const list = byStart.get(key)
      if (list) list.push(s)
      else byStart.set(key, [s])
    }
    return [...byStart.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([start, rows]) => {
        const end = rows.find((r) => r.when?.end_time)?.when?.end_time ?? null
        return {
          key: start,
          label: end ? `${formatTime(start, tz)} ${EN_DASH} ${formatTime(end, tz)}` : formatTime(start, tz),
          count: rows.length,
          rows,
        }
      })
  }, [filtered, groupBy, tz])

  const size = view === 'mine' ? 'md' : 'sm'
  const gridClass = view === 'mine' ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'
  const cardProps = {
    eventSlug: event.slug,
    timeZone: tz,
    signedIn: !!user,
    onToggleFavorite,
  }
  const filtersActive = !!search || trackFilter !== 'all' || (view === 'program' && !showSelfHosted)
  const clearFilters = () => {
    setSearch('')
    setTrackFilter('all')
    setShowSelfHosted(true)
  }

  if (signedOutOnMine) {
    return (
      <Card data-testid="schedule-view" data-view={view}>
        <CardContent className="py-12 text-center">
          <Heart className="mx-auto mb-4 h-10 w-10 text-muted-foreground" aria-hidden />
          <h2 className="mb-2 text-lg font-semibold">Sign in to keep a schedule</h2>
          <p className="mb-4 text-muted-foreground">Saved sessions are yours: nobody else sees what you saved.</p>
          <Button asChild>
            <Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/schedule?view=mine`)}`}>Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (authLoading || data.loading) {
    return (
      <div
        className="flex items-center justify-center py-12"
        role="status"
        aria-label={view === 'mine' ? 'Loading your schedule' : 'Loading the schedule'}
        data-testid="schedule-view"
        data-view={view}
      >
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const nothingAtAll = data.sessions.length === 0

  return (
    <div className="space-y-6" data-testid="schedule-view" data-view={view}>
      {data.loadError && (
        <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {data.loadError}
        </div>
      )}

      {view === 'mine' && <HappeningNow eventSlug={event.slug} timeZone={tz} saved={data.sessions} />}

      {nothingAtAll ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="mx-auto mb-4 h-10 w-10 text-muted-foreground" aria-hidden />
            <h2 className="mb-2 text-lg font-semibold">
              {view === 'mine' ? 'No sessions saved yet' : 'No sessions scheduled yet'}
            </h2>
            <p className="mb-4 text-muted-foreground">
              {view === 'mine'
                ? 'Tap the heart on a session to keep it here.'
                : 'The schedule appears here once organizers publish it. Until then, browse the proposals.'}
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

            {view === 'program' && (
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
            )}

            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl<GroupBy>
                aria-label="Group by"
                size="sm"
                value={groupBy}
                onValueChange={setGroupBy}
                options={[
                  { value: 'time', label: 'By time', icon: <Clock className="h-3.5 w-3.5" aria-hidden /> },
                  { value: 'venue', label: 'By venue', icon: <MapPin className="h-3.5 w-3.5" aria-hidden /> },
                ]}
              />

              {view === 'program' && (
                <FilterChip
                  pressed={showSelfHosted}
                  onClick={() => setShowSelfHosted(!showSelfHosted)}
                  icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}
                >
                  Self-hosted
                </FilterChip>
              )}

              {tracks.length > 0 && (
                <div className="-mx-4 w-full overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
                  <div className="flex items-center gap-2 pb-2 sm:flex-wrap sm:pb-0" role="group" aria-label="Track">
                    <span className="mr-1 whitespace-nowrap text-xs text-muted-foreground">Track:</span>
                    <FilterChip pressed={trackFilter === 'all'} onClick={() => setTrackFilter('all')}>
                      All
                    </FilterChip>
                    {tracks.map((t) => (
                      <FilterChip
                        key={t.id}
                        pressed={trackFilter === t.id}
                        onClick={() => setTrackFilter(t.id)}
                        icon={
                          t.color ? (
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} aria-hidden />
                          ) : undefined
                        }
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
            {groups.map((group) => (
              <div key={group.key}>
                <GroupHeading
                  icon={
                    groupBy === 'venue' ? (
                      <MapPin className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Clock className="h-3.5 w-3.5" aria-hidden />
                    )
                  }
                  trailing={
                    groupBy === 'venue' ? (
                      <span className="text-xs text-muted-foreground">{plural(group.count, 'session')}</span>
                    ) : undefined
                  }
                >
                  {group.label}
                </GroupHeading>
                <div className={gridClass}>
                  {group.rows.map((session) => (
                    <ScheduleCard
                      key={session.id}
                      session={session}
                      {...cardProps}
                      isFavorited={data.favoriteIds.has(session.id)}
                      toggling={data.togglingIds.has(session.id)}
                      size={size}
                      show={
                        groupBy === 'venue'
                          ? { time: true, track: true }
                          : { venue: true, track: true }
                      }
                    />
                  ))}
                </div>
              </div>
            ))}

            {groups.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">
                    {searchTerm
                      ? 'No sessions match your search.'
                      : trackFilter !== 'all'
                        ? 'No sessions match the selected track.'
                        : view === 'mine'
                          ? 'No sessions saved for this day.'
                          : 'No sessions scheduled for this day yet.'}
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {filtersActive && (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    )}
                    {view === 'mine' && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/e/${event.slug}/schedule`}>Browse the schedule</Link>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {filteredUntimed.length > 0 && (
              <div>
                <GroupHeading icon={<Calendar className="h-3.5 w-3.5" aria-hidden />}>Not yet scheduled</GroupHeading>
                <div className={gridClass}>
                  {filteredUntimed.map((session) => (
                    <ScheduleCard
                      key={session.id}
                      session={session}
                      {...cardProps}
                      isFavorited={data.favoriteIds.has(session.id)}
                      toggling={data.togglingIds.has(session.id)}
                      size={size}
                      show={{ duration: true }}
                      dashed
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
