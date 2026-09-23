'use client'

/**
 * `/e/[slug]/admin/moderation` — the organizer moderation queue (MT §12.5, spec §9).
 *
 * Open cases first. For each one the organizer can dismiss it, hide the session from the
 * listings, remove the person from the gathering, or leave a note and keep watching. The
 * reporter hears the outcome; the organizer's note does not leave this page.
 *
 * What this page is careful about: it shows the reporter's name to organizers and to nobody
 * else, it never shows a DID, and "hide" is an app-side listing decision — the author's
 * proposal record stays in the author's repo, untouched.
 */

import * as React from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, EyeOff, Loader2, ShieldAlert, UserMinus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/PageHeader'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import {
  MODERATION_ACTION_LABELS,
  REPORT_REASON_LABELS,
  REPORT_SUBJECT_LABELS,
  type ModerationAction,
  type ReportReason,
  type ReportSubjectKind,
} from '@/lib/moderation/reasons'

interface QueuedReport {
  id: string
  status: 'open' | 'dismissed' | 'actioned'
  reason: ReportReason
  subjectKind: ReportSubjectKind
  details: string | null
  createdAt: string
  reporter: { accountId: string; name: string } | null
  subject: {
    sessionId: string | null
    sessionTitle: string | null
    sessionHidden: boolean
    accountId: string | null
    name: string | null
    ref: string | null
  }
  resolution: { action: ModerationAction | null; note: string | null; at: string | null; by: string | null } | null
}

type Filter = 'open' | 'resolved' | 'all'

/**
 * Hiding is an app-side listing decision. If the session was already on the published network
 * schedule, that record is a promise other people put in their calendars, and only the
 * two-organizer destructive flow may withdraw it — so the organizer is told, in plain words,
 * which of those two worlds they are in.
 */
const PUBLISHED_RECORD_NOTE: Record<string, string> = {
  'not-published': 'Nothing of it was on the network.',
  'cancel-applied': 'Its published calendar event has been cancelled on the network.',
  'cancel-awaiting-approval': 'A cancellation of its published calendar event is waiting for another organizer to approve.',
  'needs-owner-or-admin': 'Its published calendar event REMAINS on the network — an owner or admin must cancel it from the schedule.',
  'cancel-failed': 'Its published calendar event REMAINS on the network; the cancellation could not be requested.',
}

