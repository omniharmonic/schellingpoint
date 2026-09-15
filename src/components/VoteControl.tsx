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
  const errorNote =
    acted && voting.error ? (
      <p role="alert" className={cn('text-xs text-destructive', compact ? 'max-w-[14rem] text-right' : 'max-w-[18rem]')}>
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
          aria-describedby={note || (!affordable && !approved) ? describedBy : undefined}
          disabled={disabled}
          aria-busy={busy || undefined}
          onClick={(e) => {
            stop(e)
            setVotes(approved ? 0 : 1)
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : approved ? <Check className="h-4 w-4" aria-hidden /> : null}
          <span className={busy || approved ? 'ml-1.5' : undefined}>{approved ? 'Approved' : 'Approve'}</span>
        </Button>
        {(note || (!approved && !affordable && voting.canVote)) && (
          <p id={describedBy} className="text-xs text-muted-foreground max-w-[16rem]">
            {note ?? `No approvals left (${voting.budget} used).`}
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
        <div className={cn('text-center tabular-nums', compact ? 'min-w-[2.5rem]' : 'min-w-[3.5rem]')}>
          <output aria-live="polite" aria-label={`${votes} ${votes === 1 ? 'vote' : 'votes'}${name}`} className={cn('block font-bold text-primary', compact ? 'text-base' : 'text-xl')}>
            {votes}
          </output>
          {!compact && (
            <span className="block text-xs text-muted-foreground">
              {voteCost(votes, mechanism)} {voteCost(votes, mechanism) === 1 ? 'credit' : 'credits'}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size={compact ? 'icon-sm' : 'icon'}
          aria-label={`Add a vote${name}${canAdd ? ` (costs ${nextCost} ${nextCost === 1 ? 'credit' : 'credits'})` : ''}`}
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
        <p id={describedBy} className={cn('text-xs text-muted-foreground', compact ? 'max-w-[14rem] text-right' : 'max-w-[18rem]')}>
          {note}
        </p>
      )}
      {errorNote}
    </div>
  )
}
