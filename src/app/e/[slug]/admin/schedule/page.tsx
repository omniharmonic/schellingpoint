'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  FileText,
  Globe,
  GripVertical,
  Hourglass,
  Loader2,
  Lock,
  PanelLeft,
  PanelLeftClose,
  Redo2,
  RotateCcw,
  Send,
  ShieldCheck,
  Undo2,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { getEventDayLabel, getEventDays } from '@/lib/events/dates'
import { formatInEventTimezone } from '@/lib/events/timezone'
import { cn } from '@/lib/utils'
import { PublishJobProgress } from '@/components/PublishJobProgress'
import { hostLabel, type AdminSession, type AdminSessionsResponse, type AdminTimeSlot, type AdminVenue } from '@/components/admin/types'

interface ApprovalRequest {
  id: string
  action: 'move' | 'cancel' | 'remove-listing'
  status: 'pending' | 'applying' | 'applied' | 'withdrawn' | 'failed'
  reason: string
  threshold: number
  sessionId: string | null
  sessionTitle: string | null
  target: { timeSlotId?: string; venueId?: string | null; startsAt?: string | null; endsAt?: string | null }
  requestedBy: { accountId: string; handle: string | null } | null
  approvals: Array<{ accountId: string; handle: string | null; createdAt: string }>
  error: string | null
  createdAt: string
}

interface PublishStatus {
  schedulePublishedAt: string | null
  hasUnpublishedChanges: boolean
  scheduledSessions: number
  networkPublishedSessions: number
  networkLinked: boolean
  changes: { added: { id: string; title: string }[]; moved: { id: string; title: string }[]; removed: { id: string; title: string }[] }
}

interface PublishResponse {
  message: string
  changes: { added: number; moved: number; removed: number }
  notified: { members: number }
  network: { attempted: false } | { attempted: true; published: number; failed: number; results: Array<{ kind: string; id: string; uri?: string; error?: string }>; error?: string; queued?: boolean; jobId?: string; total?: number }
}

interface AutoScheduleResult {
  assignments: Array<{ sessionId: string; sessionTitle: string; slotId: string; venueId: string; score: number; warnings: string[] }>
  unassigned: Array<{ sessionId: string; sessionTitle: string; reason: string }>
  stats: { totalSessions: number; assigned: number; unassigned: number; averageScore: number; usedBallots: boolean }
}

interface ScheduleResponse {
  status: 'applied' | 'awaiting_approval'
  approvalsNeeded?: number
  threshold?: number
  approvals?: number
  displaced?: { id: string; title: string } | null
}

/** Only direct (unpublished) placements can be undone. */
interface HistoryAction {
  sessionId: string
  fromSlotId: string | null
  toSlotId: string | null
}

type Destructive =
  | { kind: 'move'; session: AdminSession; slotId: string }
  | { kind: 'cancel'; session: AdminSession }

type Notice = { kind: 'success' | 'error' | 'info'; text: string; details?: string[] }

