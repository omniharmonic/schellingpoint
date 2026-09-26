'use client'

import * as React from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, Beaker, CheckCircle2, FileText, Grid3X3, LayoutGrid, Loader2, Lock, Mail, Plus, Table, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { SESSION_STATUS } from '@/lib/labels'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { PhaseOverview } from '@/components/admin/PhaseOverview'
import { AdminStats } from '@/components/admin/AdminStats'
import { SessionCard } from '@/components/admin/SessionCard'
import { SessionTable, type SortDirection, type SortField } from '@/components/admin/SessionTable'
import { SessionFilters, defaultFilters } from '@/components/admin/SessionFilters'
import { BatchActions } from '@/components/admin/BatchActions'
import { hostLabel, type AdminSession, type AdminSessionsResponse, type AdminTimeSlot, type AdminTrack, type AdminVenue } from '@/components/admin/types'

type Tab = 'all' | 'pending' | 'approved' | 'scheduled' | 'rejected'
type ViewMode = 'table' | 'cards'
type BatchAction = 'approve' | 'reject' | 'assign_track' | 'delete'

const TABS: Tab[] = ['all', 'pending', 'approved', 'scheduled', 'rejected']
const TAB_LABEL: Record<Tab, string> = {
  all: 'All',
  pending: SESSION_STATUS.pending.label,
  approved: SESSION_STATUS.approved.label,
  scheduled: SESSION_STATUS.scheduled.label,
  rejected: SESSION_STATUS.rejected.label,
}
const TAB_EMPTY: Record<Tab, string> = {
  all: 'No sessions yet.',
  pending: 'Nothing is awaiting review.',
  approved: 'No approved sessions yet.',
  scheduled: 'Nothing is on the schedule yet.',
  rejected: 'No sessions have been set aside.',
}

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
  const { can, isAdmin } = useEventRole()
  const { toast } = useToast()
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
  /** Inline notice: errors, and successes that carry details (skipped rows). Plain successes go to a toast. */
  const [notice, setNotice] = React.useState<{ kind: 'success' | 'error'; text: string; details?: string[] } | null>(null)
  const [devConfirm, setDevConfirm] = React.useState<'seed' | 'clear' | null>(null)
  const [justCreated, setJustCreated] = React.useState(false)
  const tablistRef = React.useRef<HTMLDivElement>(null)

  // The create wizard lands here with ?created=1.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (url.searchParams.get('created') === '1') {
      setJustCreated(true)
      url.searchParams.delete('created')
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
    }
  }, [])

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
      setLoadError(errorText(e, 'The organizer workspace could not be loaded. Try again.'))
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

  const succeed = (text: string, details?: string[]) => {
    if (details && details.length > 0) setNotice({ kind: 'success', text, details })
    else {
      setNotice(null)
      toast({ title: text, variant: 'success' })
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
      const details = res.skipped.map((s) => `${s.title}: ${s.reason}`)
      if (res.skipped.length && !res.affected) setNotice({ kind: 'error', text: res.message, details })
      else succeed(res.message, details)
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
      succeed('Scheduled; the host was notified. Publish the schedule to update the public calendar.')
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
      succeed('Removed from the draft schedule.')
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
      succeed(res.delivered === false ? 'Mail is not configured here; the email was logged instead.' : 'Host emailed.')
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
      succeed(res.message)
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'Test data could not be changed.') })
    } finally {
      setBusy(false)
    }
  }

  const reviewProposals = () => {
    setActiveTab('pending')
    setFilters(defaultFilters)
    document.getElementById('session-review')?.scrollIntoView({ block: 'start' })
    window.requestAnimationFrame(() => tablistRef.current?.querySelector<HTMLElement>('[data-tab="pending"]')?.focus())
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
      <>
        <PageHeader title="Overview & sessions" />
        <Card>
          <CardContent className="py-10 text-center space-y-4">
            <p className="text-muted-foreground">Proposal review and scheduling are for owners, admins and moderators.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {can('viewAnalytics') && <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/analytics`}>Open analytics</Link></Button>}
              {can('sendCommunications') && <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/communications`}>Announcements & emails</Link></Button>}
              {can('checkInAttendees') && <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/checkin`}>Check-in</Link></Button>}
            </div>
          </CardContent>
        </Card>
      </>
    )
  }

  const testSessionCount = sessions.filter((s) => s.title.startsWith('[TEST]')).length
  const pendingCount = counts.pending
  const unpublished = overview?.schedule.unpublishedChanges ?? 0
  const trackOptions = tracks.map((t) => ({ id: t.id, name: t.name, color: t.color }))
  const actions = allowedBatchActions()
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(defaultFilters)

  return (
    <>
      <div className="space-y-8">
        <PageHeader
          title="Overview & sessions"
          subtitle="Make space for good ideas. Review proposals and help them find their place."
          actions={canSchedule && (
            <Button asChild>
              <Link href={`/e/${event.slug}/admin/sessions/new`}>
                <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                Add a session
              </Link>
            </Button>
          )}
        />

        {isAdmin && <PhaseOverview />}

        {justCreated && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Your gathering is ready</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>Next: add rooms and times so sessions have somewhere to go.</span>
              <span className="flex gap-2">
                <Button asChild size="sm"><Link href={`/e/${event.slug}/admin/setup`}>Add rooms and times</Link></Button>
                <Button size="sm" variant="ghost" onClick={() => setJustCreated(false)}>Dismiss</Button>
              </span>
            </AlertDescription>
          </Alert>
        )}

        {loadError && (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => { setIsLoading(true); void load() }}>Try again</Button>
          </div>
        )}

        {notice && (
          <Alert variant={notice.kind === 'error' ? 'destructive' : 'success'}>
            {notice.kind === 'error' ? <AlertTriangle className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
            <AlertDescription>
              <p>{notice.text}</p>
              {notice.details && notice.details.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                  {notice.details.slice(0, 8).map((d) => <li key={d}>{d}</li>)}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}

        {event.status === 'draft' && (
          <section aria-labelledby="setup-title" className="overflow-hidden rounded-2xl border border-primary/25 bg-card">
            <div className="p-6 sm:p-8 bg-secondary/50">
              <h2 id="setup-title" className="text-2xl font-display font-semibold tracking-tight">Give your gathering a good start.</h2>
              <p className="mt-2 text-sm text-muted-foreground max-w-xl">Your draft is private. Set the essentials, preview the invitation, then publish when you’re ready.</p>
            </div>
            <div className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-y-0 sm:divide-x">
              {[{ href: 'settings', title: 'Gathering details', detail: 'Dates, location and the invitation.' },
                { href: 'setup', title: 'Rooms & time slots', detail: `${plural(venues.length, 'room')} and ${plural(timeSlots.filter(slot => !slot.is_break).length, 'session slot')} ready.` },
                { href: event.ticketingEnabled ? 'tickets' : 'settings', title: 'Admission & publishing', detail: event.ticketingEnabled ? 'Set up ticket types and connect payouts.' : 'Review participation and publish your gathering.' }].map(item => (
                <Link key={item.title} href={`/e/${event.slug}/admin/${item.href}`} className="group p-5 hover:bg-muted/40 focus-visible:outline-primary">
                  <span className="flex items-center justify-between gap-3 font-semibold">{item.title}<ArrowUpRight className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="mt-2 block text-sm text-muted-foreground">{item.detail}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {overview && overview.flagged.length > 0 && (
          <section aria-labelledby="flagged-heading" className="rounded-2xl border border-signal-amber/40 bg-signal-amber/5 p-5">
            <h2 id="flagged-heading" className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-5 w-5 text-signal-amber" aria-hidden="true" />
              {plural(overview.flagged.length, 'session')} changed on the network
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {overview.flagged.map((f) => (
                <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <Link href={`/e/${event.slug}/sessions/${f.id}`} className="font-medium hover:underline">{f.title}</Link>
                    <span className="text-muted-foreground"> — {f.message}</span>
                  </span>
                </li>
              ))}
            </ul>
            {canSchedule && (
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={`/e/${event.slug}/admin/schedule`}>Open schedule builder</Link>
              </Button>
            )}
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

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.35fr_1fr]" aria-label="Next steps">
          <div className="rounded-2xl border border-primary/25 bg-secondary p-6 sm:p-8">
            <div className="flex items-center gap-2 text-primary text-sm font-medium mb-4"><FileText className="h-4 w-4" aria-hidden="true" />Next up</div>
            <h2 className="text-2xl sm:text-3xl font-display font-semibold tracking-tight mb-3 leading-tight text-balance">
              {pendingCount > 0 ? `${plural(pendingCount, 'idea')} waiting for a little attention` : 'You’re all caught up on reviews.'}
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mb-5">
              {pendingCount > 0 ? 'Review proposals so your community can discover and support them.' : 'New proposals will appear here. In the meantime, keep shaping your gathering.'}
            </p>
            {pendingCount > 0 ? (
              <Button onClick={reviewProposals}>Review proposals</Button>
            ) : (
              <Button asChild variant="outline"><Link href={`/e/${event.slug}`}>Gathering page<ArrowUpRight className="h-4 w-4 ml-2" aria-hidden="true" /></Link></Button>
            )}
          </div>
          <div className="rounded-2xl border bg-card p-6 flex flex-col">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-4"><LayoutGrid className="h-4 w-4" aria-hidden="true" />Program progress</div>
            <h2 className="text-xl font-semibold mb-2">{plural(counts.scheduled, 'session')} on the schedule</h2>
            <p className="text-sm text-muted-foreground mb-2">{counts.approved} approved and ready to place.</p>
            <p className="text-sm text-muted-foreground mb-4">
              {overview?.schedule.publishedAt
                ? unpublished > 0 ? `${plural(unpublished, 'change')} not yet published.` : 'Everything on the schedule is published.'
                : 'The schedule has not been published yet.'}
            </p>
            <div className="h-2 bg-muted rounded-full overflow-hidden mb-5" role="progressbar" aria-label="Approved sessions scheduled" aria-valuemin={0} aria-valuemax={counts.approved + counts.scheduled || 1} aria-valuenow={counts.scheduled}>
              <div className="h-full bg-primary rounded-full" style={{ width: `${(counts.scheduled / (counts.approved + counts.scheduled || 1)) * 100}%` }} />
            </div>
            {overview?.voting.status === 'open' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4"><Lock className="h-3.5 w-3.5" aria-hidden="true" />Voting in progress — results are sealed until the round closes.</p>
            )}
            {canSchedule && (
              <Button asChild variant="outline" size="sm" className="mt-auto self-start">
                <Link href={`/e/${event.slug}/admin/schedule`}>Open schedule builder<ArrowUpRight className="h-4 w-4 ml-2" aria-hidden="true" /></Link>
              </Button>
            )}
          </div>
        </section>

        {process.env.NODE_ENV === 'development' && canSchedule && (
          <details className="rounded-xl border p-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Development tools</summary>
            <Card className="mt-4 bg-signal-amber/5 border-signal-amber/20">
              <CardContent className="py-4 space-y-3">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <p className="font-medium flex items-center gap-2"><Beaker className="h-4 w-4 text-signal-amber" aria-hidden="true" />Test data</p>
                    <p className="text-sm text-muted-foreground">
                      Host-less test sessions for trying the auto-scheduler
                      {testSessionCount > 0 && <span className="ml-1 text-signal-amber">({testSessionCount} exist)</span>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDevConfirm('seed')} disabled={busy}><Beaker className="h-4 w-4 mr-1" aria-hidden="true" />Generate test sessions</Button>
                    {testSessionCount > 0 && (
                      <Button variant="outline" size="sm" onClick={() => setDevConfirm('clear')} disabled={busy} className="text-destructive hover:text-destructive"><Trash2 className="h-4 w-4 mr-1" aria-hidden="true" />Clear test data</Button>
                    )}
                  </div>
                </div>
                {devConfirm && (
                  <ConfirmInline
                    layout="inline"
                    destructive={devConfirm === 'clear'}
                    message={devConfirm === 'seed' ? 'Create about 28 sessions prefixed with [TEST]?' : 'Delete every [TEST] session that is not published?'}
                    confirmLabel={devConfirm === 'seed' ? 'Generate' : 'Delete'}
                    loading={busy}
                    onConfirm={() => void devTools(devConfirm)}
                    onCancel={() => setDevConfirm(null)}
                  />
                )}
              </CardContent>
            </Card>
          </details>
        )}

        <div id="session-review" className="scroll-mt-24 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div ref={tablistRef} className="flex gap-1 sm:gap-2 border-b overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:border-b-0" role="tablist" aria-label="Session status">
            {TABS.map((tab) => {
              const count = tab === 'all' ? sessions.length : counts[tab]
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  data-tab={tab}
                  aria-selected={activeTab === tab}
                  tabIndex={activeTab === tab ? 0 : -1}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'min-h-10 px-3 sm:px-4 py-2 text-sm font-medium border-b-2 sm:border-b-0 sm:rounded-lg -mb-px sm:mb-0 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeTab === tab ? 'border-primary text-primary sm:bg-primary/10' : 'border-transparent text-muted-foreground hover:text-foreground sm:hover:bg-muted',
                  )}
                >
                  {TAB_LABEL[tab]} <span className="tabular-nums">({count})</span>
                </button>
              )
            })}
          </div>
          <SegmentedControl<ViewMode>
            aria-label="View"
            size="sm"
            value={viewMode}
            onValueChange={setViewMode}
            options={[
              { value: 'table', label: <span className="sr-only sm:not-sr-only">Table</span>, icon: <Table className="h-4 w-4" aria-hidden="true" /> },
              { value: 'cards', label: <span className="sr-only sm:not-sr-only">Cards</span>, icon: <Grid3X3 className="h-4 w-4" aria-hidden="true" /> },
            ]}
          />
        </div>

        {data?.voting.status === 'open' && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" aria-hidden="true" />Vote counts are sealed while voting is open, for organizers too. Sort by title, length or date until the round closes.</p>
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
          <Alert variant="warning" className="flex flex-wrap items-center justify-between gap-3 [&>svg~*]:pl-0">
            <AlertDescription className="pl-7">Some hosts have not been emailed about their slot yet. Hosts are emailed once their slot is on the published schedule.</AlertDescription>
            <Mail className="h-4 w-4" aria-hidden="true" />
            <Button size="sm" asChild><Link href={`/e/${event.slug}/admin/communications`}>Email hosts</Link></Button>
          </Alert>
        )}

        {filteredSessions.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              {sessions.length === 0 ? (
                <>
                  <p>No sessions yet. Add one yourself, or invite people to propose their own.</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {canSchedule && (
                      <Button asChild><Link href={`/e/${event.slug}/admin/sessions/new`}><Plus className="h-4 w-4 mr-2" aria-hidden="true" />Add a session</Link></Button>
                    )}
                    {isAdmin && (
                      <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/members`}><UserPlus className="h-4 w-4 mr-2" aria-hidden="true" />Invite people</Link></Button>
                    )}
                  </div>
                </>
              ) : filtersActive ? (
                <>
                  <p>No sessions match your filters.</p>
                  <div className="mt-4"><Button variant="outline" onClick={() => setFilters(defaultFilters)}>Clear filters</Button></div>
                </>
              ) : (
                <>
                  <p>{TAB_EMPTY[activeTab]}</p>
                  {activeTab !== 'all' && <div className="mt-4"><Button variant="outline" onClick={() => setActiveTab('all')}>Show all sessions</Button></div>}
                </>
              )}
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
