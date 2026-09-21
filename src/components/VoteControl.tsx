'use client'

/**
 * `<VoteControl eventSlug sessionId compact? round? />` — the only way anyone casts a vote (plan §7.2).
 *
 * Shows the viewer's OWN votes for one session, what they cost ("3 votes = 9 credits"), and
 * what the next vote would cost. Never shows anyone else's votes or any total. When voting
 * is not possible — signed out, window not open, not eligible, out of credits — the buttons
 * are disabled and the reason is written next to them.
 *
 * `round="attendance"` is the during-event tap-to-vote (design §11, PRD §4.6): the session
 * must be inside its slot ± 15 min (the server decides), and when one more vote would leave
 * less than a quarter of the fresh budget, an inline confirmation asks first
 * ("Vote anyway" / "Save credits").
 *
 * Safe inside a link or a clickable card: clicks do not propagate. Buttons stay enabled while
 * a write is in flight (writes are queued in order), so keyboard focus is never dropped.
 */
import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, Loader2, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useVoting } from '@/hooks/useVoting'
import { ATTENDANCE_GRACE_MINUTES, costLabel, LOW_CREDIT_SHARE, maxVotesFor, voteCost, type RoundKey } from '@/lib/voting/mechanism'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface VoteControlProps {
  eventSlug: string
  sessionId: string
  /** A single-row control for cards and lists. */
  compact?: boolean
  className?: string
  /** Accessible name of the session, e.g. its title, used in button labels. */
  sessionTitle?: string
  /** Which round to vote in: the pre-event round (default) or the attendance round. */
  round?: RoundKey
}

function stop(e: React.SyntheticEvent) {
  e.preventDefault()
  e.stopPropagation()
}

/** One width for the helper text under the control, in both layouts. */
const NOTE_WIDTH = 'max-w-[16rem]'

