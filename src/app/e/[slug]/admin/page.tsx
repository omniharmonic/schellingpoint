'use client'

import * as React from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, Beaker, FileText, Grid3X3, LayoutGrid, Loader2, Lock, Mail, Plus, Table, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { AdminStats } from '@/components/admin/AdminStats'
import { SessionCard } from '@/components/admin/SessionCard'
import { SessionTable, type SortDirection, type SortField } from '@/components/admin/SessionTable'
import { SessionFilters, defaultFilters } from '@/components/admin/SessionFilters'
import { BatchActions } from '@/components/admin/BatchActions'
import { hostLabel, type AdminSession, type AdminSessionsResponse, type AdminTimeSlot, type AdminTrack, type AdminVenue } from '@/components/admin/types'

type Tab = 'all' | 'pending' | 'approved' | 'scheduled' | 'rejected'
type ViewMode = 'table' | 'cards'
type BatchAction = 'approve' | 'reject' | 'assign_track' | 'delete'

interface Overview {
  counts: { pending: number; approved: number; rejected: number; scheduled: number; total: number }
  schedule: { venues: number; sessionSlots: number; filledSlots: number; unpublishedChanges: number; publishedAt: string | null }
  flagged: Array<{ id: string; title: string; kind: 'cid_drift' | 'withdrawn'; message: string; networkPublished: boolean }>
  voting: { status: string; closesAt: string | null }
}

