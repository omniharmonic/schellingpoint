'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, SlidersHorizontal, Loader2, Heart, Calendar, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { FilterChip } from '@/components/ui/filter-chip'
import { RemovableChip } from '@/components/ui/removable-chip'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { SessionCard, setFavorite } from '@/components/SessionCard'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useTracks } from '@/hooks/useTracks'
import { useEvent } from '@/contexts/EventContext'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { apiFetch } from '@/lib/api/client'
import { sessionStatusBadge } from '@/lib/labels'
import { EN_DASH } from '@/lib/format'
import { formatLabel, SESSION_FORMATS } from '@/lib/sessions/constants'
import { cn } from '@/lib/utils'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

const formats = ['all', ...SESSION_FORMATS.slice(0, 5).map((f) => f.value)]
const statusOptions = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'proposed', label: 'Proposed' },
] as const
type StatusValue = (typeof statusOptions)[number]['value']
// No "most voted": vote counts are never shown while a round is open (spec §5.3); results
// after close are an organizer view.
const sortOptions = [
  { value: 'newest', label: 'Newest' },
  { value: 'title', label: `A${EN_DASH}Z` },
  { value: 'track', label: 'Track' },
  { value: 'time', label: 'By time' },
] as const
type SortValue = (typeof sortOptions)[number]['value']

// Statuses that are not publicly listed; shown only in the "My sessions" view
const OWNER_ONLY_STATUSES = new Set(['pending', 'rejected'])