export function VoteControl({ eventSlug, sessionId, compact = false, className, sessionTitle, round = 'pre' }: VoteControlProps) {
  const voting = useVoting(eventSlug, round)
  const pathname = usePathname()
  const describedBy = React.useId()
  const votes = voting.allocation[sessionId] ?? 0
  const mechanism = voting.mechanism ?? 'quadratic'
  const busy = voting.pending.has(sessionId)
  const name = sessionTitle ? ` for ${sessionTitle}` : ''
  const attendance = round === 'attendance'

  const nextCost = voteCost(votes + 1, mechanism) - voteCost(votes, mechanism)
  const atMax = votes >= maxVotesFor(mechanism)
  const affordable = nextCost <= voting.remaining
  // Attendance votes name only what is happening (the server enforces the same window).
  const happening = !attendance || voting.votableNow.has(sessionId)
  const canAdd = voting.canVote && !atMax && affordable && happening
  const canRemove = voting.canVote && votes > 0
  // PRD §4.6: below a quarter of the fresh budget, one more attendance vote asks first.
  const leftAfter = voting.remaining - nextCost
  const needsConfirm = attendance && voting.budget > 0 && leftAfter < voting.budget * LOW_CREDIT_SHARE

  let note: React.ReactNode = null
  if (voting.loading) {
    note = null
  } else if (voting.signedIn && voting.canVote && attendance && !happening) {
    note = `Attendance votes open ${ATTENDANCE_GRACE_MINUTES} minutes before a session starts and close ${ATTENDANCE_GRACE_MINUTES} minutes after it ends.`
  } else if (!voting.signedIn) {
    note =
      voting.status === 'open' ? (
        <Link
          href={`/login?returnTo=${encodeURIComponent(pathname || `/e/${eventSlug}/sessions`)}`}
          className="underline underline-offset-2 hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          Sign in to vote
        </Link>
      ) : (
        voting.reason
      )
  } else if (!voting.canVote) {
    note = voting.reason ?? 'Voting is not open right now.'
  } else if (mechanism === 'approval' && votes === 0 && !affordable) {
    note = `No approvals left (${voting.budget} used).`
  } else if (mechanism !== 'approval' && !atMax && !affordable) {
    note = `Not enough credits for another vote (needs ${nextCost}, ${voting.remaining} left).`
  } else if (mechanism !== 'approval') {
    note = votes > 0 ? `${costLabel(votes, mechanism)} · next vote costs ${nextCost}` : `First vote costs ${nextCost}`
  }

  // Show a refusal next to the control that caused it, not on every card.
  const [acted, setActed] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const setVotes = (value: number) => {
    setActed(true)
    setConfirming(false)
    void voting.setVotes(sessionId, value)
  }
  const addVote = () => {
    if (needsConfirm) setConfirming(true)
    else setVotes(votes + 1)
  }
  const confirmBox = confirming ? (
    <ConfirmInline
      className={cn(NOTE_WIDTH, 'w-full')}
      message={`You have ${plural(voting.remaining, 'credit')} remaining. Adding another vote here costs ${plural(nextCost, 'credit')}. You'll have ${plural(Math.max(0, leftAfter), 'credit')} left for the sessions still to come.`}
      confirmLabel="Vote anyway"
      cancelLabel="Save credits"
      loading={busy}
      onConfirm={() => setVotes(votes + 1)}
      onCancel={() => setConfirming(false)}
    />
  ) : null
  const noteClass = cn('text-xs text-muted-foreground', NOTE_WIDTH, compact && 'text-right')
  const errorNote =
    acted && voting.error ? (
      <p role="alert" className={cn('text-xs text-destructive', NOTE_WIDTH, compact && 'text-right')}>
        {voting.error}
      </p>
    ) : null

  if (mechanism === 'approval') {
    const approved = votes > 0
    const disabled = !voting.canVote || (!approved && !affordable)
    return (
      <div
        role="group"
        aria-label={`Your approval${name}`}
        className={cn('flex flex-col gap-1', compact ? 'items-end' : 'items-start', className)}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          type="button"
          size={compact ? 'sm' : 'default'}
          variant={approved ? 'default' : 'outline'}
          aria-pressed={approved}
          aria-describedby={note ? describedBy : undefined}
          disabled={disabled}
          aria-busy={busy || undefined}
          onClick={(e) => {
            stop(e)
            if (approved) setVotes(0)
            else addVote()
          }}
        >
          <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center" aria-hidden>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : approved ? <Check className="h-4 w-4" /> : null}
          </span>
          {approved ? 'Approved' : 'Approve'}
        </Button>
        {confirmBox}
        {note && !confirming && (
          <p id={describedBy} className={noteClass}>
            {note}
          </p>
        )}
        {errorNote}
      </div>
    )
  }

  return (
    <div
      role="group"
      aria-label={`Your votes${name}`}
      className={cn('flex flex-col gap-1', compact ? 'items-end' : 'items-start', className)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size={compact ? 'icon-sm' : 'icon'}
          aria-label={`Remove a vote${name}`}
          aria-describedby={note ? describedBy : undefined}
          disabled={!canRemove}
          onClick={(e) => {
            stop(e)
            setVotes(votes - 1)
          }}
        >
          <Minus className="h-4 w-4" aria-hidden />
        </Button>
        <div className="min-w-[3rem] text-center tabular-nums">
          <output aria-live="polite" aria-label={`${plural(votes, 'vote')}${name}`} className={cn('block font-bold text-primary', compact ? 'text-base' : 'text-xl')}>
            {votes}
          </output>
          {!compact && (
            <span className="block text-xs text-muted-foreground">{plural(voteCost(votes, mechanism), 'credit')}</span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size={compact ? 'icon-sm' : 'icon'}
          aria-label={`Add a vote${name}${canAdd ? ` (costs ${plural(nextCost, 'credit')})` : ''}`}
          aria-describedby={note ? describedBy : undefined}
          disabled={!canAdd || confirming}
          aria-busy={busy || undefined}
          onClick={(e) => {
            stop(e)
            addVote()
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
      {confirmBox}
      {note && !confirming && (
        <p id={describedBy} className={noteClass}>
          {note}
        </p>
      )}
      {errorNote}
    </div>
  )
}
