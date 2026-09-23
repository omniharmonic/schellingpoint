'use client'

/**
 * "Report" — the control a member uses to tell this gathering's organizers that something is
 * wrong with a session, a person or a comment (MT §12.5).
 *
 * Three things this deliberately does not do, all for the same reason — a report is a private
 * message to the organizers of one gathering, not a public act:
 *   · it never says anything to the person reported, or anywhere anyone else can see;
 *   · it names its subject by account id, so nothing here puts a DID in a request body;
 *   · it is offered to members only. Signed-out visitors see nothing.
 *
 * Rendered as a quiet text button by default, because a report control that shouts invites
 * being used as a shout.
 */

import * as React from 'react'
import { Flag } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import {
  MAX_REPORT_DETAILS,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type ReportReason,
  type ReportSubjectKind,
} from '@/lib/moderation/reasons'

export interface ReportButtonProps extends Pick<ButtonProps, 'variant' | 'size' | 'className'> {
  eventSlug: string
  subjectKind: ReportSubjectKind
  /** For a session. */
  sessionId?: string
  /** For a person: their account id. Never a DID. */
  accountId?: string
  /**
   * For a comment or feedback item: its app-side id. Named `itemRef`, not `ref`, because
   * `ref` on a component is React's own prop and would never arrive here.
   */
  itemRef?: string
  /** What the person is about to report, in their words ("this session", "Alex"). */
  subjectLabel?: string
  /** 'icon' renders an icon-only trigger with an accessible name. */
  iconOnly?: boolean
  label?: string
}

export function ReportButton({
  eventSlug,
  subjectKind,
  sessionId,
  accountId,
  itemRef,
  subjectLabel,
  iconOnly,
  label = 'Report',
  variant = 'ghost',
  size = 'sm',
  className,
}: ReportButtonProps) {
  const { isMember } = useEventRole()
  const [open, setOpen] = React.useState(false)
  const [reason, setReason] = React.useState<ReportReason>('code_of_conduct')
  const [details, setDetails] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
  const id = React.useId()

  if (!isMember) return null

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/v1/events/${encodeURIComponent(eventSlug)}/reports`, {
        method: 'POST',
        json: { subjectKind, sessionId, accountId, ref: itemRef, reason, details: details.trim() || null },
      })
      setDone(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Your report could not be sent. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    setOpen(false)
    // Leave the "thank you" behind rather than flashing the form on the way out.
    window.setTimeout(() => { setDone(false); setDetails(''); setError(null) }, 200)
  }

  return <>
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? 'icon-sm' : size}
      className={className}
      onClick={() => setOpen(true)}
      aria-label={iconOnly ? `Report ${subjectLabel ?? 'this'}` : undefined}
      title={iconOnly ? `Report ${subjectLabel ?? 'this'}` : undefined}
    >
      <Flag className="h-4 w-4" aria-hidden="true" />
      {iconOnly ? null : <span className="ml-2">{label}</span>}
    </Button>

    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{done ? 'Thank you' : `Report ${subjectLabel ?? 'this'}`}</DialogTitle>
          <DialogDescription>
            {done
              ? 'The organizers of this gathering have it. You will hear what they decided. The person you reported is never told who reported them.'
              : 'This goes to the organizers of this gathering and to nobody else. It is not published, and the person you report is never told who reported them.'}
          </DialogDescription>
        </DialogHeader>

        {done ? null : <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-reason`}>What is wrong?</Label>
            <Select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
              {REPORT_REASONS.map((value) => <option key={value} value={value}>{REPORT_REASON_LABELS[value]}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-details`}>Anything the organizers should know (optional)</Label>
            <Textarea
              id={`${id}-details`}
              rows={4}
              maxLength={MAX_REPORT_DETAILS}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="What happened, and where."
            />
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </div>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>{done ? 'Close' : 'Cancel'}</Button>
          {done ? null : <Button type="button" loading={busy} onClick={() => void submit()}>Send report</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
