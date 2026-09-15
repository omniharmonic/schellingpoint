'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, SlidersHorizontal, Loader2, Heart, Calendar, Mic, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SessionCard, setFavorite } from '@/components/SessionCard'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useTracks } from '@/hooks/useTracks'
import { useEvent } from '@/contexts/EventContext'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

const formats = ['all', 'talk', 'workshop', 'discussion', 'panel', 'demo']
const statusOptions = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'proposed', label: 'Proposed' },
]
// No "most voted": vote counts are never shown while a round is open (spec §5.3); results
// after close are an organizer view.
const sortOptions = [
  { value: 'newest', label: 'Newest' },
  { value: 'title', label: 'A-Z' },
  { value: 'track', label: 'Track' },
  { value: 'time', label: 'By Time' },
] as const
type SortValue = (typeof sortOptions)[number]['value']

// Statuses that are not publicly listed; shown only in the "My sessions" view
const ownerOnlyStatus: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending review', className: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/40' },
  rejected: { label: 'Not selected', className: 'bg-destructive/10 text-destructive border-destructive/30' },
}

export default function EventSessionsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()
  const votingOpen = isParticipationOpen(event, 'vote')
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
  const [status, setStatus] = React.useState('all')
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

  if (!hasLoaded) {
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
        <div>
          <h1 className="text-2xl font-display font-bold">Sessions</h1>
          <p className="text-muted-foreground mt-1">
            {votingOpen
              ? 'Find something that sparks your curiosity. Your votes help shape what happens.'
              : 'Explore the ideas and people that shaped this gathering.'}
          </p>
        </div>

        {mineOnly && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 p-4">
            <Badge variant="secondary" className="flex items-center gap-1.5 px-2.5 py-1 text-sm">
              <Mic className="h-3.5 w-3.5" />
              My sessions
              <button
                type="button"
                aria-label="Show all sessions"
                onClick={() => updateMineOnly(false)}
                className="ml-1 rounded-full p-0.5 hover:bg-foreground/10"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Badge>
            <p className="text-sm text-muted-foreground flex-1 min-w-[12rem]">
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

        {actionError && <p role="alert" className="sticky top-20 z-10 rounded-xl border bg-card p-4 text-sm text-destructive">{actionError}</p>}
        {loadError && (
          <div role="alert" className="rounded-xl border p-5">
            <p>{mineOnly ? 'Your sessions couldn’t load.' : 'Sessions couldn’t load.'} Please try again.</p>
            <Button className="mt-3" variant="outline" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Search sessions"
                placeholder="Search ideas, hosts, or topics"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
              {isLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <Button
              variant="outline"
              aria-expanded={showFilters}
              onClick={() => setShowFilters(!showFilters)}
              className={cn(showFilters && 'bg-accent')}
            >
              <SlidersHorizontal className="h-4 w-4 mr-2" />
              Filters
            </Button>
          </div>

          {showFilters && (
            <div className="flex flex-wrap gap-4 p-4 rounded-lg border bg-muted/30">
              {user && (
                <div className="w-full flex flex-wrap gap-2">
                  <button
                    onClick={() => updateMineOnly(!mineOnly)}
                    aria-pressed={mineOnly}
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors',
                      mineOnly ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                    )}
                  >
                    <Mic className="h-4 w-4" />
                    My Sessions
                  </button>
                  <button
                    onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                    aria-pressed={showFavoritesOnly}
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors',
                      showFavoritesOnly ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                    )}
                  >
                    <Heart className={cn('h-4 w-4', showFavoritesOnly && 'fill-current')} />
                    My Favorites Only
                  </button>
                </div>
              )}

              {eventDays.length > 1 && (
                <div className="space-y-1.5 w-full sm:w-auto">
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Day
                  </span>
                  <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                    <div className="flex gap-1.5 pb-2 sm:pb-0 sm:flex-wrap">
                      {[{ date: 'all', label: 'All Days' }, ...eventDays].map((d) => (
                        <button
                          key={d.date}
                          onClick={() => setDay(d.date)}
                          aria-pressed={day === d.date}
                          className={cn(
                            'px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap',
                            day === d.date ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                          )}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Format</span>
                <div className="flex flex-wrap gap-1.5">
                  {formats.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      aria-pressed={format === f}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors capitalize',
                        format === f ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                      )}
                    >
                      {f === 'all' ? 'All' : f}
                    </button>
                  ))}
                </div>
              </div>

              {tracks.length > 0 && (
                <div className="space-y-1.5 w-full sm:w-auto">
                  <span className="text-xs font-medium text-muted-foreground">Track</span>
                  <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                    <div className="flex gap-1.5 pb-2 sm:pb-0 sm:flex-wrap">
                      <button
                        onClick={() => setTrack('all')}
                        aria-pressed={track === 'all'}
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap min-h-[36px]',
                          track === 'all' ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                        )}
                      >
                        All
                      </button>
                      {tracks.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setTrack(t.id)}
                          aria-pressed={track === t.id}
                          className={cn(
                            'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap min-h-[36px]',
                            track === t.id ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                          )}
                        >
                          {t.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: t.color }} />}
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Status</span>
                <div className="flex gap-1.5">
                  {statusOptions.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setStatus(s.value)}
                      aria-pressed={status === s.value}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors',
                        status === s.value ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Sort by</span>
                <div className="flex gap-1.5">
                  {sortOptions.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSort(s.value)}
                      aria-pressed={sort === s.value}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors',
                        sort === s.value ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent'
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sessions.map((session) => {
            const ownerStatus = mineOnly ? ownerOnlyStatus[session.status] : undefined
            return (
              <div key={session.id} className="space-y-2">
                {ownerStatus && (
                  <div className="flex items-center justify-between gap-2 px-1">
                    <Badge variant="outline" className={cn('text-xs', ownerStatus.className)}>{ownerStatus.label}</Badge>
                    <Link href={`/e/${event.slug}/sessions/${session.id}`} className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
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

        {mineOnly && !loadError && !isLoading && sessions.length === 0 && (
          <div className="text-center py-12">
            <h2 className="text-xl font-semibold mb-2">{filtersActive ? 'No sessions match just yet.' : user ? "You aren't hosting any sessions yet." : 'Sign in to see your sessions.'}</h2>
            <p className="text-muted-foreground">{filtersActive ? 'Try another search or clear your filters.' : user && isParticipationOpen(event, 'propose') ? 'Propose a session and it will show up here, even while it is under review.' : user ? 'Sessions you host or co-host will appear here.' : ''}</p>
            <div className="flex flex-wrap justify-center gap-3 mt-4">
              {filtersActive && <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              <Button variant="outline" onClick={() => updateMineOnly(false)}>Show all sessions</Button>
              {user && isParticipationOpen(event, 'propose') && (
                <Button asChild>
                  <Link href={`/e/${event.slug}/propose`}>Propose a Session</Link>
                </Button>
              )}
            </div>
          </div>
        )}

        {!mineOnly && !loadError && !isLoading && sessions.length === 0 && (
          <div className="text-center py-12">
            <h2 className="text-xl font-semibold mb-2">{filtersActive ? 'No sessions match just yet.' : 'What could we explore together?'}</h2>
            <p className="text-muted-foreground">{filtersActive ? 'Try another search or clear your filters.' : isParticipationOpen(event, 'propose') ? 'Be the first to bring an idea to the gathering.' : 'Sessions will appear here as the community shapes the program.'}</p>
            {filtersActive && <Button variant="outline" className="mt-4 mr-3" onClick={clearFilters}>Clear filters</Button>}
            {user && isParticipationOpen(event, 'propose') && (
              <Button asChild className="mt-4">
                <Link href={`/e/${event.slug}/propose`}>Propose a Session</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
