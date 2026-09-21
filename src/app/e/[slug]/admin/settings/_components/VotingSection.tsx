'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { WarningBox } from '@/components/WarningBox'
import type { Event, VotingMechanism } from '@/types/event'
import { SectionCard, SaveBar, Field, ChoiceCard } from './SectionCard'
import { useSectionSave, toEventLocal, sameValue } from './shared'
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

  const patch = { vote_credits_per_user: credits, voting_mechanism: mechanism, voting_opens_at: opensAt || null, voting_closes_at: closesAt || null }
  const dirty = !sameValue(patch, {
    vote_credits_per_user: event.voteCreditsPerUser, voting_mechanism: event.votingMechanism,
    voting_opens_at: toEventLocal(event.votingOpensAt, event.timezone) || null, voting_closes_at: toEventLocal(event.votingClosesAt, event.timezone) || null,
  })
  const creditsChanged = Number.isInteger(credits) && credits > 0 && credits !== event.voteCreditsPerUser

  return <SectionCard id="voting" title="Voting" description="How attendees spend their credits, and when the polls are open."
    onSubmit={() => save(patch, 'Voting settings saved.')}
    footer={<SaveBar state={state} dirty={dirty} disabled={!Number.isInteger(credits) || credits <= 0} />}>
    <Field label="Credits per attendee" htmlFor="vote-credits" error={fieldError('vote_credits_per_user')}>
      <Input id="vote-credits" type="number" min={1} value={credits} onChange={e => { const v = parseInt(e.target.value, 10); setCredits(Number.isNaN(v) ? 0 : v) }} className="max-w-[160px]" error={!!fieldError('vote_credits_per_user')} />
    </Field>
    {creditsChanged ? <WarningBox title="Only new members get the new budget">
      Changing credits from {event.voteCreditsPerUser} to {credits} affects people who join afterwards. Everyone already in the gathering keeps the budget they have, including any votes they have spent.
    </WarningBox> : null}
    <div role="radiogroup" aria-labelledby="voting-method-label" className="space-y-3">
      <p id="voting-method-label" className="text-sm font-medium">Voting method</p>
      {VOTING_MECHANISMS.map(option => <ChoiceCard key={option.value} selected={mechanism === option.value} onSelect={() => setMechanism(option.value)} label={option.label} description={option.description} />)}
      {fieldError('voting_mechanism') ? <p className="text-xs text-destructive" role="alert">{fieldError('voting_mechanism')}</p> : null}
    </div>
    <div>
      <p className="mb-1 text-sm font-medium">Voting window (optional)</p>
      <p className="mb-3 text-xs text-muted-foreground">Times are in {event.timezone}. Voting also needs the phase to be “Voting open”.</p>
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