const PREF_LABELS: Record<string, string> = {
  monday_am: 'Mon AM', monday_pm: 'Mon PM', tuesday_am: 'Tue AM', tuesday_pm: 'Tue PM',
  wednesday_am: 'Wed AM', wednesday_pm: 'Wed PM', thursday_am: 'Thu AM', thursday_pm: 'Thu PM',
  friday_am: 'Fri AM', friday_pm: 'Fri PM', saturday_am: 'Sat AM', saturday_pm: 'Sat PM',
  sunday_am: 'Sun AM', sunday_pm: 'Sun PM',
}
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const slotMinutes = (slot: Pick<AdminTimeSlot, 'start_time' | 'end_time'>) =>
  Math.round((Date.parse(slot.end_time) - Date.parse(slot.start_time)) / 60_000)

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export default function AdminSchedulePage() {
  const event = useEvent()
  const { can } = useEventRole()
  const canSchedule = can('manageSchedule')
  const base = `/api/v1/events/${event.slug}`

  const eventDays = React.useMemo(() => getEventDays(event.startDate, event.endDate), [event.startDate, event.endDate])
  const [selectedDay, setSelectedDay] = React.useState(eventDays[0] || '')
  const [venues, setVenues] = React.useState<AdminVenue[]>([])
  const [timeSlots, setTimeSlots] = React.useState<AdminTimeSlot[]>([])
  const [sessions, setSessions] = React.useState<AdminSession[]>([])
  const [votingStatus, setVotingStatus] = React.useState<string>('none')
  const [approvals, setApprovals] = React.useState<ApprovalRequest[]>([])
  const [approvalsError, setApprovalsError] = React.useState<string | null>(null)
  const [viewerAccountId, setViewerAccountId] = React.useState<string | null>(null)
  const [publishStatus, setPublishStatus] = React.useState<PublishStatus | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice | null>(null)

  const [showSidebar, setShowSidebar] = React.useState(true)
  const [dragged, setDragged] = React.useState<AdminSession | null>(null)
  const [picked, setPicked] = React.useState<AdminSession | null>(null)
  const [conflict, setConflict] = React.useState<{ session: AdminSession; slotId: string; occupant: string } | null>(null)
  const [destructive, setDestructive] = React.useState<Destructive | null>(null)
  const [reason, setReason] = React.useState('')
  const [confirmLinkage, setConfirmLinkage] = React.useState(false)
  const [needsLinkage, setNeedsLinkage] = React.useState(false)
  const [confirmReset, setConfirmReset] = React.useState(false)
  const [history, setHistory] = React.useState<HistoryAction[]>([])
  const [historyIndex, setHistoryIndex] = React.useState(-1)

  const [autoOpen, setAutoOpen] = React.useState(false)
  const [autoLoading, setAutoLoading] = React.useState(false)
  const [autoResult, setAutoResult] = React.useState<AutoScheduleResult | null>(null)
  const [selectedAssignments, setSelectedAssignments] = React.useState<Set<string>>(new Set())

  const [publishOpen, setPublishOpen] = React.useState(false)
  const [publishing, setPublishing] = React.useState(false)
  const [publishResult, setPublishResult] = React.useState<PublishResponse | null>(null)

  React.useEffect(() => {
    if (notice?.kind !== 'success') return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  React.useEffect(() => {
    if (eventDays.length > 0 && !eventDays.includes(selectedDay)) setSelectedDay(eventDays[0])
  }, [eventDays, selectedDay])

  const loadApprovals = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ requests: ApprovalRequest[]; viewerAccountId: string }>(`${base}/approvals`)
      setApprovals(res.requests)
      setViewerAccountId(res.viewerAccountId)
      setApprovalsError(null)
    } catch (e) {
      setApprovalsError(errorText(e, 'Approval requests could not be loaded.'))
    }
  }, [base])

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const [v, t, s, p] = await Promise.all([
        apiFetch<{ venues: AdminVenue[] }>(`${base}/admin/venues`),
        apiFetch<{ timeSlots: AdminTimeSlot[] }>(`${base}/admin/time-slots`),
        apiFetch<AdminSessionsResponse>(`${base}/admin/sessions`),
        apiFetch<PublishStatus>(`${base}/admin/publish-schedule`),
      ])
      setVenues(v.venues)
      setTimeSlots(t.timeSlots)
      setSessions(s.sessions)
      setVotingStatus(s.voting.status)
      setPublishStatus(p)
    } catch (e) {
      setLoadError(errorText(e, 'The schedule could not be loaded. Try again.'))
    } finally {
      setIsLoading(false)
    }
    void loadApprovals()
  }, [base, loadApprovals])

  React.useEffect(() => { void load() }, [load])

  const sessionBySlot = React.useMemo(() => {
    const map = new Map<string, AdminSession>()
    for (const s of sessions) if (s.time_slot_id && s.status === 'scheduled') map.set(s.time_slot_id, s)
    return map
  }, [sessions])

  const openRequestBySession = React.useMemo(() => {
    const map = new Map<string, ApprovalRequest>()
    for (const r of approvals) if (r.sessionId && (r.status === 'pending' || r.status === 'applying')) map.set(r.sessionId, r)
    return map
  }, [approvals])

  const unscheduled = sessions.filter((s) => s.status === 'approved' && !s.time_slot_id)
  const pendingRequests = approvals.filter((r) => r.status === 'pending' || r.status === 'applying' || r.status === 'failed')

  const formatTime = (iso: string) => formatInEventTimezone(new Date(iso), event.timezone, 'time')

  const timeRows = React.useMemo(() => {
    const rows = new Map<string, { start: string; end: string }>()
    for (const slot of timeSlots) {
      if (slot.day_date !== selectedDay) continue
      rows.set(`${slot.start_time}|${slot.end_time}`, { start: slot.start_time, end: slot.end_time })
    }
    return [...rows.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  }, [timeSlots, selectedDay])

  const dayPrefs = React.useMemo(() => {
    if (!selectedDay) return [] as string[]
    const name = DAY_NAMES[new Date(`${selectedDay}T12:00:00Z`).getUTCDay()]
    return [`${name}_am`, `${name}_pm`]
  }, [selectedDay])

  const refreshAfterChange = async () => {
    const [s, p] = await Promise.all([
      apiFetch<AdminSessionsResponse>(`${base}/admin/sessions`),
      apiFetch<PublishStatus>(`${base}/admin/publish-schedule`),
    ])
    setSessions(s.sessions)
    setPublishStatus(p)
    const t = await apiFetch<{ timeSlots: AdminTimeSlot[] }>(`${base}/admin/time-slots`)
    setTimeSlots(t.timeSlots)
    void loadApprovals()
  }

  const recordHistory = (action: HistoryAction) => {
    const next = history.slice(0, historyIndex + 1)
    next.push(action)
    setHistory(next)
    setHistoryIndex(next.length - 1)
  }

  /** Direct placement or removal of an unpublished session; returns false on failure. */
  const place = async (sessionId: string, slotId: string | null, opts: { replace?: boolean } = {}): Promise<ScheduleResponse | null> => {
    const url = `${base}/admin/sessions/${sessionId}/schedule`
    return slotId
      ? apiFetch<ScheduleResponse>(url, { method: 'PUT', json: { time_slot_id: slotId, replace: opts.replace === true } })
      : apiFetch<ScheduleResponse>(url, { method: 'DELETE' })
  }

  const dropOnSlot = async (session: AdminSession, slotId: string, replace = false) => {
    setDragged(null)
    setPicked(null)
    const occupant = sessionBySlot.get(slotId)
    if (occupant && occupant.id !== session.id && !replace) {
      if (occupant.network_published) {
        setNotice({ kind: 'error', text: `"${occupant.title}" is published in that slot. Move or cancel it first.` })
        return
      }
      setConflict({ session, slotId, occupant: occupant.title })
      return
    }
    if (session.network_published && session.time_slot_id) {
      setReason('')
      setNeedsLinkage(false)
      setConfirmLinkage(false)
      setDestructive({ kind: 'move', session, slotId })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const res = await place(session.id, slotId, { replace })
      recordHistory({ sessionId: session.id, fromSlotId: session.time_slot_id, toSlotId: slotId })
      setNotice({
        kind: 'success',
        text: `Placed "${session.title}"${session.host_id ? '; its host was notified' : ''}.${res?.displaced ? ` "${res.displaced.title}" went back to the tray.` : ''} Publish to update the public schedule.`,
      })
      await refreshAfterChange()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The session could not be placed.') })
      await refreshAfterChange().catch(() => undefined)
    } finally {
      setBusy(false)
      setConflict(null)
    }
  }

  const removeFromSlot = async (session: AdminSession) => {
    if (session.network_published) {
      setReason('')
      setNeedsLinkage(false)
      setConfirmLinkage(false)
      setDestructive({ kind: 'cancel', session })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      await place(session.id, null)
      recordHistory({ sessionId: session.id, fromSlotId: session.time_slot_id, toSlotId: null })
      setNotice({ kind: 'success', text: `"${session.title}" went back to the tray.` })
      await refreshAfterChange()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The session could not be removed.') })
    } finally {
      setBusy(false)
    }
  }

  const submitDestructive = async () => {
    if (!destructive) return
    if (!reason.trim()) {
      setNotice({ kind: 'error', text: 'Give a reason; the other organizers see it when they approve.' })
      return
    }
    setBusy(true)
    setNotice(null)
    const { session } = destructive
    try {
      const url = `${base}/admin/sessions/${session.id}/schedule`
      const payload = { reason: reason.trim(), ...(confirmLinkage ? { confirmPublicLinkage: true } : {}) }
      const res = destructive.kind === 'move'
        ? await apiFetch<ScheduleResponse>(url, { method: 'PUT', json: { time_slot_id: destructive.slotId, ...payload } })
        : await apiFetch<ScheduleResponse>(url, { method: 'DELETE', json: payload })
      setDestructive(null)
      if (res.status === 'awaiting_approval') {
        const needed = res.approvalsNeeded ?? 1
        setNotice({
          kind: 'info',
          text: `Awaiting approval: "${session.title}" ${destructive.kind === 'move' ? 'will move' : 'will be cancelled'} once ${needed} more organizer${needed === 1 ? '' : 's'} approve${needed === 1 ? 's' : ''}. Your approval is recorded.`,
        })
      } else {
        setNotice({ kind: 'success', text: destructive.kind === 'move' ? `"${session.title}" moved and the network calendar was updated.` : `"${session.title}" is cancelled on the network calendar. The proposal stays with its author.` })
      }
      await refreshAfterChange()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_public_linkage') {
        setNeedsLinkage(true)
        setNotice({ kind: 'error', text: e.message })
      } else {
        setNotice({ kind: 'error', text: errorText(e, 'The request could not be sent.') })
      }
    } finally {
      setBusy(false)
    }
  }

  const approveRequest = async (request: ApprovalRequest) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = await apiFetch<{ status: 'applied' | 'awaiting_approval'; approvalsNeeded: number }>(`${base}/approvals`, {
        method: 'POST',
        json: { action: 'approve', requestId: request.id, ...(confirmLinkage ? { confirmPublicLinkage: true } : {}) },
      })
      setNotice(res.status === 'applied'
        ? { kind: 'success', text: `Approved and applied: ${request.action === 'move' ? 'moved' : 'cancelled'} "${request.sessionTitle ?? 'session'}".` }
        : { kind: 'info', text: `Approval recorded. ${res.approvalsNeeded} more needed.` })
      await refreshAfterChange()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_public_linkage') setNeedsLinkage(true)
      setNotice({ kind: 'error', text: errorText(e, 'Your approval could not be recorded.') })
      void loadApprovals()
    } finally {
      setBusy(false)
    }
  }

  const undo = React.useCallback(async () => {
    if (historyIndex < 0 || busy) return
    const action = history[historyIndex]
    setBusy(true)
    try {
      await place(action.sessionId, action.fromSlotId)
      setHistoryIndex(historyIndex - 1)
      await refreshAfterChange()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'That change could not be undone.') })
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, historyIndex, busy])

  const redo = React.useCallback(async () => {
    if (historyIndex >= history.length - 1 || busy) return
    const action = history[historyIndex + 1]
    setBusy(true)
    try {
      await place(action.sessionId, action.toSlotId)
      setHistoryIndex(historyIndex + 1)
      await refreshAfterChange()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'That change could not be redone.') })
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, historyIndex, busy])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) void redo()
        else void undo()
      }
      if (e.key === 'Escape') setPicked(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const resetDay = async () => {
    setConfirmReset(false)
    const daySlotIds = new Set(timeSlots.filter((t) => t.day_date === selectedDay).map((t) => t.id))
    const targets = sessions.filter((s) => s.time_slot_id && daySlotIds.has(s.time_slot_id) && !s.network_published)
    const kept = sessions.filter((s) => s.time_slot_id && daySlotIds.has(s.time_slot_id) && s.network_published).length
    setBusy(true)
    const failures: string[] = []
    for (const s of targets) {
      try {
        await place(s.id, null)
      } catch (e) {
        failures.push(`${s.title}: ${errorText(e, 'failed')}`)
      }
    }
    setHistory([])
    setHistoryIndex(-1)
    setNotice({
      kind: failures.length ? 'error' : 'success',
      text: `Cleared ${targets.length - failures.length} draft placement${targets.length - failures.length === 1 ? '' : 's'}${kept ? `; ${kept} published session${kept === 1 ? '' : 's'} kept (move or cancel them individually)` : ''}.`,
      details: failures,
    })
    await refreshAfterChange().catch(() => undefined)
    setBusy(false)
  }

  const previewAutoSchedule = async () => {
    setAutoOpen(true)
    setAutoLoading(true)
    setAutoResult(null)
    setNotice(null)
    try {
      const result = await apiFetch<AutoScheduleResult>(`${base}/admin/auto-schedule`)
      setAutoResult(result)
      setSelectedAssignments(new Set(result.assignments.map((a) => a.sessionId)))
    } catch (e) {
      setAutoOpen(false)
      setNotice({ kind: e instanceof ApiError && e.code === 'RoundOpen' ? 'info' : 'error', text: errorText(e, 'The auto-schedule could not be generated.') })
    } finally {
      setAutoLoading(false)
    }
  }

  const applyAutoSchedule = async () => {
    if (!autoResult) return
    const chosen = autoResult.assignments.filter((a) => selectedAssignments.has(a.sessionId))
    if (chosen.length === 0) return
    setAutoLoading(true)
    try {
      const res = await apiFetch<{ applied: number; skipped: Array<{ title: string; reason: string }> }>(`${base}/admin/auto-schedule`, {
        method: 'POST',
        json: { assignments: chosen.map((a) => ({ sessionId: a.sessionId, slotId: a.slotId })) },
      })
      setAutoOpen(false)
      setAutoResult(null)
      setHistory([])
      setHistoryIndex(-1)
      setNotice({
        kind: 'success',
        text: `Applied ${res.applied} of ${chosen.length} assignment${chosen.length === 1 ? '' : 's'} to the draft schedule.`,
        details: res.skipped.map((s) => `${s.title}: ${s.reason}`),
      })
      await refreshAfterChange()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The assignments could not be applied.') })
    } finally {
      setAutoLoading(false)
    }
  }

  const publish = async () => {
    setPublishing(true)
    setPublishResult(null)
    try {
      const res = await apiFetch<PublishResponse>(`${base}/admin/publish-schedule`, { method: 'POST' })
      setPublishResult(res)
      await refreshAfterChange()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e, 'The schedule could not be published.') })
      setPublishOpen(false)
    } finally {
      setPublishing(false)
    }
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-12" role="status" aria-label="Loading schedule"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }
  if (!canSchedule) {
    return <Card><CardContent className="py-10 text-center text-muted-foreground">Only owners and admins can edit the schedule.</CardContent></Card>
  }

  const slotFor = (venueId: string, row: { start: string; end: string }) =>
    timeSlots.find((t) => t.venue_id === venueId && t.start_time === row.start && t.end_time === row.end)
  const destructiveSlot = destructive?.kind === 'move' ? timeSlots.find((t) => t.id === destructive.slotId) : null
  const changeCount = publishStatus ? publishStatus.changes.added.length + publishStatus.changes.moved.length + publishStatus.changes.removed.length : 0

  return (
    <>
      <div className="mb-6">
        <h1 className="font-semibold">Schedule builder</h1>
        <p className="text-muted-foreground mt-2">Bring ideas into the room. Arrange sessions as a draft, then publish when you&rsquo;re ready. Moving or cancelling a session that is already published needs another organizer&rsquo;s approval.</p>
      </div>

      {loadError && (
        <div role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => { setIsLoading(true); void load() }}>Try again</Button>
        </div>
      )}

      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('mb-4 rounded-xl border bg-card p-4 text-sm', notice.kind === 'error' ? 'border-destructive/30 text-destructive' : notice.kind === 'info' ? 'border-amber-500/40' : 'border-primary/30')}>
          <div className="flex items-start justify-between gap-3">
            <p>{notice.text}</p>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          {notice.details && notice.details.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{notice.details.slice(0, 8).map((d) => <li key={d}>{d}</li>)}</ul>
          )}
        </div>
      )}

      {(pendingRequests.length > 0 || approvalsError) && (
        <section aria-labelledby="approvals-heading" className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <h2 id="approvals-heading" className="flex items-center gap-2 font-semibold text-sm"><ShieldCheck className="h-4 w-4 text-amber-600" />Changes awaiting approval</h2>
          {approvalsError && <p className="mt-2 text-sm text-destructive">{approvalsError}</p>}
          <ul className="mt-3 space-y-3">
            {pendingRequests.map((r) => {
              const approvedByCount = r.approvals.length
              const when = r.target.startsAt ? `${formatInEventTimezone(new Date(r.target.startsAt), event.timezone, 'datetime')}` : null
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {r.action === 'move' ? 'Move' : r.action === 'cancel' ? 'Cancel' : 'Remove listing for'} &ldquo;{r.sessionTitle ?? 'session'}&rdquo;{r.action === 'move' && when ? ` to ${when}` : ''}
                    </p>
                    <p className="text-muted-foreground">&ldquo;{r.reason}&rdquo;{r.requestedBy?.handle ? ` — requested by @${r.requestedBy.handle}` : ''}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {r.status === 'failed' ? `Approved, but applying failed: ${r.error ?? 'unknown error'}` : `${approvedByCount} of ${r.threshold} approvals`}
                      {r.approvals.length > 0 && ` (${r.approvals.map((a) => (a.handle ? `@${a.handle}` : 'an organizer')).join(', ')})`}
                    </p>
                  </div>
                  {(() => {
                    const mine = r.approvals.some((a) => a.accountId === viewerAccountId)
                    if (mine && r.status === 'pending') return <Badge variant="outline" className="shrink-0">You approved</Badge>
                    return (
                      <div className="flex flex-col items-end gap-2">
                        {needsLinkage && (
                          <label className="flex items-start gap-2 text-xs max-w-xs">
                            <input type="checkbox" checked={confirmLinkage} onChange={(e) => setConfirmLinkage(e.target.checked)} className="mt-0.5" />
                            <span>My approval is a public record in my own repository naming me as an organizer.</span>
                          </label>
                        )}
                        <Button size="sm" onClick={() => void approveRequest(r)} disabled={busy || r.status === 'applying' || (needsLinkage && !confirmLinkage)}>
                          {r.status === 'failed' ? 'Retry' : 'Approve'}
                        </Button>
                      </div>
                    )
                  })()}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {picked && (
        <p role="status" className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm flex items-center justify-between gap-2">
          <span>Placing &ldquo;{picked.title}&rdquo; — choose a free slot in the grid.</span>
          <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Cancel</Button>
        </p>
      )}

      <div className="relative flex min-h-[600px] h-[calc(100dvh-220px)] calendar-workspace overflow-hidden bg-card">
        <div className={cn('border-r bg-muted/30 flex flex-col transition-all duration-200', showSidebar ? 'absolute inset-y-0 left-0 z-10 w-72 bg-card shadow-xl lg:static lg:w-72 lg:shadow-none shrink-0' : 'w-0 overflow-hidden')}>
          <div className="p-3 sm:p-4 border-b bg-background flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="font-semibold text-sm">Unscheduled ({unscheduled.length})</h2>
              <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">Drag to a slot, or choose Place</p>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" aria-label="Close unscheduled sessions" onClick={() => setShowSidebar(false)}>
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2">
            {unscheduled.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">All approved sessions are scheduled</p>
            ) : (
              unscheduled.map((session) => {
                const prefs = session.time_preferences ?? []
                const matchesDay = prefs.some((p) => dayPrefs.includes(p))
                return (
                  <div
                    key={session.id}
                    draggable
                    onDragStart={() => setDragged(session)}
                    onDragEnd={() => setDragged(null)}
                    className={cn('p-3 bg-background rounded-lg border shadow-sm cursor-move hover:shadow-md transition-shadow group', matchesDay && 'ring-2 ring-green-500/50 border-green-500/30', picked?.id === session.id && 'ring-2 ring-primary')}
                  >
                    <div className="flex items-start gap-2">
                      <GripVertical className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0 opacity-50 group-hover:opacity-100" aria-hidden />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {session.format && <Badge variant="outline" className="text-xs capitalize shrink-0">{session.format}</Badge>}
                          {session.duration && <span className="text-xs text-muted-foreground">{session.duration} min</span>}
                        </div>
                        <h3 className="text-sm font-medium line-clamp-2">{session.title}</h3>
                        {hostLabel(session) && <p className="text-xs text-muted-foreground mt-1">{hostLabel(session)}</p>}
                        <div className="flex flex-wrap items-center gap-1 mt-2">
                          {session.track && (
                            <Badge variant="secondary" className="text-xs" style={{ backgroundColor: session.track.color ?? undefined }}>{session.track.name}</Badge>
                          )}
                          {prefs.map((pref) => (
                            <Badge key={pref} variant="outline" className={cn('text-[10px]', dayPrefs.includes(pref) ? 'border-green-500 text-green-700 dark:text-green-400 bg-green-500/10' : 'text-muted-foreground')}>
                              {PREF_LABELS[pref] || pref}
                            </Badge>
                          ))}
                        </div>
                        <Button size="sm" variant="ghost" className="mt-2 h-7 px-2 text-xs" onClick={() => setPicked(picked?.id === session.id ? null : session)} aria-pressed={picked?.id === session.id}>
                          {picked?.id === session.id ? 'Cancel placing' : 'Place…'}
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 p-3 sm:p-4 border-b bg-background overflow-x-auto">
            {!showSidebar && (
              <Button variant="outline" size="sm" onClick={() => setShowSidebar(true)} className="flex-shrink-0">
                <PanelLeft className="h-4 w-4 mr-1" />
                <span className="hidden sm:inline">Sessions</span>
                <Badge variant="secondary" className="ml-1 text-xs">{unscheduled.length}</Badge>
              </Button>
            )}
            {eventDays.map((day) => (
              <Button key={day} variant={selectedDay === day ? 'default' : 'outline'} size="sm" onClick={() => setSelectedDay(day)} aria-pressed={selectedDay === day} className="calendar-day whitespace-nowrap flex-shrink-0">
                {getEventDayLabel(day, event.timezone)}
              </Button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              {unscheduled.length > 0 && (
                <Button variant="outline" size="sm" onClick={previewAutoSchedule} disabled={autoLoading || busy} className="gap-1.5" title={votingStatus === 'open' ? 'Available after voting closes' : undefined}>
                  {votingStatus === 'open' ? <Lock className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
                  <span className="hidden sm:inline">Auto-schedule</span>
                </Button>
              )}
              <div className="w-px h-6 bg-border mx-1 hidden sm:block" />
              <Button variant="ghost" size="sm" onClick={() => void undo()} disabled={historyIndex < 0 || busy} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => void redo()} disabled={historyIndex >= history.length - 1 || busy} aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)} disabled={busy} aria-label="Clear this day" title="Clear this day" className="text-destructive hover:text-destructive"><RotateCcw className="h-4 w-4" /></Button>
              <div className="w-px h-6 bg-border mx-1 hidden sm:block" />
              {publishStatus?.hasUnpublishedChanges && (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"><FileText className="h-3 w-3 mr-1" />{changeCount} unpublished</Badge>
              )}
              <Button variant={publishStatus?.hasUnpublishedChanges ? 'default' : 'outline'} size="sm" onClick={() => { setPublishResult(null); setPublishOpen(true) }} className="gap-1.5">
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">{publishStatus?.schedulePublishedAt ? 'Publish changes' : 'Publish'}</span>
              </Button>
            </div>
          </div>

          {confirmReset && (
            <div role="alertdialog" aria-label="Clear this day" className="flex flex-wrap items-center justify-between gap-2 border-b bg-destructive/5 px-4 py-3 text-sm">
              <span>Remove every draft placement on {getEventDayLabel(selectedDay, event.timezone)}? Published sessions stay where they are.</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmReset(false)}>Keep</Button>
                <Button size="sm" variant="destructive" onClick={() => void resetDay()}>Clear day</Button>
              </div>
            </div>
          )}

          <div className="sm:hidden px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">Scroll horizontally to see every room.</div>

          <div className="flex-1 overflow-auto p-4">
            {timeRows.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  No time slots for this day.
                  <br />
                  <Link href={`/e/${event.slug}/admin/setup`} className="text-primary hover:underline">Add availability in Spaces &amp; times</Link>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-2" style={{ gridTemplateColumns: `80px repeat(${venues.length}, minmax(140px, 1fr))` }}>
                <div className="h-12" />
                {venues.map((venue) => (
                  <div key={venue.id} className={cn('h-12 rounded-lg flex items-center justify-center px-2 text-center', venue.is_primary ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                    <div>
                      <div className="font-semibold text-sm truncate">{venue.name}</div>
                      {venue.capacity && <div className="text-xs opacity-80">{venue.capacity} cap</div>}
                    </div>
                  </div>
                ))}
                {timeRows.map((row) => (
                  <React.Fragment key={`${row.start}|${row.end}`}>
                    <div className="flex flex-col justify-center text-xs text-muted-foreground pr-2 text-right h-24">
                      <div className="font-medium">{formatTime(row.start)}</div>
                      <div>{formatTime(row.end)}</div>
                    </div>
                    {venues.map((venue) => {
                      const slot = slotFor(venue.id, row)
                      if (!slot) return <div key={venue.id} className="h-24 rounded-lg bg-muted/20 border border-dashed border-muted-foreground/20" />
                      if (slot.is_break) {
                        return (
                          <div key={venue.id} className="h-24 rounded-lg bg-amber-100 dark:bg-amber-950/30 flex items-center justify-center overflow-hidden">
                            <span className="text-xs text-amber-700 dark:text-amber-400 font-medium truncate px-2">{slot.label || 'Break'}</span>
                          </div>
                        )
                      }
                      const session = sessionBySlot.get(slot.id)
                      const mover = dragged ?? picked
                      if (session) {
                        const request = openRequestBySession.get(session.id)
                        const duration = slotMinutes(slot)
                        const mismatch = session.duration !== null && session.duration !== duration
                        const overCapacity = Boolean(venue.capacity && session.expected_attendance && session.expected_attendance > venue.capacity)
                        return (
                          <div
                            key={venue.id}
                            onDragOver={(e) => { if (dragged) e.preventDefault() }}
                            onDrop={(e) => { e.preventDefault(); if (dragged) void dropOnSlot(dragged, slot.id) }}
                            className={cn('min-h-24 rounded-xl border-l-4 border p-3 relative group overflow-hidden', session.proposal_withdrawn_at ? 'bg-destructive/5 border-destructive/40' : mismatch || overCapacity || session.proposal_drift_at ? 'bg-amber-500/10 border-amber-500/30' : 'bg-secondary border-primary/60')}
                          >
                            <button
                              onClick={() => void removeFromSlot(session)}
                              disabled={busy || Boolean(request)}
                              aria-label={session.network_published ? `Cancel published session ${session.title}` : `Remove ${session.title} from this time slot`}
                              title={session.network_published ? 'Cancel (needs approval)' : 'Remove from slot'}
                              className="absolute top-1 right-1 p-1 rounded bg-background/80 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-destructive hover:text-destructive-foreground z-10 disabled:opacity-40"
                            >
                              <X className="h-3 w-3" />
                            </button>
                            <div className="flex flex-wrap items-center gap-1">
                              {session.network_published && <Badge variant="outline" className="text-[10px] gap-0.5 px-1"><Globe className="h-2.5 w-2.5" />Published</Badge>}
                              {request && <Badge variant="outline" className="text-[10px] gap-0.5 px-1 border-amber-500/60 text-amber-700 dark:text-amber-400"><Hourglass className="h-2.5 w-2.5" />Awaiting approval</Badge>}
                              {mismatch && <span title={`Session is ${session.duration} min; slot is ${duration} min`}><Clock className="h-3 w-3 text-amber-600" aria-label="Duration mismatch" /></span>}
                              {overCapacity && <span title={`Expected ${session.expected_attendance}; room holds ${venue.capacity}`}><AlertTriangle className="h-3 w-3 text-amber-600" aria-label="Over capacity" /></span>}
                            </div>
                            <h3 className="text-xs font-medium line-clamp-2 mt-1">{session.title}</h3>
                            {hostLabel(session) && <p className="text-xs text-muted-foreground mt-0.5 truncate">{hostLabel(session)}</p>}
                            {session.proposal_withdrawn_at && <p className="text-[11px] text-destructive mt-0.5">Withdrawn by proposer</p>}
                            {!session.proposal_withdrawn_at && session.proposal_drift_at && <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">Proposer edited — re-publish</p>}
                            {session.network_published && !request && (
                              <button
                                draggable
                                onDragStart={() => setDragged(session)}
                                onDragEnd={() => setDragged(null)}
                                onClick={() => setPicked(picked?.id === session.id ? null : session)}
                                className="mt-1 text-[11px] text-primary hover:underline"
                              >
                                {picked?.id === session.id ? 'Cancel move' : 'Move…'}
                              </button>
                            )}
                            {!session.network_published && (
                              <button draggable onDragStart={() => setDragged(session)} onDragEnd={() => setDragged(null)} onClick={() => setPicked(picked?.id === session.id ? null : session)} className="mt-1 text-[11px] text-primary hover:underline">
                                {picked?.id === session.id ? 'Cancel move' : 'Move…'}
                              </button>
                            )}
                          </div>
                        )
                      }
                      const duration = slotMinutes(slot)
                      const durationWarning = mover && mover.duration !== null && mover.duration !== duration
                      return (
                        <button
                          key={venue.id}
                          type="button"
                          disabled={!picked || busy}
                          onClick={() => { if (picked) void dropOnSlot(picked, slot.id) }}
                          onDragOver={(e) => { if (dragged) e.preventDefault() }}
                          onDrop={(e) => { e.preventDefault(); if (dragged) void dropOnSlot(dragged, slot.id) }}
                          aria-label={picked ? `Place ${picked.title} in ${venue.name} at ${formatTime(slot.start_time)}` : `Free slot in ${venue.name} at ${formatTime(slot.start_time)}`}
                          className={cn(
                            'h-24 w-full rounded-lg border-2 border-dashed transition-colors flex flex-col items-center justify-center overflow-hidden gap-1 disabled:cursor-default',
                            mover ? (durationWarning ? 'border-amber-500/60 bg-amber-500/5' : 'border-primary/50 bg-primary/5 hover:bg-primary/10') : 'border-muted-foreground/20 bg-muted/10',
                          )}
                        >
                          <span className="text-xs text-muted-foreground">{slot.label || `${duration} min`}</span>
                          {durationWarning && <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><Clock className="h-3 w-3" />Session is {mover.duration} min</span>}
                        </button>
                      )
                    })}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
          <div className="w-full max-w-md bg-card border rounded-xl shadow-xl p-5">
            <div className="flex items-start gap-3 mb-4">
              <div className="p-2 rounded-full bg-amber-500/10"><AlertTriangle className="h-5 w-5 text-amber-500" /></div>
              <div>
                <h2 id="conflict-title" className="font-semibold">That slot is taken</h2>
                <p className="text-sm text-muted-foreground mt-1">&ldquo;{conflict.occupant}&rdquo; is already there. Replace it? It goes back to the tray.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setConflict(null)}>Cancel</Button>
              <Button variant="destructive" className="flex-1" disabled={busy} onClick={() => void dropOnSlot(conflict.session, conflict.slotId, true)}>Replace</Button>
            </div>
          </div>
        </div>
      )}

      {destructive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="destructive-title">
          <div className="w-full max-w-md bg-card border rounded-xl shadow-xl p-5 space-y-4">
            <div>
              <h2 id="destructive-title" className="font-semibold flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-amber-600" />{destructive.kind === 'move' ? 'Move a published session' : 'Cancel a published session'}</h2>
              <p className="text-sm text-muted-foreground mt-2">
                &ldquo;{destructive.session.title}&rdquo; is on the published calendar, so people may already have it saved.
                {destructive.kind === 'move'
                  ? ` Moving it${destructiveSlot ? ` to ${formatInEventTimezone(new Date(destructiveSlot.start_time), event.timezone, 'datetime')}` : ''} needs approval from other organizers. Your request counts as the first approval.`
                  : ' Cancelling marks its calendar event cancelled once other organizers approve. The proposal stays with its author.'}
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="destructive-reason" className="text-sm font-medium">Reason (shown to approvers)</label>
              <textarea id="destructive-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className="w-full min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm" />
            </div>
            {needsLinkage && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={confirmLinkage} onChange={(e) => setConfirmLinkage(e.target.checked)} className="mt-1" />
                <span>I understand my approval is a public record in my own repository that names me as an organizer of this gathering.</span>
              </label>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setDestructive(null)} disabled={busy}>Keep as is</Button>
              <Button className="flex-1" onClick={() => void submitDestructive()} disabled={busy || !reason.trim() || (needsLinkage && !confirmLinkage)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Request change'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {autoOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="auto-title">
          <div className="w-full max-w-2xl max-h-[80vh] bg-card border rounded-xl shadow-xl flex flex-col">
            <div className="p-5 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-primary/10"><SlidersHorizontal className="h-5 w-5 text-primary" /></div>
                <div>
                  <h2 id="auto-title" className="font-semibold">Auto-schedule preview</h2>
                  <p className="text-sm text-muted-foreground">Review proposed placements before adding them to the draft</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setAutoOpen(false)} disabled={autoLoading} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {autoLoading && !autoResult ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
              ) : autoResult ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-muted rounded-lg p-3 text-center"><div className="text-2xl font-bold">{autoResult.stats.assigned}</div><div className="text-xs text-muted-foreground">Placed</div></div>
                    <div className="bg-muted rounded-lg p-3 text-center"><div className="text-2xl font-bold">{autoResult.stats.unassigned}</div><div className="text-xs text-muted-foreground">Not placed</div></div>
                    <div className="bg-muted rounded-lg p-3 text-center"><div className="text-2xl font-bold">{autoResult.stats.averageScore}</div><div className="text-xs text-muted-foreground">Average fit</div></div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {autoResult.stats.usedBallots
                      ? 'Ordering and overlap use the closed round’s ballots. Overlap compares anonymous ballot tokens, never people.'
                      : 'No closed voting round yet: placements use duration, preferences, rooms and tracks only.'}
                  </p>
                  {autoResult.assignments.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-medium">Proposed ({selectedAssignments.size}/{autoResult.assignments.length} selected)</h3>
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setSelectedAssignments(new Set(autoResult.assignments.map((a) => a.sessionId)))}>Select all</Button>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedAssignments(new Set())}>Clear</Button>
                        </div>
                      </div>
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {autoResult.assignments.map((a) => {
                          const slot = timeSlots.find((t) => t.id === a.slotId)
                          const venue = venues.find((v) => v.id === a.venueId)
                          const checked = selectedAssignments.has(a.sessionId)
                          const toggle = () => setSelectedAssignments((prev) => { const next = new Set(prev); if (next.has(a.sessionId)) next.delete(a.sessionId); else next.add(a.sessionId); return next })
                          return (
                            <div key={a.sessionId} className={cn('p-3 rounded-lg border text-sm', checked ? (a.warnings.length ? 'bg-amber-500/10 border-amber-500/50' : 'bg-green-500/10 border-green-500/50') : 'bg-muted/50 opacity-60')}>
                              <div className="flex items-start gap-3">
                                <Checkbox checked={checked} onCheckedChange={toggle} className="mt-0.5" aria-label={`Include ${a.sessionTitle}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="font-medium truncate">{a.sessionTitle}</p>
                                      <p className="text-xs text-muted-foreground">{venue?.name} · {slot ? formatInEventTimezone(new Date(slot.start_time), event.timezone, 'datetime') : 'Unknown slot'}</p>
                                    </div>
                                    <Badge variant="outline" className="text-xs shrink-0">Fit {a.score}</Badge>
                                  </div>
                                  {a.warnings.length > 0 && (
                                    <ul className="mt-2 space-y-0.5">{a.warnings.map((w) => <li key={w} className="text-xs text-amber-700 dark:text-amber-400 flex gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />{w}</li>)}</ul>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {autoResult.unassigned.length > 0 && (
                    <div>
                      <h3 className="font-medium mb-2 text-amber-700 dark:text-amber-400">Could not place ({autoResult.unassigned.length})</h3>
                      <div className="space-y-2">{autoResult.unassigned.map((u) => <div key={u.sessionId} className="p-3 rounded-lg bg-muted text-sm"><p className="font-medium">{u.sessionTitle}</p><p className="text-xs text-muted-foreground">{u.reason}</p></div>)}</div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            {autoResult && autoResult.assignments.length > 0 && (
              <div className="p-5 border-t flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setAutoOpen(false)} disabled={autoLoading}>Cancel</Button>
                <Button className="flex-1" onClick={() => void applyAutoSchedule()} disabled={autoLoading || selectedAssignments.size === 0}>
                  {autoLoading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Applying…</> : <>Add {selectedAssignments.size} to draft</>}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {publishOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="publish-title">
          <div className="bg-background rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="p-5 border-b flex items-center justify-between">
              <h2 id="publish-title" className="font-semibold">{publishResult ? 'Schedule published' : 'Publish schedule'}</h2>
              <Button variant="ghost" size="sm" onClick={() => setPublishOpen(false)} aria-label="Close" disabled={publishing}><X className="h-4 w-4" /></Button>
            </div>
            <div className="p-5 overflow-y-auto space-y-4 text-sm">
              {publishResult ? (
                <>
                  <div className="flex items-center gap-3">
                    <CheckCircle className="h-8 w-8 text-green-500" />
                    <div>
                      <p className="font-medium">{publishResult.message}</p>
                      <p className="text-muted-foreground">{publishResult.notified.members} member{publishResult.notified.members === 1 ? '' : 's'} notified that the schedule is live.</p>
                    </div>
                  </div>
                  {publishResult.network.attempted ? (
                    <div className="rounded-lg border p-3 space-y-2">
                      <p className="font-medium flex items-center gap-2"><Globe className="h-4 w-4" />Network calendar</p>
                      {publishResult.network.error ? (
                        <p role="alert" className="text-destructive">{publishResult.network.error}</p>
                      ) : publishResult.network.queued && publishResult.network.jobId ? (
                        <PublishJobProgress
                          statusUrl={`${base}/admin/publish-schedule?jobId=${encodeURIComponent(publishResult.network.jobId)}`}
                          onDone={() => void refreshAfterChange()}
                        />
                      ) : (
                        <p className="text-muted-foreground">{publishResult.network.published} session{publishResult.network.published === 1 ? '' : 's'} written; {publishResult.network.failed} failed.</p>
                      )}
                      {publishResult.network.results.length > 0 && (
                        <ul className="max-h-48 overflow-y-auto space-y-1 text-xs">
                          {publishResult.network.results.map((r, i) => {
                            const title = sessions.find((s) => s.id === r.id)?.title ?? r.id
                            return (
                              <li key={`${r.kind}-${r.id}-${i}`} className={cn('flex gap-2', r.error ? 'text-destructive' : 'text-muted-foreground')}>
                                <span className="shrink-0">{r.error ? '✕' : '✓'}</span>
                                <span className="break-all">{title} · {r.kind}{r.error ? ` — ${r.error}` : ''}</span>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">This gathering is not on the network yet, so only the app schedule was published.</p>
                  )}
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <div className="flex justify-between"><span className="text-muted-foreground">Scheduled sessions</span><span className="font-medium">{publishStatus?.scheduledSessions ?? 0}</span></div>
                    {publishStatus?.schedulePublishedAt && <div className="flex justify-between"><span className="text-muted-foreground">Last published</span><span className="font-medium">{new Date(publishStatus.schedulePublishedAt).toLocaleString()}</span></div>}
                  </div>
                  {publishStatus && changeCount > 0 ? (
                    <div className="rounded-lg bg-muted p-3 space-y-1">
                      <p className="font-medium">Changes since the last publish</p>
                      {publishStatus.changes.added.length > 0 && <p>{publishStatus.changes.added.length} added</p>}
                      {publishStatus.changes.moved.length > 0 && <p>{publishStatus.changes.moved.length} moved</p>}
                      {publishStatus.changes.removed.length > 0 && <p>{publishStatus.changes.removed.length} removed</p>}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">No placement changes since the last publish. Publishing again re-sends the schedule to the network and tells members it is live.</p>
                  )}
                  {publishStatus?.networkLinked && <p className="text-muted-foreground flex gap-2"><Globe className="h-4 w-4 shrink-0 mt-0.5" />Each scheduled session is also written to the gathering&rsquo;s public calendar on the network.</p>}
                  {publishStatus?.scheduledSessions === 0 && (
                    <p className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-700 dark:text-amber-400 flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />No sessions are scheduled yet.</p>
                  )}
                </>
              )}
            </div>
            <div className="p-5 border-t flex gap-2">
              {publishResult ? (
                <Button className="flex-1" onClick={() => setPublishOpen(false)}>Done</Button>
              ) : (
                <>
                  <Button variant="outline" className="flex-1" onClick={() => setPublishOpen(false)} disabled={publishing}>Cancel</Button>
                  <Button className="flex-1" onClick={() => void publish()} disabled={publishing}>
                    {publishing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Publishing…</> : <><Send className="h-4 w-4 mr-2" />Publish</>}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