export default function ModerationPage() {
  const event = useEvent()
  const [filter, setFilter] = React.useState<Filter>('open')
  const [reports, setReports] = React.useState<QueuedReport[] | null>(null)
  const [open, setOpen] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const [feedback, setFeedback] = React.useState<string | null>(null)

  const path = `/api/v1/events/${encodeURIComponent(event.slug)}/admin/moderation`

  const load = React.useCallback(async (which: Filter) => {
    setError(null)
    try {
      const data = await apiFetch<{ reports: QueuedReport[]; open: number }>(`${path}?status=${which}`, { cache: 'no-store' })
      setReports(data.reports)
      setOpen(data.open)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The queue could not be loaded.')
      setReports([])
    }
  }, [path])

  React.useEffect(() => { void load(filter) }, [filter, load])

  const act = async (report: QueuedReport, action: ModerationAction) => {
    setBusy(report.id)
    setFeedback(null)
    setError(null)
    try {
      const result = await apiFetch<{ publishedRecord?: string }>(path, {
        method: 'PATCH',
        json: { reportId: report.id, action, note: notes[report.id]?.trim() || null },
      })
      const published = result.publishedRecord ? PUBLISHED_RECORD_NOTE[result.publishedRecord] : null
      setFeedback(
        action === 'note'
          ? 'Note saved. The case stays open.'
          : ['Done. The person who reported it has been told.', published].filter(Boolean).join(' '),
      )
      await load(filter)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  const unhide = async (sessionId: string) => {
    setBusy(sessionId)
    try {
      await apiFetch(path, { method: 'POST', json: { sessionId, unhide: true } })
      setFeedback('The session is listed again.')
      await load(filter)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  return <div className="max-w-3xl">
    <PageHeader
      title="Moderation"
      subtitle="Reports from members about a session, a person or a comment. They are private to this gathering’s organizers."
    />

    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <SegmentedControl
        aria-label="Which reports"
        value={filter}
        onValueChange={(v) => setFilter(v as Filter)}
        options={[
          { value: 'open', label: `Open${open ? ` (${open})` : ''}` },
          { value: 'resolved', label: 'Resolved' },
          { value: 'all', label: 'All' },
        ]}
      />
    </div>

    {feedback ? <p className="mb-4 text-sm text-success" role="status">{feedback}</p> : null}
    {error ? <p className="mb-4 text-sm text-destructive" role="alert">{error}</p> : null}

    {reports === null ? (
      <div className="flex justify-center py-10" role="status" aria-label="Loading reports"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    ) : reports.length === 0 ? (
      <Card><CardContent className="p-8 text-center">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">{filter === 'open' ? 'Nothing waiting.' : 'Nothing here.'}</p>
        <p className="mt-1 text-sm text-muted-foreground">Reports members file about this gathering land here, and only here.</p>
      </CardContent></Card>
    ) : (
      <ul className="space-y-4">
        {reports.map((report) => (
          <li key={report.id}>
            <Card>
              <CardContent className="space-y-3 p-4 sm:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={report.status === 'open' ? 'amber' : 'muted'}>
                    {report.status === 'open' ? 'Open' : report.status === 'dismissed' ? 'Dismissed' : 'Actioned'}
                  </Badge>
                  <Badge variant="secondary">{REPORT_SUBJECT_LABELS[report.subjectKind]}</Badge>
                  <span className="text-sm font-medium">{REPORT_REASON_LABELS[report.reason]}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{new Date(report.createdAt).toLocaleString()}</span>
                </div>

                <p className="text-sm">
                  <span className="text-muted-foreground">About: </span>
                  {report.subject.sessionId ? (
                    <>
                      <Link href={`/e/${event.slug}/sessions/${report.subject.sessionId}`} className="underline">
                        {report.subject.sessionTitle || 'a session'}
                      </Link>
                      {report.subject.sessionHidden ? <Badge variant="muted" className="ml-2">Hidden</Badge> : null}
                    </>
                  ) : report.subject.accountId ? (
                    <span>{report.subject.name || 'a member'}</span>
                  ) : (
                    <span className="font-mono text-xs">{report.subject.ref}</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Reported by {report.reporter?.name ?? 'someone who has since left'}. They are never told to the person reported.
                </p>

                {report.details ? (
                  <blockquote className="rounded-lg border-l-2 border-border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap">{report.details}</blockquote>
                ) : null}

                {report.status === 'open' ? <>
                  <Textarea
                    aria-label="Note for the other organizers"
                    placeholder="A note for the other organizers (optional). It stays on this page."
                    rows={2}
                    value={notes[report.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [report.id]: e.target.value }))}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" loading={busy === report.id} onClick={() => void act(report, 'dismiss')}>
                      <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />Dismiss
                    </Button>
                    {report.subject.sessionId ? (
                      <Button type="button" variant="outline" size="sm" loading={busy === report.id} onClick={() => void act(report, 'hide_session')}>
                        <EyeOff className="mr-2 h-4 w-4" aria-hidden="true" />Hide the session
                      </Button>
                    ) : null}
                    {report.subject.accountId ? (
                      <Button type="button" variant="destructive" size="sm" loading={busy === report.id} onClick={() => void act(report, 'remove_member')}>
                        <UserMinus className="mr-2 h-4 w-4" aria-hidden="true" />Remove from the gathering
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" size="sm" loading={busy === report.id} onClick={() => void act(report, 'note')}>
                      Save a note, keep it open
                    </Button>
                  </div>
                  {report.subject.sessionId ? (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Hiding takes the session out of this app’s listings. The proposal itself is the author’s own record, in their own repository, and stays exactly where it is.
                    </p>
                  ) : null}
                </> : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {report.resolution?.action ? MODERATION_ACTION_LABELS[report.resolution.action] : 'Resolved'}
                      {report.resolution?.by ? ` by ${report.resolution.by}` : ''}
                      {report.resolution?.at ? ` · ${new Date(report.resolution.at).toLocaleString()}` : ''}
                    </p>
                    {report.resolution?.note ? <p className="text-sm whitespace-pre-wrap">{report.resolution.note}</p> : null}
                    {report.subject.sessionId && report.subject.sessionHidden ? (
                      <Button type="button" variant="outline" size="sm" loading={busy === report.subject.sessionId}
                        onClick={() => void unhide(report.subject.sessionId!)}>
                        List the session again
                      </Button>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    )}
  </div>
}
