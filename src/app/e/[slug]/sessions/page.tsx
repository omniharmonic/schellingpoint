'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, SlidersHorizontal, Loader2, Heart, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SessionCard } from '@/components/SessionCard'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { votesToCredits, cn } from '@/lib/utils'

// Helper to format date in timezone as yyyy-MM-dd
function formatDateInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(date)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const formats = ['all', 'talk', 'workshop', 'discussion', 'panel', 'demo']
const statusOptions = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'proposed', label: 'Proposed' },
]
const sortOptions = [
  { value: 'votes', label: 'Most Voted' },
  { value: 'recent', label: 'Recent' },
  { value: 'alpha', label: 'A-Z' },
  { value: 'time', label: 'By Time' },
]

function getAccessToken(): string | null {
  const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  const stored = localStorage.getItem(storageKey)
  if (stored) {
    try {
      const session = JSON.parse(stored)
      return session?.access_token || null
    } catch {
      return null
    }
  }
  return null
}

interface Track {
  id: string
  name: string
  color: string | null
}

export default function EventSessionsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()
  const votingClosed = !isParticipationOpen(event, 'vote')
  const { voteCredits } = useEventRole()

  // Use event's vote credits per user
  const totalCredits = voteCredits

  const [actionError, setActionError] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState(false)
  const [tracks, setTracks] = React.useState<Track[]>([])
  const [sessions, setSessions] = React.useState<any[]>([])
  const [userVotes, setUserVotes] = React.useState<Record<string, number>>({})
  const [favorites, setFavorites] = React.useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = React.useState(true)
  const [search, setSearch] = React.useState('')
  const [format, setFormat] = React.useState('all')
  const [track, setTrack] = React.useState<string>('all')
  const [status, setStatus] = React.useState('all')
  const [sort, setSort] = React.useState('votes')
  const [showFilters, setShowFilters] = React.useState(false)
  const [day, setDay] = React.useState<string>('all')
  const [showFavoritesOnly, setShowFavoritesOnly] = React.useState(false)

  React.useEffect(() => {
    const requestedSort = new URLSearchParams(window.location.search).get('sort')
    if (sortOptions.some(option => option.value === requestedSort)) setSort(requestedSort!)
  }, [])

  // Generate list of event days
  const eventDays = React.useMemo(() => {
    return getEventDays(event.startDate, event.endDate).map(date => ({
      date,
      label: formatCalendarDate(date, { weekday: 'short', month: 'short', day: 'numeric' }),
    }))
  }, [event.startDate, event.endDate, event.timezone])

  // Stable sort positions — captures server order on load, prevents jumps during voting
  const stableVoteOrderRef = React.useRef<Record<string, number>>({})

  // Calculate credits spent using the event's voting mechanism
  const creditsSpent = React.useMemo(() => {
    return Object.values(userVotes).reduce(
      (sum, votes) => sum + votesToCredits(votes, event.votingMechanism),
      0
    )
  }, [userVotes, event.votingMechanism])

  const creditsRemaining = totalCredits - creditsSpent

  // Fetch tracks for this event on mount
  React.useEffect(() => {
    let mounted = true

    const fetchTracks = async () => {
      try {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/tracks?event_id=eq.${event.id}&is_active=eq.true&select=id,name,color&order=name`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
          }
        )

        if (response.ok && mounted) {
          const data = await response.json()
          setTracks(data)
        }
      } catch (err) {
        console.error('Error fetching tracks:', err)
      }
    }

    fetchTracks()

    return () => {
      mounted = false
    }
  }, [event.id])

  // Fetch sessions on mount
  React.useEffect(() => {
    let mounted = true

    const fetchSessions = async () => {
      setLoadError(false)
      try {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&status=in.(approved,scheduled)&select=*,venue:venues(name),time_slot:time_slots(label,start_time),track:tracks(id,name,color),cohosts:session_cohosts(profile:profiles(display_name))&order=total_votes.desc`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
          }
        )

        if (!response.ok) throw new Error('Sessions unavailable')
        if (mounted) {
          const data = await response.json()
          const order: Record<string, number> = {}
          data.forEach((s: any, i: number) => { order[s.id] = i })
          stableVoteOrderRef.current = order
          setSessions(data)
        }
      } catch (err) {
        if (mounted) setLoadError(true)
        console.error('Error fetching sessions:', err)
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    fetchSessions()

    return () => {
      mounted = false
    }
  }, [event.id])

  // Fetch user votes and favorites when user changes
  React.useEffect(() => {
    if (!user) {
      setUserVotes({})
      setFavorites(new Set())
      return
    }

    const fetchUserData = async () => {
      const token = getAccessToken()
      if (!token) return

      try {
        // Fetch votes for this event's sessions
        const votesResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/votes?user_id=eq.${user.id}&event_id=eq.${event.id}&select=session_id,vote_count`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )

        if (votesResponse.ok) {
          const votesData = await votesResponse.json()
          const votesMap: Record<string, number> = {}
          votesData.forEach((v: any) => {
            votesMap[v.session_id] = v.vote_count
          })
          setUserVotes(votesMap)
        }

        // Fetch favorites for this event's sessions
        const favResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&event_id=eq.${event.id}&select=session_id`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )

        if (favResponse.ok) {
          const favData = await favResponse.json()
          setFavorites(new Set(favData.map((f: any) => f.session_id)))
        }
      } catch (err) {
        console.error('Error fetching user data:', err)
      }
    }

    fetchUserData()
  }, [user, event.id])

  // Handle vote change
  const handleVote = async (sessionId: string, newVoteCount: number) => {
    if (votingClosed) return
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions`)}`)
      return
    }

    const token = getAccessToken()
    if (!token) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions`)}`)
      return
    }

    const oldVotes = userVotes[sessionId] || 0
    const oldCredits = votesToCredits(oldVotes, event.votingMechanism)
    const newCredits = votesToCredits(newVoteCount, event.votingMechanism)
    const creditDiff = newCredits - oldCredits
    const voteDiff = newVoteCount - oldVotes

    // Check if user has enough credits
    if (creditsSpent + creditDiff > totalCredits) {
      return
    }

    setActionError(null)
    // Optimistic update for user votes
    setUserVotes((prev) => ({ ...prev, [sessionId]: newVoteCount }))

    setActionError(null)
    // Optimistic update for session total_votes (in-place, no re-sort)
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, total_votes: Math.max(0, (s.total_votes || 0) + voteDiff) }
          : s
      )
    )

    try {
      if (newVoteCount === 0) {
        // Delete vote
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/votes?user_id=eq.${user.id}&session_id=eq.${sessionId}`,
          {
            method: 'DELETE',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )
        if (!response.ok) {
          throw new Error('Delete failed')
        }
      } else {
        // Upsert vote
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/votes?on_conflict=user_id,session_id`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates',
            },
            body: JSON.stringify({
              user_id: user.id,
              session_id: sessionId,
              event_id: event.id,
              vote_count: newVoteCount,
              credits_spent: newCredits,
            }),
          }
        )
        if (!response.ok) {
          throw new Error('Upsert failed')
        }
      }
      window.dispatchEvent(new CustomEvent('schelling:votes-changed', { detail: { eventId: event.id } }))
      // Note: We no longer call refreshSessions() here to avoid re-sorting
      // Sessions will refresh on page load or manual refresh
    } catch (err) {
      setActionError('Your vote could not be saved. Please try again.')
      console.error('Error voting:', err)
      // Revert both on error
      setUserVotes((prev) => ({ ...prev, [sessionId]: oldVotes }))
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, total_votes: Math.max(0, (s.total_votes || 0) - voteDiff) }
            : s
        )
      )
    }
  }

  // Handle favorite toggle
  const handleToggleFavorite = async (sessionId: string) => {
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions`)}`)
      return
    }

    const token = getAccessToken()
    if (!token) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions`)}`)
      return
    }

    const isFavorited = favorites.has(sessionId)

    setActionError(null)
    // Optimistic update
    setFavorites((prev) => {
      const next = new Set(prev)
      if (isFavorited) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })

    try {
      if (isFavorited) {
        // Delete favorite
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&session_id=eq.${sessionId}`,
          {
            method: 'DELETE',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )
        if (!response.ok) throw new Error('Save failed')
      } else {
        // Add favorite
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/favorites`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              user_id: user.id,
              session_id: sessionId,
              event_id: event.id,
            }),
          }
        )
        if (!response.ok) throw new Error('Save failed')
      }
    } catch (err) {
      setActionError('Your saved schedule could not be updated. Please try again.')
      console.error('Error toggling favorite:', err)
      // Revert on error
      setFavorites((prev) => {
        const next = new Set(prev)
        if (isFavorited) {
          next.add(sessionId)
        } else {
          next.delete(sessionId)
        }
        return next
      })
    }
  }

  // Filter and sort sessions
  const filteredSessions = React.useMemo(() => {
    let filtered = sessions

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase()
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(searchLower) ||
          s.description?.toLowerCase().includes(searchLower) ||
          s.host_name?.toLowerCase().includes(searchLower)
      )
    }

    // Format filter
    if (format !== 'all') {
      filtered = filtered.filter((s) => s.format === format)
    }

    // Track filter
    if (track !== 'all') {
      filtered = filtered.filter((s) => s.track?.id === track)
    }

    // Status filter (scheduled vs proposed/approved)
    if (status === 'scheduled') {
      filtered = filtered.filter((s) => s.status === 'scheduled')
    } else if (status === 'proposed') {
      filtered = filtered.filter((s) => s.status === 'approved')
    }

    // Day filter (only for scheduled sessions)
    if (day !== 'all') {
      filtered = filtered.filter((s) => {
        if (!s.time_slot?.start_time) return false
        const sessionDate = formatDateInTimezone(
          new Date(s.time_slot.start_time),
          event.timezone
        )
        return sessionDate === day
      })
    }

    // Favorites filter
    if (showFavoritesOnly) {
      filtered = filtered.filter((s) => favorites.has(s.id))
    }

    // Sort
    if (sort === 'votes') {
      // Use stable positions from last server fetch — prevents jumping during voting
      const order = stableVoteOrderRef.current
      filtered = [...filtered].sort((a, b) =>
        (order[a.id] ?? Infinity) - (order[b.id] ?? Infinity)
      )
    } else if (sort === 'recent') {
      filtered = [...filtered].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    } else if (sort === 'alpha') {
      filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title))
    } else if (sort === 'time') {
      // Sort by scheduled time (scheduled sessions first, then unscheduled)
      filtered = [...filtered].sort((a, b) => {
        const aTime = a.time_slot?.start_time ? new Date(a.time_slot.start_time).getTime() : Infinity
        const bTime = b.time_slot?.start_time ? new Date(b.time_slot.start_time).getTime() : Infinity
        return aTime - bTime
      })
    }

    return filtered
  }, [sessions, search, format, track, status, sort, day, showFavoritesOnly, favorites, event.timezone])

  if (isLoading) {
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
        {/* Title */}
        <div>
          <h1 className="text-2xl font-display font-bold">Sessions</h1>
          <p className="text-muted-foreground mt-1">
            {votingClosed ? 'Explore the ideas and people that shaped this gathering. Voting is not open right now.' : 'Find something that sparks your curiosity. Your votes help shape what happens.'}
          </p>
        </div>

        {actionError && <p role="alert" className="sticky top-20 z-10 rounded-xl border bg-card p-4 text-sm text-destructive">{actionError}</p>}
        {loadError && <div role="alert" className="rounded-xl border p-5"><p>Sessions couldn’t load. Please try again.</p><Button className="mt-3" variant="outline" onClick={() => window.location.reload()}>Try again</Button></div>}
        {/* Search and Filters */}
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
              {/* Favorites toggle */}
              {user && (
                <div className="w-full">
                  <button
                    onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors',
                      showFavoritesOnly
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background border hover:bg-accent'
                    )}
                  >
                    <Heart className={cn('h-4 w-4', showFavoritesOnly && 'fill-current')} />
                    My Favorites Only
                  </button>
                </div>
              )}

              {/* Day filter */}
              {eventDays.length > 1 && (
                <div className="space-y-1.5 w-full sm:w-auto">
                  <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Day
                  </label>
                  <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                    <div className="flex gap-1.5 pb-2 sm:pb-0 sm:flex-wrap">
                      <button
                        onClick={() => setDay('all')}
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap',
                          day === 'all'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-background border hover:bg-accent'
                        )}
                      >
                        All Days
                      </button>
                      {eventDays.map((d) => (
                        <button
                          key={d.date}
                          onClick={() => setDay(d.date)}
                          className={cn(
                            'px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap',
                            day === d.date
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-background border hover:bg-accent'
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
                <label className="text-xs font-medium text-muted-foreground">Format</label>
                <div className="flex flex-wrap gap-1.5">
                  {formats.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors capitalize',
                        format === f
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background border hover:bg-accent'
                      )}
                    >
                      {f === 'all' ? 'All' : f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5 w-full sm:w-auto">
                <label className="text-xs font-medium text-muted-foreground">Track</label>
                <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                  <div className="flex gap-1.5 pb-2 sm:pb-0 sm:flex-wrap">
                    <button
                      onClick={() => setTrack('all')}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap min-h-[36px]',
                        track === 'all'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background border hover:bg-accent'
                      )}
                    >
                      All
                    </button>
                    {tracks.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setTrack(t.id)}
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap min-h-[36px]',
                          track === t.id
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-background border hover:bg-accent'
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
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Status</label>
                <div className="flex gap-1.5">
                  {statusOptions.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setStatus(s.value)}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors',
                        status === s.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background border hover:bg-accent'
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Sort by</label>
                <div className="flex gap-1.5">
                  {sortOptions.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSort(s.value)}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md transition-colors',
                        sort === s.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background border hover:bg-accent'
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

        {/* Sessions Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              eventSlug={event.slug}
              userVotes={userVotes[session.id] || 0}
              isFavorited={favorites.has(session.id)}
              remainingCredits={creditsRemaining}
              onVote={handleVote}
              onToggleFavorite={handleToggleFavorite}
              showVoting={!votingClosed}
              isLoggedIn={!!user}
              votingMechanism={event.votingMechanism}
            />
          ))}
        </div>

        {!loadError && filteredSessions.length === 0 && (
          <div className="text-center py-12">
            <h2 className="text-xl font-semibold mb-2">{sessions.length ? 'No sessions match just yet.' : 'What could we explore together?'}</h2>
            <p className="text-muted-foreground">{sessions.length ? 'Try another search or clear your filters.' : isParticipationOpen(event, 'propose') ? 'Be the first to bring an idea to the gathering.' : 'Sessions will appear here as the community shapes the program.'}</p>
            {sessions.length > 0 && <Button variant="outline" className="mt-4 mr-3" onClick={() => { setSearch(''); setFormat('all'); setTrack('all'); setStatus('all'); setDay('all'); setShowFavoritesOnly(false) }}>Clear filters</Button>}
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