interface BatchResponse {
  affected: number
  affectedIds: string[]
  skipped: Array<{ id: string; title: string; reason: string }>
  message: string
}

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export default function AdminPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const canReview = can('approveProposals')
  const canSchedule = can('manageSchedule')

  const [overview, setOverview] = React.useState<Overview | null>(null)
  const [data, setData] = React.useState<AdminSessionsResponse | null>(null)
  const [venues, setVenues] = React.useState<AdminVenue[]>([])
  const [timeSlots, setTimeSlots] = React.useState<AdminTimeSlot[]>([])
  const [tracks, setTracks] = React.useState<AdminTrack[]>([])
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const [activeTab, setActiveTab] = React.useState<Tab>('all')
  const [viewMode, setViewMode] = React.useState<ViewMode>('table')
  const [filters, setFilters] = React.useState(defaultFilters)
  const [sortField, setSortField] = React.useState<SortField>('created_at')
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('desc')
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ kind: 'success' | 'error'; text: string; details?: string[] } | null>(null)
  const [devConfirm, setDevConfirm] = React.useState<'seed' | 'clear' | null>(null)

  React.useEffect(() => {
    if (notice?.kind !== 'success') return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const base = `/api/v1/events/${event.slug}`

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const [ov, sessions, v, t, tr] = await Promise.all([
        apiFetch<Overview>(`${base}/admin/overview`),
        apiFetch<AdminSessionsResponse>(`${base}/admin/sessions`),
        apiFetch<{ venues: AdminVenue[] }>(`${base}/admin/venues`),
        apiFetch<{ timeSlots: AdminTimeSlot[] }>(`${base}/admin/time-slots`),
        apiFetch<{ tracks: AdminTrack[] }>(`${base}/admin/tracks`),
      ])
      setOverview(ov)
      setData(sessions)
      setVenues(v.venues)
      setTimeSlots(t.timeSlots)
      setTracks(tr.tracks)
    } catch (e) {
      setLoadError(errorText(e, 'Unable to load the organizer workspace. Try again.'))
    } finally {
      setIsLoading(false)
    }
  }, [base])

  React.useEffect(() => {
    if (canReview || canSchedule) void load()
    else setIsLoading(false)
  }, [load, canReview, canSchedule])
  React.useEffect(() => { setSelectedIds(new Set()) }, [activeTab, filters])

  const sessions = React.useMemo(() => data?.sessions ?? [], [data])
  const results = data?.results ?? null
  // "Most votes" exists only once no round is open, and only here, for organizers (spec §3, §5.3).
  const votesSortable = results !== null && data?.voting.status !== 'open'
  React.useEffect(() => {
    if (!votesSortable && sortField === 'votes') setSortField('created_at')
  }, [votesSortable, sortField])

  const byStatus = (status: AdminSession['status']) => sessions.filter((s) => s.status === status)
  const counts = { pending: byStatus('pending').length, approved: byStatus('approved').length, scheduled: byStatus('scheduled').length, rejected: byStatus('rejected').length }

  const filteredSessions = React.useMemo(() => {
    let list = activeTab === 'all' ? [...sessions] : sessions.filter((s) => s.status === activeTab)
    if (filters.search) {
      const q = filters.search.toLowerCase()
      list = list.filter((s) =>
        s.title.toLowerCase().includes(q) ||
        (hostLabel(s) ?? '').toLowerCase().includes(q) ||
        s.topic_tags?.some((t) => t.toLowerCase().includes(q)),
      )
    }
    if (filters.statuses.length && activeTab === 'all') list = list.filter((s) => filters.statuses.includes(s.status))
    if (filters.tracks.length) list = list.filter((s) => s.track_id && filters.tracks.includes(s.track_id))
    if (filters.formats.length) list = list.filter((s) => s.format && filters.formats.includes(s.format))
    if (filters.flaggedOnly) list = list.filter((s) => s.proposal_drift_at || s.proposal_withdrawn_at)
    if (filters.hasTimePreference) list = list.filter((s) => s.time_preferences && s.time_preferences.length > 0)
    if (filters.hasCohosts) list = list.filter((s) => s.cohost_count > 0)
    list.sort((a, b) => {
      let cmp = 0
      if (sortField === 'votes' && results) cmp = (results[a.id]?.votes ?? 0) - (results[b.id]?.votes ?? 0)
      else if (sortField === 'title') cmp = a.title.localeCompare(b.title)
      else if (sortField === 'duration') cmp = (a.duration ?? 0) - (b.duration ?? 0)
      else cmp = Date.parse(a.created_at) - Date.parse(b.created_at)
      return sortDirection === 'desc' ? -cmp : cmp
    })
    return list
  }, [sessions, activeTab, filters, sortField, sortDirection, results])

  const formats = React.useMemo(() => Array.from(new Set(sessions.map((s) => s.format).filter((f): f is string => Boolean(f)))), [sessions])

  const handleSortChange = (field: SortField) => {
    if (field === 'votes' && !votesSortable) return
    if (field === sortField) setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const runBatch = async (action: BatchAction, ids: string[], extra: { reason?: string; track_id?: string | null } = {}) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = await apiFetch<BatchResponse>(`${base}/sessions/batch`, {
        method: 'PATCH',
        json: { action, session_ids: ids, ...extra },
      })
      setNotice({
        kind: res.skipped.length && !res.affected ? 'error' : 'success',
        text: res.message,
        details: res.skipped.map((s) => `${s.title}: ${s.reason}`),
      })
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The selected sessions could not be updated. Try again.') })
    } finally {
      setBusy(false)
    }
  }

  const schedule = async (sessionId: string, timeSlotId: string) => {
    setBusy(true)
    setNotice(null)
    try {
      await apiFetch(`${base}/admin/sessions/${sessionId}/schedule`, { method: 'PUT', json: { time_slot_id: timeSlotId } })
      setNotice({ kind: 'success', text: 'Scheduled; the host was notified. Publish the schedule to update the public calendar.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The session could not be scheduled.') })
    } finally {
      setBusy(false)
    }
  }

  const unschedule = async (sessionId: string) => {
    setBusy(true)
    setNotice(null)
    try {
      await apiFetch(`${base}/admin/sessions/${sessionId}/schedule`, { method: 'DELETE' })
      setNotice({ kind: 'success', text: 'Removed from the draft schedule.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The session could not be unscheduled.') })
    } finally {
      setBusy(false)
    }
  }

  const notifyHost = async (sessionId: string) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = await apiFetch<{ sent: boolean; delivered?: boolean }>(`/api/sessions/${sessionId}/notify-host`, { method: 'POST' })
      setNotice({ kind: 'success', text: res.delivered === false ? 'Mail is not configured here; the email was logged instead.' : 'Host emailed.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The host could not be emailed.') })
    } finally {
      setBusy(false)
    }
  }

  const devTools = async (mode: 'seed' | 'clear') => {
    setDevConfirm(null)
    setBusy(true)
    setNotice(null)
    try {
      const res = await apiFetch<{ message: string }>(`${base}/admin/seed-sessions`, { method: mode === 'seed' ? 'POST' : 'DELETE' })
      setNotice({ kind: 'success', text: res.message })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'Test data could not be changed.') })
    } finally {
      setBusy(false)
    }
  }

  const allowedBatchActions = (): BatchAction[] => {
    const review: BatchAction[] = canReview ? ['approve', 'reject'] : []
    const del: BatchAction[] = canSchedule ? ['delete'] : []
    switch (activeTab) {
      case 'pending': return [...review, 'assign_track', ...del]
      case 'approved': return [...review.filter((a) => a === 'reject'), 'assign_track', ...del]
      case 'scheduled': return ['assign_track', ...del]
      case 'rejected': return [...review.filter((a) => a === 'approve'), ...del]
      default: return [...review, 'assign_track', ...del]
    }
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-16" role="status" aria-label="Loading"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  if (!canReview && !canSchedule) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-4">
          <p className="text-muted-foreground">Proposal review and scheduling are for owners, admins and moderators.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {can('viewAnalytics') && <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/analytics`}>Open analytics</Link></Button>}
            {can('sendCommunications') && <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/communications`}>Open messages</Link></Button>}
          </div>
        </CardContent>
      </Card>
    )
  }

  const testSessionCount = sessions.filter((s) => s.title.startsWith('[TEST]')).length
  const pendingCount = counts.pending
  const unpublished = overview?.schedule.unpublishedChanges ?? 0
  const trackOptions = tracks.map((t) => ({ id: t.id, name: t.name, color: t.color }))
  const actions = allowedBatchActions()

  return (
    <>
      <div className="space-y-8">
        <div className="page-heading organizer-welcome">
          <div>
            <h1 className="text-2xl font-display font-bold">Make space for good ideas.</h1>
            <p className="text-muted-foreground">Your program takes shape here. Review ideas and help them find their place.</p>
          </div>
          {canSchedule && (
            <Button asChild>
              <Link href={`/e/${event.slug}/admin/sessions/new`}>
                <Plus className="h-4 w-4 mr-2" />
                Add a session
              </Link>
            </Button>
          )}
        </div>

        {loadError && (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => { setIsLoading(true); void load() }}>Try again</Button>
          </div>
        )}

        {notice && (
          <div role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('sticky top-20 z-10 rounded-xl border bg-card p-4 text-sm', notice.kind === 'error' ? 'border-destructive/30 text-destructive' : 'border-primary/30')}>
            <p>{notice.text}</p>
            {notice.details && notice.details.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                {notice.details.slice(0, 8).map((d) => <li key={d}>{d}</li>)}
              </ul>
            )}
          </div>
        )}

        {event.status === 'draft' && can('editEventSettings') && (
          <Card className="border-primary/25 bg-secondary">
            <CardContent className="p-6 flex flex-wrap items-center justify-between gap-5">
              <div>
                <h2 className="text-xl font-semibold">Ready to invite your people?</h2>
                <p className="mt-2 text-sm text-muted-foreground max-w-xl">Your event is a draft. Review the invitation, publish it, then open proposals when you&rsquo;re ready to hear from the community.</p>
              </div>
              <Button asChild><Link href={`/e/${event.slug}/admin/settings`}>Review &amp; publish</Link></Button>
            </CardContent>
          </Card>
        )}

        {overview && overview.flagged.length > 0 && (
          <section aria-labelledby="flagged-heading" className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5">
            <h2 id="flagged-heading" className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              {overview.flagged.length} session{overview.flagged.length === 1 ? '' : 's'} changed on the network
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {overview.flagged.map((f) => (
                <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <Link href={`/e/${event.slug}/sessions/${f.id}`} className="font-medium hover:underline">{f.title}</Link>
                    <span className="text-muted-foreground"> — {f.message}</span>
                  </span>
                  {canSchedule && <Link href={`/e/${event.slug}/admin/schedule`} className="text-primary text-xs font-medium">Open schedule builder</Link>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <AdminStats
          pending={counts.pending}
          approved={counts.approved}
          scheduled={counts.scheduled}
          rejected={counts.rejected}
          venues={venues.length}
          timeSlots={timeSlots.filter((t) => !t.is_break).length}
        />

        <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]" aria-label="Next steps">
          <div className="rounded-2xl border border-primary/25 bg-secondary p-6 sm:p-8">
            <div className="flex items-center gap-2 text-primary text-sm font-medium mb-4"><FileText className="h-4 w-4" />Next up</div>
            <h2 className="text-2xl sm:text-3xl font-semibold mb-3 leading-tight">
              {pendingCount > 0 ? `${pendingCount} idea${pendingCount === 1 ? '' : 's'} waiting for a little attention` : 'You’re all caught up on reviews.'}
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mb-5">
              {pendingCount > 0 ? 'Review proposals so your community can discover and support them.' : 'New proposals will appear here. In the meantime, keep shaping your gathering.'}
            </p>
            {pendingCount > 0 ? (
              <Button onClick={() => { setActiveTab('pending'); setFilters(defaultFilters); document.getElementById('session-review')?.scrollIntoView({ block: 'start' }) }}>Review proposals</Button>
            ) : (
              <Button asChild variant="outline"><Link href={`/e/${event.slug}`}>View event page<ArrowUpRight className="h-4 w-4 ml-2" /></Link></Button>
            )}
          </div>
          <div className="rounded-2xl border bg-card p-6 flex flex-col">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-4"><LayoutGrid className="h-4 w-4" />Program progress</div>
            <h2 className="text-xl font-semibold mb-2">{counts.scheduled} session{counts.scheduled === 1 ? '' : 's'} on the schedule</h2>
            <p className="text-sm text-muted-foreground mb-2">{counts.approved} approved and ready to place.</p>
            <p className="text-sm text-muted-foreground mb-4">
              {overview?.schedule.publishedAt
                ? unpublished > 0 ? `${unpublished} change${unpublished === 1 ? '' : 's'} not yet published.` : 'Everything on the schedule is published.'
                : 'The schedule has not been published yet.'}
            </p>
            <div className="h-2 bg-muted rounded-full overflow-hidden mb-5" role="progressbar" aria-label="Approved sessions scheduled" aria-valuemin={0} aria-valuemax={counts.approved + counts.scheduled || 1} aria-valuenow={counts.scheduled}>
              <div className="h-full bg-primary rounded-full" style={{ width: `${(counts.scheduled / (counts.approved + counts.scheduled || 1)) * 100}%` }} />
            </div>
            {overview?.voting.status === 'open' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4"><Lock className="h-3.5 w-3.5" />Voting in progress — results are sealed until the round closes.</p>
            )}
            {canSchedule && <Link href={`/e/${event.slug}/admin/schedule`} className="mt-auto inline-flex gap-2 items-center text-sm font-semibold text-primary">Open schedule builder<ArrowUpRight className="h-4 w-4" /></Link>}
          </div>
        </section>

        {process.env.NODE_ENV === 'development' && canSchedule && (
          <details className="rounded-xl border p-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Development tools</summary>
            <Card className="mt-4 bg-amber-500/5 border-amber-500/20">
              <CardContent className="py-4 space-y-3">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <p className="font-medium flex items-center gap-2"><Beaker className="h-4 w-4 text-amber-600" aria-hidden />Test data</p>
                    <p className="text-sm text-muted-foreground">
                      Host-less test sessions for trying the auto-scheduler
                      {testSessionCount > 0 && <span className="ml-1 text-amber-600">({testSessionCount} exist)</span>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDevConfirm('seed')} disabled={busy}><Beaker className="h-4 w-4 mr-1" />Generate test sessions</Button>
                    {testSessionCount > 0 && (
                      <Button variant="outline" size="sm" onClick={() => setDevConfirm('clear')} disabled={busy} className="text-destructive hover:text-destructive"><Trash2 className="h-4 w-4 mr-1" />Clear test data</Button>
                    )}
                  </div>
                </div>
                {devConfirm && (
                  <div role="alertdialog" aria-label="Confirm test data change" className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3">
                    <span>{devConfirm === 'seed' ? 'Create about 28 sessions prefixed with [TEST]?' : 'Delete every [TEST] session that is not published?'}</span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setDevConfirm(null)}>Cancel</Button>
                      <Button size="sm" variant={devConfirm === 'clear' ? 'destructive' : 'default'} onClick={() => devTools(devConfirm)}>Confirm</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </details>
        )}

        <div id="session-review" className="scroll-mt-24 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex gap-1 sm:gap-2 border-b overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:border-b-0" role="tablist" aria-label="Session status">
            {(['all', 'pending', 'approved', 'scheduled', 'rejected'] as const).map((tab) => {
              const count = tab === 'all' ? sessions.length : counts[tab]
              return (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={activeTab === tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'px-3 sm:px-4 py-2 text-sm font-medium border-b-2 sm:border-b-0 sm:rounded-md -mb-px sm:mb-0 transition-colors whitespace-nowrap capitalize',
                    activeTab === tab ? 'border-primary text-primary sm:bg-primary/10' : 'border-transparent text-muted-foreground hover:text-foreground sm:hover:bg-muted',
                  )}
                >
                  {tab} ({count})
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex border rounded-md">
              <Button variant={viewMode === 'table' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('table')} aria-label="Table view" aria-pressed={viewMode === 'table'} className="rounded-r-none"><Table className="h-4 w-4" /></Button>
              <Button variant={viewMode === 'cards' ? 'secondary' : 'ghost'} size="sm" onClick={() => setViewMode('cards')} aria-label="Card view" aria-pressed={viewMode === 'cards'} className="rounded-l-none"><Grid3X3 className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>

        {data?.voting.status === 'open' && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" />Vote counts are sealed while voting is open, for organizers too. Sort by title, length or date until the round closes.</p>
        )}

        <SessionFilters
          filters={filters}
          onFiltersChange={setFilters}
          tracks={trackOptions}
          formats={formats}
          totalCount={activeTab === 'all' ? sessions.length : counts[activeTab]}
          filteredCount={filteredSessions.length}
        />

        {activeTab === 'scheduled' && sessions.some((s) => s.status === 'scheduled' && s.host_id && !s.host_notified_at) && can('sendCommunications') && (
          <div className="flex flex-wrap gap-3 items-center justify-between bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
            <p className="text-sm text-amber-700 dark:text-amber-400">Some hosts have not been emailed about their slot yet. Hosts are emailed once their slot is on the published schedule.</p>
            <Button size="sm" asChild><Link href={`/e/${event.slug}/admin/communications`}><Mail className="h-4 w-4 mr-1" />Email hosts</Link></Button>
          </div>
        )}

        {filteredSessions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              {JSON.stringify(filters) !== JSON.stringify(defaultFilters) ? 'No sessions match your filters.' : `No ${activeTab === 'all' ? '' : activeTab} sessions yet.`}
              <div className="mt-4"><Button variant="outline" onClick={() => { setFilters(defaultFilters); setActiveTab('all') }}>Show all sessions</Button></div>
            </CardContent>
          </Card>
        ) : viewMode === 'table' ? (
          <SessionTable
            sessions={filteredSessions}
            results={votesSortable ? results : null}
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
                timezone={event.timezone}
                venues={venues}
                timeSlots={timeSlots}
                result={votesSortable ? results?.[session.id] ?? null : null}
                busy={busy}
                onApprove={canReview && session.status === 'pending' ? () => runBatch('approve', [session.id]) : undefined}
                onReject={canReview && session.status === 'pending' ? () => runBatch('reject', [session.id]) : undefined}
                onSchedule={canSchedule && session.status === 'approved' ? (slotId) => schedule(session.id, slotId) : undefined}
                onUnschedule={canSchedule && session.status === 'scheduled' ? () => unschedule(session.id) : undefined}
                onDelete={canSchedule ? () => runBatch('delete', [session.id]) : undefined}
                onNotify={can('sendCommunications') && session.status === 'scheduled' ? () => notifyHost(session.id) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <BatchActions
        selectedCount={selectedIds.size}
        tracks={trackOptions}
        onApprove={actions.includes('approve') ? () => runBatch('approve', Array.from(selectedIds)) : undefined}
        onReject={actions.includes('reject') ? (reason) => runBatch('reject', Array.from(selectedIds), { reason }) : undefined}
        onAssignTrack={actions.includes('assign_track') ? (trackId) => runBatch('assign_track', Array.from(selectedIds), { track_id: trackId || null }) : undefined}
        onDelete={actions.includes('delete') ? () => runBatch('delete', Array.from(selectedIds)) : undefined}
        onClearSelection={() => setSelectedIds(new Set())}
        isLoading={busy}
        allowedActions={actions}
      />
    </>
  )
}
