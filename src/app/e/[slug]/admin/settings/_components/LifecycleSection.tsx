'use client'

import * as React from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { cn } from '@/lib/utils'
import { eventStatusBadge } from '@/lib/labels'
import { plural } from '@/lib/format'
import { STATUS_INFO, getNextValidStatuses, getTransitionLabel, isIrreversibleTransition } from '@/lib/events/lifecycle'
import type { Event, EventStatus } from '@/types/event'
import { SectionCard, SaveFeedback, Toggle } from './SectionCard'
import { useSectionSave } from './shared'

interface LifecycleSectionProps {
  event: Event
  status: EventStatus
  onChanged: (status: EventStatus) => void
  hasIdentity: boolean
}

export function LifecycleSection({ event, status, onChanged, hasIdentity }: LifecycleSectionProps) {
  const { state, save } = useSectionSave(event.id)
  const [pending, setPending] = React.useState<EventStatus | null>(null)
  const [moving, setMoving] = React.useState<EventStatus | null>(null)
  const [auto, setAuto] = React.useState(event.autoLifecycle)
  const [savingAuto, setSavingAuto] = React.useState(false)
  const transitions = getNextValidStatuses(status)
  const current = eventStatusBadge(status)
  const saving = state.status === 'saving'

  const move = async (to: EventStatus) => {
    setPending(null); setMoving(to)
    const result = await save({ status: to }, saved => to === 'voting_open'
      ? `Voting is open. ${plural(saved.notified, 'member')} notified.`
      : status === 'draft'
        ? `Now ${eventStatusBadge(to).label.toLowerCase()}. Its public records are on the network.`
        : `Now ${eventStatusBadge(to).label.toLowerCase()}.`)
    setMoving(null)
    if (result) onChanged(result.event.status)
  }

  // The clock (`/api/jobs/lifecycle`, every five minutes) moves the phase for you. It runs
  // exactly the code these buttons run, so members get the same notifications either way.
  const toggleAuto = async (next: boolean) => {
    setAuto(next)
    setSavingAuto(true)
    const result = await save({ auto_lifecycle: next }, next
      ? 'Phases will move on the dates you set.'
      : 'Phase changes are yours again.')
    if (!result) setAuto(!next)
    setSavingAuto(false)
  }

  const missing = [
    !event.proposalsOpenAt && 'a proposals-open time',
    !event.votingOpensAt && 'a voting-open time',
    !event.votingClosesAt && 'a voting-close time',
  ].filter(Boolean) as string[]

  return <SectionCard id="lifecycle" title="Lifecycle" description="Open each phase when your community is ready."
    footer={<SaveFeedback state={state} idleHint="Every phase change takes effect immediately." />}>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-secondary/50 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">Current phase</p>
        <p className="text-xl font-semibold">{current.label}</p>
        <p className="mt-1 text-sm text-muted-foreground">{STATUS_INFO[status].description}.</p>
      </div>
      <Badge variant={current.badge}>{current.label}</Badge>
    </div>
    <div className="space-y-3 rounded-xl border p-4">
      <Toggle id="auto-lifecycle" checked={auto} onChange={toggleAuto}
        label="Move through phases automatically on the dates I set"
        description="Proposals open at the proposals-open time, voting at the voting-open time, scheduling when voting closes, live on the first day, completed the day after the last. Everything a button here would do — the voting round, the attendance round, the announcements to members — happens the same way. Publishing the gathering stays yours." />
      {savingAuto ? <p className="text-xs text-muted-foreground" role="status">Saving…</p> : null}
      {auto && missing.length ? <p className="text-xs text-muted-foreground">
        A phase with no time set simply waits for you: this gathering still needs {missing.join(', ')} (set them under Dates and Voting).
      </p> : null}
    </div>
    {transitions.length ? <ul className="space-y-3">
      {transitions.map(next => {
        const confirming = pending === next
        const publishing = status === 'draft'
        const destructive = next === 'archived'
        const needsConfirm = isIrreversibleTransition(next) || publishing
        const action = getTransitionLabel(status, next)
        return <li key={next} className={cn('rounded-xl border p-4', confirming && 'border-primary bg-primary/5')}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium"><ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{eventStatusBadge(next).label}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {STATUS_INFO[next].description}.
                {next === 'voting_open' ? ' Every member is notified that voting is open.' : ''}
                {publishing ? ` This writes the gathering’s name, dates, description and rules as public records on the network${hasIdentity ? '' : ' (its network identity is created first)'}. Public records can be updated but not recalled.` : ''}
                {isIrreversibleTransition(next) ? ' This cannot be undone from here.' : ''}
              </p>
            </div>
            {!confirming ? <Button type="button" variant={destructive ? 'outline' : 'default'} className={cn(destructive && 'text-destructive hover:text-destructive')} disabled={saving && moving !== next} loading={moving === next}
              onClick={() => needsConfirm ? setPending(next) : move(next)}>{action}</Button> : null}
          </div>
          {confirming ? <ConfirmInline className="mt-3" layout="inline" destructive={destructive} loading={saving} confirmLabel={action}
            message={destructive ? 'Archive this gathering? It leaves discovery and no further phase changes are possible.' : publishing ? 'Publish now? Its public records go on the network and can be updated but not recalled.' : 'Go ahead? This cannot be undone from here.'}
            onConfirm={() => move(next)} onCancel={() => setPending(null)} /> : null}
        </li>
      })}
    </ul> : <p className="text-sm text-muted-foreground">This gathering is archived. No further phase changes are available.</p>}
  </SectionCard>
}
