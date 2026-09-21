'use client'

/**
 * `<VoteControl eventSlug sessionId compact? />` — the only way anyone casts a vote (plan §7.2).
 *
 * Shows the viewer's OWN votes for one session, what they cost ("3 votes = 9 credits"), and
 * what the next vote would cost. Never shows anyone else's votes or any total. When voting
 * is not possible — signed out, window not open, not eligible, out of credits — the buttons
 * are disabled and the reason is written next to them.
 *
 * Safe inside a link or a clickable card: clicks do not propagate. Buttons stay enabled while
 * a write is in flight (writes are queued in order), so keyboard focus is never dropped.
 */
import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, Loader2, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVoting } from '@/hooks/useVoting'
import { costLabel, maxVotesFor, voteCost } from '@/lib/voting/mechanism'
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
}

function stop(e: React.SyntheticEvent) {
  e.preventDefault()
  e.stopPropagation()
}

/** One width for the helper text under the control, in both layouts. */
const NOTE_WIDTH = 'max-w-[16rem]'

export function VoteControl({ eventSlug, sessionId, compact = false, className, sessionTitle }: VoteControlProps) {
  const voting = useVoting(eventSlug)
  const pathname = usePathname()
  const describedBy = React.useId()
  const votes = voting.allocation[sessionId] ?? 0
  const mechanism = voting.mechanism ?? 'quadratic'
  const busy = voting.pending.has(sessionId)
  const name = sessionTitle ? ` for ${sessionTitle}` : ''

  const nextCost = voteCost(votes + 1, mechanism) - voteCost(votes, mechanism)
  const atMax = votes >= maxVotesFor(mechanism)
  const affordable = nextCost <= voting.remaining
  const canAdd = voting.canVote && !atMax && affordable
  const canRemove = voting.canVote && votes > 0

  let note: React.ReactNode = null
  if (voting.loading) {
    note = null
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
  const setVotes = (value: number) => {
    setActed(true)
    void voting.setVotes(sessionId, value)
  }
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
            setVotes(approved ? 0 : 1)
          }}
        >
          <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center" aria-hidden>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : approved ? <Check className="h-4 w-4" /> : null}
          </span>
          {approved ? 'Approved' : 'Approve'}
        </Button>
        {note && (
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
          disabled={!canAdd}
          aria-busy={busy || undefined}
          onClick={(e) => {
            stop(e)
            setVotes(votes + 1)
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
      {note && (
        <p id={describedBy} className={noteClass}>
          {note}
        </p>
      )}
      {errorNote}
    </div>
  )
}
