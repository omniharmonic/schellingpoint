'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import type { Event, VotingMechanism } from '@/types/event'
import { SectionCard, SaveBar, Field, ChoiceCard } from './SectionCard'
import { useSectionSave, toEventLocal } from './shared'
import { VOTING_MECHANISMS } from './constants'

export function VotingSection({ event }: { event: Event }) {
  const { state, save } = useSectionSave(event.id)
  const [credits, setCredits] = React.useState(event.voteCreditsPerUser)
  const [mechanism, setMechanism] = React.useState<VotingMechanism>(event.votingMechanism)
  const [opensAt, setOpensAt] = React.useState(() => toEventLocal(event.votingOpensAt, event.timezone))
  const [closesAt, setClosesAt] = React.useState(() => toEventLocal(event.votingClosesAt, event.timezone))
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)

  React.useEffect(() => {
    setOpensAt(toEventLocal(event.votingOpensAt, event.timezone))
    setClosesAt(toEventLocal(event.votingClosesAt, event.timezone))
  }, [event.timezone, event.votingOpensAt, event.votingClosesAt])

  return <SectionCard id="voting" title="Voting" description="How attendees spend their credits, and when the polls are open."
    onSubmit={() => save({ vote_credits_per_user: credits, voting_mechanism: mechanism, voting_opens_at: opensAt || null, voting_closes_at: closesAt || null }, 'Voting settings saved.')}
    footer={<SaveBar state={state} disabled={!Number.isInteger(credits) || credits <= 0} />}>
    <Field label="Credits per attendee" htmlFor="vote-credits" hint="Changing this only affects members who join afterwards." error={fieldError('vote_credits_per_user')}>
      <Input id="vote-credits" type="number" min={1} value={credits} onChange={e => { const v = parseInt(e.target.value, 10); setCredits(Number.isNaN(v) ? 0 : v) }} className="max-w-[160px]" error={!!fieldError('vote_credits_per_user')} />
    </Field>
    <div role="radiogroup" aria-label="Voting method" className="space-y-3">
      <p className="text-sm font-medium">Voting method</p>
      {VOTING_MECHANISMS.map(option => <ChoiceCard key={option.value} selected={mechanism === option.value} onSelect={() => setMechanism(option.value)} label={option.label} description={option.description} />)}
      {fieldError('voting_mechanism') ? <p className="text-xs text-destructive" role="alert">{fieldError('voting_mechanism')}</p> : null}
    </div>
    <div>
      <p className="text-sm font-medium mb-1">Voting window</p>
      <p className="text-xs text-muted-foreground mb-3">Times are in {event.timezone}. Voting also needs the phase to be “Voting open”.</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Opens" htmlFor="voting-open" error={fieldError('voting_opens_at')}>
          <Input id="voting-open" type="datetime-local" value={opensAt} onChange={e => setOpensAt(e.target.value)} error={!!fieldError('voting_opens_at')} />
        </Field>
        <Field label="Closes" htmlFor="voting-close" error={fieldError('voting_closes_at')}>
          <Input id="voting-close" type="datetime-local" value={closesAt} onChange={e => setClosesAt(e.target.value)} error={!!fieldError('voting_closes_at')} />
        </Field>
      </div>
    </div>
  </SectionCard>
}