export default function EventSessionsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()
  const { toast } = useToast()
  const votingOpen = isParticipationOpen(event, 'vote')
  const proposalsOpen = isParticipationOpen(event, 'propose')
  const { tracks } = useTracks(event.slug)

  const [actionError, setActionError] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState(false)
  const [sessions, setSessions] = React.useState<SessionView[]>([])
  const [favorites, setFavorites] = React.useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = React.useState(true)
  const [hasLoaded, setHasLoaded] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [debouncedSearch, setDebouncedSearch] = React.useState('')
  const [format, setFormat] = React.useState('all')
  const [track, setTrack] = React.useState<string>('all')
  const [status, setStatus] = React.useState<StatusValue>('all')
  const [sort, setSort] = React.useState<SortValue>('newest')
  const [showFilters, setShowFilters] = React.useState(false)
  const [day, setDay] = React.useState<string>('all')
  const [showFavoritesOnly, setShowFavoritesOnly] = React.useState(false)
  // ?filter=mine — sessions the current user hosts or co-hosts, in any status
  const [mineOnly, setMineOnly] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestedSort = params.get('sort')
    if (sortOptions.some((option) => option.value === requestedSort)) setSort(requestedSort as SortValue)
    if (params.get('filter') === 'mine') setMineOnly(true)
  }, [])

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])

  // Keep ?filter=mine in the URL in sync so the view is shareable/bookmarkable
  const updateMineOnly = React.useCallback((next: boolean) => {
    setMineOnly(next)
    const url = new URL(window.location.href)
    if (next) url.searchParams.set('filter', 'mine')
    else url.searchParams.delete('filter')
    window.history.replaceState(null, '', url.toString())
  }, [])

  const eventDays = React.useMemo(() => {
    return getEventDays(event.startDate, event.endDate).map((date) => ({
      date,
      label: formatCalendarDate(date, { weekday: 'short', month: 'short', day: 'numeric' }),
    }))
  }, [event.startDate, event.endDate])

  const query = React.useMemo(() => {
    const params = new URLSearchParams()
    if (mineOnly) {
      params.set('mine', '1')
      params.set('status', status === 'scheduled' ? 'scheduled' : status === 'proposed' ? 'approved,pending' : 'all')
    } else if (status === 'scheduled') params.set('status', 'scheduled')
    else if (status === 'proposed') params.set('status', 'approved')
    if (format !== 'all') params.set('format', format)
    if (track !== 'all') params.set('track', track)
    if (day !== 'all') params.set('day', day)
    if (showFavoritesOnly) params.set('favorites', '1')
    if (debouncedSearch) params.set('q', debouncedSearch)
    params.set('sort', sort)
    return params.toString()
  }, [mineOnly, status, format, track, day, showFavoritesOnly, debouncedSearch, sort])

  React.useEffect(() => {
    if ((mineOnly || showFavoritesOnly) && !user) {
      setSessions([])
      setIsLoading(false)
      setHasLoaded(true)
      return
    }
    let mounted = true
    setIsLoading(true)
    setLoadError(false)
    apiFetch<{ sessions: SessionView[] }>(`/api/v1/events/${encodeURIComponent(event.slug)}/sessions?${query}`)
      .then((data) => {
        if (!mounted) return
        setSessions(data.sessions)
        setFavorites((prev) => {
          const next = new Set(prev)
          for (const s of data.sessions) {
            if (s.is_favorite) next.add(s.id)
            else next.delete(s.id)
          }
          return next
        })
      })
      .catch((err) => {
        if (mounted) setLoadError(true)
        console.error('Error fetching sessions:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (mounted) {
          setIsLoading(false)
          setHasLoaded(true)
        }
      })
    return () => {
      mounted = false
    }
  }, [event.slug, query, user, mineOnly, showFavoritesOnly, reloadKey])

  const handleToggleFavorite = async (sessionId: string) => {
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions`)}`)
      return
    }
    const isFavorited = favorites.has(sessionId)
    setActionError(null)
    setFavorites((prev) => {
      const next = new Set(prev)
      if (isFavorited) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
    try {
      await setFavorite(event.slug, sessionId, !isFavorited)
      toast({
        title: isFavorited ? 'Removed from my schedule' : 'Saved to my schedule',
        variant: 'success',
        action: isFavorited ? undefined : { label: 'View my schedule', onClick: () => router.push(`/e/${event.slug}/my-schedule`) },
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Your saved schedule could not be updated. Please try again.')
      setFavorites((prev) => {
        const next = new Set(prev)
        if (isFavorited) next.add(sessionId)
        else next.delete(sessionId)
        return next
      })
    }
  }

  const clearFilters = () => {
    setSearch('')
    setFormat('all')
    setTrack('all')
    setStatus('all')
    setDay('all')
    setShowFavoritesOnly(false)
  }
  const filtersActive = !!debouncedSearch || format !== 'all' || track !== 'all' || status !== 'all' || day !== 'all' || showFavoritesOnly
  const activeFilterCount = [format !== 'all', track !== 'all', status !== 'all', day !== 'all', showFavoritesOnly].filter(Boolean).length

  if (!hasLoaded) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading sessions">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  const showEmpty = !loadError && !isLoading && sessions.length === 0
  const proposeButton = user && proposalsOpen ? (
    <Button asChild>
      <Link href={`/e/${event.slug}/propose`}>Propose a session</Link>
    </Button>
  ) : null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Sessions"
          subtitle={
            votingOpen
              ? 'Find something that sparks your curiosity. Your votes help shape what happens.'
              : 'Explore the ideas and people that shaped this gathering.'
          }
          actions={proposeButton}
        />

        {mineOnly && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 p-4">
            <RemovableChip label="My sessions" removeLabel="Show all sessions" onRemove={() => updateMineOnly(false)} />
            <p className="min-w-[12rem] flex-1 text-sm text-muted-foreground">
              {user
                ? 'Sessions you host or co-host, including proposals still under review.'
                : 'Sign in to see the sessions you host or co-host.'}
            </p>
            {!user && (
              <Button size="sm" asChild>
                <Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions?filter=mine`)}`}>Sign in</Link>
              </Button>
            )}
          </div>
        )}

        {actionError && (
          <p role="alert" className="sticky-under-header z-10 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{actionError}</p>
        )}
        {loadError && (
          <div role="alert" className="rounded-xl border p-5">
            <p>{mineOnly ? 'Your sessions couldn’t load.' : 'Sessions couldn’t load.'} Please try again.</p>
            <Button className="mt-3" variant="outline" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                aria-label="Search sessions"
                placeholder="Search ideas, hosts or topics"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
              {isLoading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
            </div>
            <Button
              variant="outline"
              aria-expanded={showFilters}
              onClick={() => setShowFilters(!showFilters)}
              className={cn(showFilters && 'bg-accent')}
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden />
              Filters
              {activeFilterCount > 0 && <Badge variant="default" className="ml-2 px-1.5 py-0">{activeFilterCount}</Badge>}
            </Button>
          </div>

          {showFilters && (
            <div className="flex flex-wrap gap-5 rounded-xl border bg-muted/30 p-4">
              {user && (
                <div className="flex w-full flex-wrap gap-2">
                  <FilterChip pressed={mineOnly} onClick={() => updateMineOnly(!mineOnly)} icon={<Mic className="h-4 w-4" aria-hidden />}>
                    My sessions
                  </FilterChip>
                  <FilterChip
                    pressed={showFavoritesOnly}
                    onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                    icon={<Heart className={cn('h-4 w-4', showFavoritesOnly && 'fill-current')} aria-hidden />}
                  >
                    Saved only
                  </FilterChip>
                </div>
              )}

              {eventDays.length > 1 && (
                <div className="w-full space-y-2 sm:w-auto">
                  <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Calendar className="h-3 w-3" aria-hidden />
                    Day
                  </span>
                  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                    <div className="flex gap-2 pb-2 sm:flex-wrap sm:pb-0">
                      {[{ date: 'all', label: 'All days' }, ...eventDays].map((d) => (
                        <FilterChip key={d.date} pressed={day === d.date} onClick={() => setDay(d.date)}>
                          {d.label}
                        </FilterChip>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Format</span>
                <div className="flex flex-wrap gap-2">
                  {formats.map((f) => (
                    <FilterChip key={f} pressed={format === f} onClick={() => setFormat(f)}>
                      {f === 'all' ? 'All' : formatLabel(f)}
                    </FilterChip>
                  ))}
                </div>
              </div>

              {tracks.length > 0 && (
                <div className="w-full space-y-2 sm:w-auto">
                  <span className="text-xs font-medium text-muted-foreground">Track</span>
                  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                    <div className="flex gap-2 pb-2 sm:flex-wrap sm:pb-0">
                      <FilterChip pressed={track === 'all'} onClick={() => setTrack('all')}>All</FilterChip>
                      {tracks.map((t) => (
                        <FilterChip
                          key={t.id}
                          pressed={track === t.id}
                          onClick={() => setTrack(t.id)}
                          icon={t.color ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} aria-hidden /> : undefined}
                        >
                          {t.name}
                        </FilterChip>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Status</span>
                <div>
                  <SegmentedControl<StatusValue> aria-label="Status" value={status} onValueChange={setStatus} options={statusOptions} />
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Sort by</span>
                <div>
                  <SegmentedControl<SortValue> aria-label="Sort by" value={sort} onValueChange={setSort} options={sortOptions} />
                </div>
              </div>

              {filtersActive && (
                <div className="flex w-full justify-end">
                  <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
                </div>
              )}
            </div>
          )}
        </div>

        {!showEmpty && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => {
              const ownerStatus = mineOnly && OWNER_ONLY_STATUSES.has(session.status) ? sessionStatusBadge(session.status) : undefined
              return (
                <div key={session.id} className="space-y-2">
                  {ownerStatus && (
                    <div className="flex items-center justify-between gap-2 px-1">
                      <Badge variant={ownerStatus.badge}>{ownerStatus.label}</Badge>
                      <Link href={`/e/${event.slug}/sessions/${session.id}`} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                        {session.status === 'pending' ? 'View or edit' : 'View'}
                      </Link>
                    </div>
                  )}
                  <SessionCard
                    session={session}
                    eventSlug={event.slug}
                    isFavorited={favorites.has(session.id)}
                    onToggleFavorite={handleToggleFavorite}
                    showVoting={votingOpen && !ownerStatus}
                    isLoggedIn={!!user}
                  />
                </div>
              )
            })}
          </div>
        )}

        {showEmpty && (
          <div className="py-12 text-center">
            <h2 className="mb-2 text-xl font-semibold">
              {filtersActive
                ? 'No sessions match just yet.'
                : mineOnly
                  ? user ? 'You aren’t hosting any sessions yet.' : 'Sign in to see your sessions.'
                  : 'What could we explore together?'}
            </h2>
            <p className="text-muted-foreground">
              {filtersActive
                ? 'Try another search or clear your filters.'
                : mineOnly
                  ? user && proposalsOpen
                    ? 'Propose a session and it will show up here, even while it is under review.'
                    : user ? 'Sessions you host or co-host will appear here.' : ''
                  : proposalsOpen
                    ? 'Be the first to bring an idea to the gathering.'
                    : 'Sessions will appear here as the community shapes the program.'}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              {filtersActive && <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              {mineOnly && <Button variant="outline" onClick={() => updateMineOnly(false)}>Show all sessions</Button>}
              {proposeButton}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
