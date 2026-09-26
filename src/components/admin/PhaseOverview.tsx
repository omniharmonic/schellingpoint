'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useEvent } from '@/contexts/EventContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { getNextValidStatuses, getTransitionLabel, STATUS_INFO } from '@/lib/events/lifecycle'
import { eventStatusBadge } from '@/lib/labels'
import { useSectionSave } from '@/app/e/[slug]/admin/settings/_components/shared'
import { SaveFeedback } from '@/app/e/[slug]/admin/settings/_components/SectionCard'

/** The clock and the phase are different controls; explain both where organizers start. */
export function PhaseOverview() {
  const event = useEvent()
  const { save, state } = useSectionSave(event.id)
  const [confirm, setConfirm] = useState(false)
  const next = getNextValidStatuses(event.status)[0]
  const phase = eventStatusBadge(event.status)
  const date = (value: Date | null) => value ? new Date(value).toLocaleString('en-US', { timeZone: event.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  const settings = `/e/${event.slug}/admin/settings`
  return <section aria-labelledby="phase-overview-title" className="rounded-2xl border bg-card p-5 sm:p-6">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="max-w-2xl">
        <div className="flex flex-wrap items-center gap-3"><h2 id="phase-overview-title" className="text-lg font-semibold">Your gathering, right now</h2><Badge variant={phase.badge}>{phase.label}</Badge></div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{STATUS_INFO[event.status].description}. {event.autoLifecycle ? 'Automatic phase changes are on. Due dates are checked every five minutes; publishing still needs your approval.' : 'Phase changes are manual. Dates limit when people can participate, but do not open the next phase. Use the action here, or turn on automatic phase changes.'}</p>
      </div>
      <div className="flex flex-wrap gap-2 xl:justify-end">
        {next && <Button onClick={() => setConfirm(true)} disabled={state.status === 'saving'}>{getTransitionLabel(event.status, next)}</Button>}
        <Button variant="outline" asChild><Link href={`${settings}#lifecycle`}>Phase settings</Link></Button>
      </div>
    </div>
    {confirm && next && <ConfirmInline className="mt-4" confirmLabel={getTransitionLabel(event.status, next)} loading={state.status === 'saving'}
      message={event.status === 'draft' ? 'Publish this gathering? Its public records go on the network and copies may remain.' : `Move to ${eventStatusBadge(next).label.toLowerCase()} now? This changes what participants can do. ${event.status === 'voting_open' ? 'Closing voting seals ballots and releases results.' : ''}`}
      onCancel={() => setConfirm(false)} onConfirm={async () => { if (await save({ status: next }, 'Phase updated.')) setConfirm(false) }} />}
    <dl className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2 xl:grid-cols-3">
      <div><dt className="text-sm font-medium">Proposals</dt><dd className="mt-1 text-sm text-muted-foreground">{date(event.proposalsOpenAt) || 'Opens with the phase'}<br />{event.proposalsClosesAt ? `Closes ${date(event.proposalsClosesAt)}` : 'No closing date'}</dd><Link href={`${settings}#participation`} className="mt-2 inline-block text-sm text-primary underline underline-offset-4">Edit proposal dates</Link></div>
      <div><dt className="text-sm font-medium">Voting</dt><dd className="mt-1 text-sm text-muted-foreground">{date(event.votingOpensAt) || 'Opens with the phase'}<br />{event.votingClosesAt ? `Closes ${date(event.votingClosesAt)}` : 'No closing date'}</dd><Link href={`${settings}#voting`} className="mt-2 inline-block text-sm text-primary underline underline-offset-4">Edit voting dates</Link></div>
      <div><dt className="text-sm font-medium">All times in</dt><dd className="mt-1 break-words text-sm text-muted-foreground">{event.timezone.replaceAll('_', ' ')}</dd><Link href={`${settings}#dates`} className="mt-2 inline-block text-sm text-primary underline underline-offset-4">Event dates & timezone</Link></div>
    </dl>
    {state.status !== 'idle' && <div className="mt-4"><SaveFeedback state={state} /></div>}
  </section>
}
