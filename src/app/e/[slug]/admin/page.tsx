'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Mail, LayoutGrid, Plus, Table, Grid3X3, Beaker, Trash2, ArrowUpRight, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { AdminStats } from '@/components/admin/AdminStats'
import { SessionCard } from '@/components/admin/SessionCard'
import { SessionTable, Session } from '@/components/admin/SessionTable'
import { SessionFilters, defaultFilters } from '@/components/admin/SessionFilters'
import { BatchActions } from '@/components/admin/BatchActions'
import Link from 'next/link'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

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

type SessionStatus = 'pending' | 'approved' | 'rejected' | 'scheduled'
type SortField = 'votes' | 'title' | 'duration' | 'created_at'
type SortDirection = 'asc' | 'desc'
type ViewMode = 'table' | 'cards'

interface Track {
  id: string
  name: string
  color: string
}

interface Venue {
  id: string
  name: string
  capacity: number
}

interface TimeSlot {
  id: string
  label: string
  start_time: string
  end_time: string
}

export default function AdminPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { isAdmin, isLoading: roleLoading, can } = useEventRole()

  const [sessions, setSessions] = React.useState<Session[]>([])
  const [venues, setVenues] = React.useState<Venue[]>([])
  const [timeSlots, setTimeSlots] = React.useState<TimeSlot[]>([])
  const [tracks, setTracks] = React.useState<Track[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [activeTab, setActiveTab] = React.useState<'all' | 'pending' | 'approved' | 'scheduled'>('all')
  const [viewMode, setViewMode] = React.useState<ViewMode>('table')

  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  // Selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [isBatchLoading, setIsBatchLoading] = React.useState(false)

  // Filter state
  const [filters, setFilters] = React.useState(defaultFilters)

  // Sort state
  const [sortField, setSortField] = React.useState<SortField>('votes')
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('desc')

  // Redirect if not admin
  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !isAdmin)) {
      router.push(`/e/${event.slug}/sessions`)
    }
  }, [user, isAdmin, authLoading, roleLoading, router, event.slug])

  // Fetch data
  React.useEffect(() => {
    if (authLoading || roleLoading || !isAdmin) return
    const fetchData = async () => {
      setIsLoading(true)
      const token = getAccessToken()
      const authHeader = token ? `Bearer ${token}` : `Bearer ${SUPABASE_KEY}`

      setLoadError(null)
      try {
        const [sessionsRes, venuesRes, timeSlotsRes, tracksRes] = await Promise.all([
          fetch(
            `${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&select=*,venue:venues(id,name),time_slot:time_slots(id,label,start_time),track:tracks(id,name,color),cohosts:session_cohosts(user_id)&order=total_votes.desc`,
            {
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': authHeader,
              },
            }
          ),
          fetch(
            `${SUPABASE_URL}/rest/v1/venues?event_id=eq.${event.id}&select=*&order=name`,
            {
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': authHeader,
              },
            }
          ),
          fetch(
            `${SUPABASE_URL}/rest/v1/time_slots?event_id=eq.${event.id}&select=*&order=start_time`,
            {
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': authHeader,
              },
            }
          ),
          fetch(
            `${SUPABASE_URL}/rest/v1/tracks?event_id=eq.${event.id}&select=*&order=name`,
            {
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': authHeader,
              },
            }
          ),
        ])

        if (![sessionsRes, venuesRes, timeSlotsRes, tracksRes].every(response => response.ok)) {
          throw new Error('Unable to load the organizer workspace. Refresh the page to try again.')
        }
        if (sessionsRes.ok) {
          const data = await sessionsRes.json()
          setSessions(data)
        }
        if (venuesRes.ok) {
          const data = await venuesRes.json()
          setVenues(data)
        }
        if (timeSlotsRes.ok) {
          const data = await timeSlotsRes.json()
          setTimeSlots(data)
        }
        if (tracksRes.ok) {
          const data = await tracksRes.json()
          setTracks(data)
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Unable to load event data. Please try again.')
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
  }, [event.id, authLoading, roleLoading, isAdmin])

  // Clear selection when tab changes
  React.useEffect(() => {
    setSelectedIds(new Set())
  }, [activeTab, filters])

  // Filter and sort sessions
  const filteredSessions = React.useMemo(() => {
    let result = [...sessions]

    // Tab filter
    if (activeTab !== 'all') {
      result = result.filter((s) => s.status === activeTab)
    }

    // Search filter
    if (filters.search) {
      const searchLower = filters.search.toLowerCase()
      result = result.filter((s) =>
        s.title.toLowerCase().includes(searchLower) ||
        s.host_name?.toLowerCase().includes(searchLower) ||
        s.topic_tags?.some((t) => t.toLowerCase().includes(searchLower))
      )
    }

    // Status filter (when on 'all' tab)
    if (filters.statuses.length > 0 && activeTab === 'all') {
      result = result.filter((s) => filters.statuses.includes(s.status))
    }

    // Track filter
    if (filters.tracks.length > 0) {
      result = result.filter((s) => s.track_id && filters.tracks.includes(s.track_id))
    }

    // Format filter
    if (filters.formats.length > 0) {
      result = result.filter((s) => filters.formats.includes(s.format))
    }

    // Vote range filter
    if (filters.minVotes !== null) {
      result = result.filter((s) => s.total_votes >= filters.minVotes!)
    }
    if (filters.maxVotes !== null) {
      result = result.filter((s) => s.total_votes <= filters.maxVotes!)
    }

    // Has time preference
    if (filters.hasTimePreference === true) {
      result = result.filter((s) => s.time_preferences && s.time_preferences.length > 0)
    }

    // Has co-hosts
    if (filters.hasCohosts === true) {
      result = result.filter((s) => s.cohosts && s.cohosts.length > 0)
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case 'votes':
          comparison = a.total_votes - b.total_votes
          break
        case 'title':
          comparison = a.title.localeCompare(b.title)
          break
        case 'duration':
          comparison = a.duration - b.duration
          break
        case 'created_at':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
      }
      return sortDirection === 'desc' ? -comparison : comparison
    })

    return result
  }, [sessions, activeTab, filters, sortField, sortDirection])

  // Get unique formats from sessions
  const uniqueFormats = React.useMemo(() => {
    return Array.from(new Set(sessions.map((s) => s.format)))
  }, [sessions])

  const handleSortChange = (field: SortField) => {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  // Batch operations
  const executeBatchAction = async (
    action: 'approve' | 'reject' | 'assign_track' | 'delete',
    extra?: { reason?: string; track_id?: string | null }
  ) => {
    const token = getAccessToken()
    if (!token) return

    setActionError(null)
    setIsBatchLoading(true)

    try {
      const response = await fetch(`/api/v1/events/${event.slug}/sessions/batch`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          action,
          session_ids: Array.from(selectedIds),
          ...extra,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        setActionError(data.error || 'The selected sessions could not be updated. Please try again.')
        return
      }

      // Update local state based on action
      if (action === 'approve') {
        setSessions((prev) =>
          prev.map((s) =>
            selectedIds.has(s.id) ? { ...s, status: 'approved' as SessionStatus } : s
          )
        )
      } else if (action === 'reject') {
        setSessions((prev) =>
          prev.map((s) =>
            selectedIds.has(s.id) ? { ...s, status: 'rejected' as SessionStatus } : s
          )
        )
      } else if (action === 'assign_track') {
        const track = tracks.find((t) => t.id === extra?.track_id) || null
        setSessions((prev) =>
          prev.map((s) =>
            selectedIds.has(s.id)
              ? { ...s, track_id: extra?.track_id || null, track }
              : s
          )
        )
      } else if (action === 'delete') {
        setSessions((prev) => prev.filter((s) => !selectedIds.has(s.id)))
      }

      setSelectedIds(new Set())
    } catch (err) {
      console.error('Batch operation error:', err)
      setActionError('The selected sessions could not be updated. Please try again.')
    } finally {
      setIsBatchLoading(false)
    }
  }

  // A failed HTTP response must never appear to be a successful session change.
  const saveSessionChange = async (url: string, options: RequestInit) => {
    setActionError(null)
    const response = await fetch(url, options)
    if (!response.ok) throw new Error('Unable to save session')
    return response
  }

  // Single session operations (for card view)
  const handleApprove = async (sessionId: string) => {
    const token = getAccessToken()
    if (!token) return

    try {
      await saveSessionChange(
        `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&event_id=eq.${event.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'approved' }),
        }
      )

      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status: 'approved' as SessionStatus } : s))
      )
    } catch (err) {
      setActionError('The session could not be updated. Please try again.')
      console.error('Error approving session:', err)
    }
  }

  const handleReject = async (sessionId: string) => {
    const token = getAccessToken()
    if (!token) return

    try {
      await saveSessionChange(
        `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&event_id=eq.${event.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'rejected' }),
        }
      )

      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status: 'rejected' as SessionStatus } : s))
      )
    } catch (err) {
      setActionError('The session could not be updated. Please try again.')
      console.error('Error rejecting session:', err)
    }
  }

  const handleSchedule = async (sessionId: string, venueId: string, timeSlotId: string) => {
    const token = getAccessToken()
    if (!token) return

    const venue = venues.find((v) => v.id === venueId)
    const timeSlot = timeSlots.find((t) => t.id === timeSlotId)

    try {
      await saveSessionChange(
        `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&event_id=eq.${event.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'scheduled',
            venue_id: venueId,
            time_slot_id: timeSlotId,
          }),
        }
      )

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'scheduled' as SessionStatus,
                venue_id: venueId,
                time_slot_id: timeSlotId,
                venue: venue ? { id: venue.id, name: venue.name } : null,
                time_slot: timeSlot
                  ? { id: timeSlot.id, label: timeSlot.label, start_time: timeSlot.start_time }
                  : null,
              }
            : s
        )
      )

      // Notify host
      fetch(`/api/sessions/${sessionId}/notify-host`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch((err) => console.error('Notify host error:', err))
    } catch (err) {
      setActionError('The session could not be updated. Please try again.')
      console.error('Error scheduling session:', err)
    }
  }

  const handleUnschedule = async (sessionId: string) => {
    const token = getAccessToken()
    if (!token) return

    try {
      await saveSessionChange(
        `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&event_id=eq.${event.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status: 'approved',
            venue_id: null,
            time_slot_id: null,
          }),
        }
      )

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'approved' as SessionStatus,
                venue_id: null,
                time_slot_id: null,
                venue: null,
                time_slot: null,
              }
            : s
        )
      )
    } catch (err) {
      setActionError('The session could not be updated. Please try again.')
      console.error('Error unscheduling session:', err)
    }
  }

  const handleDelete = async (sessionId: string) => {
    const token = getAccessToken()
    if (!token) return

    try {
      const response = await saveSessionChange(
        `${SUPABASE_URL}/rest/v1/sessions?id=eq.${sessionId}&event_id=eq.${event.id}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
          },
        }
      )

      if (response.ok || response.status === 204) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      }
    } catch (err) {
      setActionError('The session could not be updated. Please try again.')
      console.error('Error deleting session:', err)
    }
  }

  const handleNotifyHost = async (sessionId: string) => {
    const token = getAccessToken()
    if (!token) return

    try {
      const res = await fetch(`/api/sessions/${sessionId}/notify-host`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        if (data.sent) {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? { ...s, host_notified_at: new Date().toISOString() }
                : s
            )
          )
        }
      }
    } catch (err) {
      console.error('Error notifying host:', err)
    }
  }

  const [isBulkNotifying, setIsBulkNotifying] = React.useState(false)
  const [isSeeding, setIsSeeding] = React.useState(false)
  const [isClearing, setIsClearing] = React.useState(false)

  const handleNotifyAllHosts = async () => {
    const token = getAccessToken()
    if (!token) return

    const unnotified = sessions.filter(
      (s) => s.status === 'scheduled' && !s.host_notified_at
    )
    if (unnotified.length === 0) return

    setIsBulkNotifying(true)
    let sentCount = 0

    for (const session of unnotified) {
      try {
        const res = await fetch(`/api/sessions/${session.id}/notify-host`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          if (data.sent) {
            sentCount++
            setSessions((prev) =>
              prev.map((s) =>
                s.id === session.id
                  ? { ...s, host_notified_at: new Date().toISOString() }
                  : s
              )
            )
          }
        }
      } catch (err) {
        console.error(`Notify error for ${session.title}:`, err)
      }
    }

    setIsBulkNotifying(false)
    alert(`Sent ${sentCount} notification(s).`)
  }

  // Test data operations
  const handleSeedTestSessions = async () => {
    const token = getAccessToken()
    if (!token) return

    if (!confirm('This will create ~28 test sessions prefixed with [TEST]. Continue?')) {
      return
    }

    setIsSeeding(true)
    try {
      const response = await fetch(`/api/v1/events/${event.slug}/admin/seed-sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        alert(data.message)
        // Refresh the page to show new sessions
        window.location.reload()
      } else {
        const data = await response.json()
        alert(data.error || 'Failed to create test sessions')
      }
    } catch (err) {
      console.error('Error seeding test sessions:', err)
      setActionError('The selected sessions could not be updated. Please try again.')
    } finally {
      setIsSeeding(false)
    }
  }

  const handleClearTestSessions = async () => {
    const token = getAccessToken()
    if (!token) return

    if (!confirm('This will delete all sessions prefixed with [TEST]. Continue?')) {
      return
    }

    setIsClearing(true)
    try {
      const response = await fetch(`/api/v1/events/${event.slug}/admin/seed-sessions`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        alert(data.message)
        // Remove test sessions from local state
        setSessions((prev) => prev.filter((s) => !s.title.startsWith('[TEST]')))
      } else {
        const data = await response.json()
        alert(data.error || 'Failed to delete test sessions')
      }
    } catch (err) {
      console.error('Error clearing test sessions:', err)
      setActionError('The selected sessions could not be updated. Please try again.')
    } finally {
      setIsClearing(false)
    }
  }

  const testSessionCount = sessions.filter((s) => s.title.startsWith('[TEST]')).length

  const pendingSessions = sessions.filter((s) => s.status === 'pending')
  const approvedSessions = sessions.filter((s) => s.status === 'approved')
  const scheduledSessions = sessions.filter((s) => s.status === 'scheduled')
  const rejectedSessions = sessions.filter((s) => s.status === 'rejected')

  // Determine allowed batch actions based on current tab
  const getAllowedBatchActions = (): ('approve' | 'reject' | 'assign_track' | 'delete')[] => {
    switch (activeTab) {
      case 'pending':
        return ['approve', 'reject', 'assign_track', 'delete']
      case 'approved':
        return ['reject', 'assign_track', 'delete']
      case 'scheduled':
        return ['assign_track', 'delete']
      default:
        return ['approve', 'reject', 'assign_track', 'delete']
    }
  }

  if (authLoading || roleLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAdmin) {
    return null
  }

  return (
    <>
        <div className="space-y-8">
          {/* Page Header */}
          <div className="page-heading organizer-welcome">
            <div>
              <h1 className="text-2xl font-display font-bold">Make space for good ideas.</h1>
              <p className="text-muted-foreground">Your program takes shape here. Review ideas and help them find their place.</p>
            </div>
            <Button asChild>
              <Link href={`/e/${event.slug}/admin/sessions/new`}>
                <Plus className="h-4 w-4 mr-2" />
                Add a session
              </Link>
            </Button>
          </div>

          {loadError && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-destructive">{loadError}</p><Button variant="outline" size="sm" onClick={() => window.location.reload()}>Try again</Button></div>}

          {actionError && <p role="alert" className="sticky top-20 z-10 rounded-xl border border-destructive/30 bg-card p-4 text-sm text-destructive">{actionError}</p>}

          {event.status === 'draft' && can('editEventSettings') && <Card className="border-primary/25 bg-secondary"><CardContent className="p-6 flex flex-wrap items-center justify-between gap-5"><div><h2 className="text-xl font-semibold">Ready to invite your people?</h2><p className="mt-2 text-sm text-muted-foreground max-w-xl">Your event is a draft. Review the invitation, publish it, then open proposals when you’re ready to hear from the community.</p></div><Button asChild><Link href={`/e/${event.slug}/admin/settings`}>Review & publish</Link></Button></CardContent></Card>}

          {/* Stats Overview */}
          <AdminStats
            pending={pendingSessions.length}
            approved={approvedSessions.length}
            scheduled={scheduledSessions.length}
            rejected={rejectedSessions.length}
            venues={venues.length}
            timeSlots={timeSlots.length}
          />

          <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]" aria-label="Next steps">
            <div className="rounded-2xl border border-primary/25 bg-secondary p-6 sm:p-8">
              <div className="flex items-center gap-2 text-primary text-sm font-medium mb-4"><FileText className="h-4 w-4"/>Next up</div>
              <h2 className="text-2xl sm:text-3xl font-semibold mb-3 leading-tight">{pendingSessions.length > 0 ? `${pendingSessions.length} idea${pendingSessions.length === 1 ? '' : 's'} waiting for a little attention` : 'You’re all caught up on reviews.'}</h2>
              <p className="text-sm text-muted-foreground max-w-md mb-5">{pendingSessions.length > 0 ? 'Review proposals so your community can discover and support them.' : 'New proposals will appear here. In the meantime, keep shaping your gathering.'}</p>
              {pendingSessions.length > 0 ? <Button onClick={() => { setActiveTab('pending'); setFilters(defaultFilters); document.getElementById('session-review')?.scrollIntoView({ block: 'start' }) }}>Review proposals</Button> : <Button asChild variant="outline"><Link href={`/e/${event.slug}`}>View event page<ArrowUpRight className="h-4 w-4 ml-2"/></Link></Button>}
            </div>
            <div className="rounded-2xl border bg-card p-6 flex flex-col">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-4"><LayoutGrid className="h-4 w-4"/>Program progress</div>
              <h2 className="text-xl font-semibold mb-2">{scheduledSessions.length} session{scheduledSessions.length === 1 ? '' : 's'} on the schedule</h2>
              <p className="text-sm text-muted-foreground mb-4">{approvedSessions.length} approved and ready to place.</p>
              <div className="h-2 bg-muted rounded-full overflow-hidden mb-5" role="progressbar" aria-label="Approved sessions scheduled" aria-valuemin={0} aria-valuemax={approvedSessions.length + scheduledSessions.length || 1} aria-valuenow={scheduledSessions.length}><div className="h-full bg-primary rounded-full" style={{ width: `${scheduledSessions.length / (approvedSessions.length + scheduledSessions.length || 1) * 100}%` }}/></div>
              {can('manageSchedule') && <Link href={`/e/${event.slug}/admin/schedule`} className="mt-auto inline-flex gap-2 items-center text-sm font-semibold text-primary">Open schedule builder<ArrowUpRight className="h-4 w-4"/></Link>}
            </div>
          </section>

          {/* Test Data Tools */}
          {process.env.NODE_ENV === 'development' && (
            <details className="rounded-xl border p-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Development tools</summary><Card className="mt-4 bg-amber-500/5 border-amber-500/20">
              <CardContent className="py-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <p className="font-medium flex items-center gap-2">
                      <Beaker className="h-4 w-4 text-amber-600" />
                      Test Data Tools
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Generate test sessions for auto-scheduler testing
                      {testSessionCount > 0 && (
                        <span className="ml-1 text-amber-600">
                          ({testSessionCount} test sessions exist)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSeedTestSessions}
                      disabled={isSeeding || isClearing}
                    >
                      {isSeeding ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Beaker className="h-4 w-4 mr-1" />
                          Generate Test Sessions
                        </>
                      )}
                    </Button>
                    {testSessionCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleClearTestSessions}
                        disabled={isSeeding || isClearing}
                        className="text-destructive hover:text-destructive"
                      >
                        {isClearing ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            Clearing...
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-4 w-4 mr-1" />
                            Clear Test Data
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card></details>
          )}

          {/* Tabs and View Toggle */}
          <div id="session-review" className="scroll-mt-24 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex gap-1 sm:gap-2 border-b overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:border-b-0">
              {(['all', 'pending', 'approved', 'scheduled'] as const).map((tab) => {
                const count = tab === 'all' ? sessions.length :
                  tab === 'pending' ? pendingSessions.length :
                  tab === 'approved' ? approvedSessions.length :
                  scheduledSessions.length
                return (
                  <button
                    key={tab}
                    aria-pressed={activeTab === tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      'px-3 sm:px-4 py-2 text-sm font-medium border-b-2 sm:border-b-0 sm:rounded-md -mb-px sm:mb-0 transition-colors whitespace-nowrap capitalize',
                      activeTab === tab
                        ? 'border-primary text-primary sm:bg-primary/10'
                        : 'border-transparent text-muted-foreground hover:text-foreground sm:hover:bg-muted'
                    )}
                  >
                    {tab} ({count})
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex border rounded-md">
                <Button
                  variant={viewMode === 'table' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('table')}
                  aria-label="Table view" aria-pressed={viewMode === 'table'}
                  className="rounded-r-none"
                >
                  <Table className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === 'cards' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('cards')}
                  aria-label="Card view" aria-pressed={viewMode === 'cards'}
                  className="rounded-l-none"
                >
                  <Grid3X3 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Filters */}
          <SessionFilters
            filters={filters}
            onFiltersChange={setFilters}
            tracks={tracks}
            formats={uniqueFormats}
            totalCount={
              activeTab === 'all' ? sessions.length :
              activeTab === 'pending' ? pendingSessions.length :
              activeTab === 'approved' ? approvedSessions.length :
              scheduledSessions.length
            }
            filteredCount={filteredSessions.length}
          />

          {/* Notify All Banner (for scheduled tab) */}
          {activeTab === 'scheduled' && scheduledSessions.some((s) => !s.host_notified_at) && (
            <div className="flex flex-wrap gap-3 items-center justify-between bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {scheduledSessions.filter((s) => !s.host_notified_at).length} scheduled session(s) have not been notified.
              </p>
              <Button
                size="sm"
                onClick={handleNotifyAllHosts}
                disabled={isBulkNotifying}
              >
                {isBulkNotifying ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4 mr-1" />
                    Notify All Hosts
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Sessions List/Table */}
          {filteredSessions.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {JSON.stringify(filters) !== JSON.stringify(defaultFilters)
                  ? 'No sessions match your filters.'
                  : `No ${activeTab === 'all' ? '' : activeTab} sessions yet.`}
                <div className="mt-4"><Button variant="outline" onClick={() => { setFilters(defaultFilters); setActiveTab('all') }}>Show all sessions</Button></div>
              </CardContent>
            </Card>
          ) : viewMode === 'table' ? (
            <SessionTable
              sessions={filteredSessions}
              eventSlug={event.slug}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              sortField={sortField}
              sortDirection={sortDirection}
              onSortChange={handleSortChange}
            />
          ) : (
            <div className="space-y-3">
              {filteredSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  eventSlug={event.slug}
                  venues={venues}
                  timeSlots={timeSlots}
                  onApprove={session.status === 'pending' ? () => handleApprove(session.id) : undefined}
                  onReject={session.status === 'pending' ? () => handleReject(session.id) : undefined}
                  onSchedule={session.status === 'approved' ? (v, t) => handleSchedule(session.id, v, t) : undefined}
                  onUnschedule={session.status === 'scheduled' ? () => handleUnschedule(session.id) : undefined}
                  onDelete={() => handleDelete(session.id)}
                  onNotify={session.status === 'scheduled' && !session.host_notified_at ? () => handleNotifyHost(session.id) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      {/* Batch Actions Toolbar */}
      <BatchActions
        selectedCount={selectedIds.size}
        tracks={tracks}
        onApprove={getAllowedBatchActions().includes('approve') ? () => executeBatchAction('approve') : undefined}
        onReject={getAllowedBatchActions().includes('reject') ? (reason) => executeBatchAction('reject', { reason }) : undefined}
        onAssignTrack={getAllowedBatchActions().includes('assign_track') ? (trackId) => executeBatchAction('assign_track', { track_id: trackId || null }) : undefined}
        onDelete={getAllowedBatchActions().includes('delete') ? () => executeBatchAction('delete') : undefined}
        onClearSelection={() => setSelectedIds(new Set())}
        isLoading={isBatchLoading}
        allowedActions={getAllowedBatchActions()}
      />
    </>
  )
}
