'use client'

/**
 * How many credits the viewer has left in a round, as a label and a bar.
 *
 * It renders nothing at all unless the viewer is signed in and the round is open — so a caller
 * can place it unconditionally and it appears only while it has something to say. No counts, no
 * totals, no other person's spend: a gauge of the viewer's own budget and nothing else.
 *
 * Mobile shell (design §2.5): the gauge left the nav drawer with the drawer. It now lives in the
 * More sheet's header and in Home's Now line; on desktop it stays in the sidebar footer.
 */

import * as React from 'react'
import { Progress } from '@/components/ui/progress'
import { useVoting } from '@/hooks/useVoting'
import { cn } from '@/lib/utils'

export interface CreditGaugeProps {
  eventSlug: string
  /** `pre` is the proposal round; `attendance` is the live round, gauged only while it accepts votes. */
  round?: 'pre' | 'attendance'
  className?: string
}

export function CreditGauge({ eventSlug, round = 'pre', className }: CreditGaugeProps) {
  const voting = useVoting(eventSlug, round)
  // The attendance gauge (design §11) shows only while that round accepts votes.
  if (!voting.signedIn || voting.status !== 'open' || voting.loading) return null
  if (round === 'attendance' && !voting.canVote) return null
  const { budget, spent, remaining, mechanism } = voting
  const pct = budget > 0 ? (remaining / budget) * 100 : 0
  const noun = round === 'attendance' ? 'Attendance credits' : mechanism === 'approval' ? 'Approvals' : 'Voting credits'
  const gaugeId = `credit-gauge-${round}-${eventSlug}`

  return (
    <div className={cn('px-4 py-3 border-t border-border', className)}>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs text-muted-foreground" id={gaugeId}>
          {noun}
        </span>
        <span className="text-sm font-bold tabular-nums text-primary">
          {remaining}<span className="text-muted-foreground font-normal">/{budget}</span>
        </span>
      </div>
      <Progress value={pct} className="h-1.5" aria-labelledby={gaugeId} aria-valuetext={`${remaining} of ${budget} left, ${spent} used`} />
      <p className="text-xs text-muted-foreground mt-1">
        {round === 'attendance' ? 'Fresh credits for the sessions you attend.' : voting.canVote ? 'Support the ideas you want to see.' : voting.reason}
      </p>
    </div>
  )
}
