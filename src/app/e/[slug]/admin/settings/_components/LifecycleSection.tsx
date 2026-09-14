'use client'

import * as React from 'react'
import { ArrowRight, Check, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { STATUS_INFO, getNextValidStatuses, getTransitionLabel, isIrreversibleTransition } from '@/lib/events/lifecycle'
import type { Event, EventStatus } from '@/types/event'
import { SectionCard } from './SectionCard'
import { useSectionSave } from './shared'

interface LifecycleSectionProps {
  event: Event
  status: EventStatus
  onChanged: (status: EventStatus) => void
}

export function LifecycleSection({ event, status, onChanged }: LifecycleSectionProps) {
  const { state, save } = useSectionSave(event.id)
  const [pending, setPending] = React.useState<EventStatus | null>(null)
  const transitions = getNextValidStatuses(status)
  const info = STATUS_INFO[status]

  const move = async (to: EventStatus) => {
    setPending(null)
    const result = await save({ status: to }, saved => to === 'voting_open'
      ? `Voting is open. ${saved.notified} member${saved.notified === 1 ? '' : 's'} notified.`
      : `Now ${STATUS_INFO[to].label.toLowerCase()}.`)
    if (result) onChanged(result.event.status)
  }

  return <SectionCard id="lifecycle" title="Lifecycle" description="Open each phase when your community is ready. Every move takes effect immediately.">
    <div className="flex items-start gap-3 rounded-xl border bg-secondary/50 p-4">
      <span className={cn('mt-1.5 h-3 w-3 shrink-0 rounded-full', info.color)} aria-hidden="true" />
      <div><p className="text-xs text-muted-foreground">Current phase</p><p className="text-2xl font-semibold">{info.label}</p><p className="text-sm text-muted-foreground mt-1">{info.description}</p></div>
    </div>
    <div className="text-sm" aria-live="polite">
      {state.status === 'error' ? <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />{state.message}</p>
        : state.status === 'saved' ? <p className="flex items-center gap-2 text-primary"><Check className="h-4 w-4" />{state.message}</p> : null}
    </div>
    {transitions.length ? <ul className="space-y-3">
      {transitions.map(next => {
        const confirming = pending === next
        const needsConfirm = isIrreversibleTransition(next)
        return <li key={next} className={cn('rounded-xl border p-4', confirming && 'border-primary bg-primary/5')}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium flex items-center gap-2"><ArrowRight className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />{getTransitionLabel(status, next)}</p>
              <p className="text-sm text-muted-foreground mt-1">{STATUS_INFO[next].description}.{next === 'voting_open' ? ' Every member is notified that voting is open.' : ''}{needsConfirm ? ' This cannot be undone from here.' : ''}</p>
            </div>
            {confirming ? <div className="flex gap-2">
              <Button type="button" size="sm" variant={next === 'archived' ? 'destructive' : 'default'} disabled={state.status === 'saving'} onClick={() => move(next)}>{state.status === 'saving' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}Confirm</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            </div> : <Button type="button" size="sm" variant={next === 'archived' ? 'outline' : 'default'} disabled={state.status === 'saving'} onClick={() => needsConfirm ? setPending(next) : move(next)}>
              {state.status === 'saving' && !pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}{getTransitionLabel(status, next)}
            </Button>}
          </div>
        </li>
      })}
    </ul> : <p className="text-sm text-muted-foreground">This gathering is archived. No further phase changes are available.</p>}
  </SectionCard>
}
