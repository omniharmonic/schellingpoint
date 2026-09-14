'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowUpRight, Loader2 } from 'lucide-react'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { STATUS_INFO } from '@/lib/events/lifecycle'
import type { EventStatus } from '@/types/event'
import { BasicsSection } from './_components/BasicsSection'
import { DatesSection } from './_components/DatesSection'
import { ParticipationSection } from './_components/ParticipationSection'
import { VotingSection } from './_components/VotingSection'
import { BrandingSection } from './_components/BrandingSection'
import { LifecycleSection } from './_components/LifecycleSection'
import { DangerZone } from './_components/DangerZone'

const SECTIONS = [
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'basics', label: 'Basics' },
  { id: 'dates', label: 'Dates' },
  { id: 'participation', label: 'Participation' },
  { id: 'voting', label: 'Voting' },
  { id: 'branding', label: 'Branding' },
]

export default function EventSettingsPage() {
  const event = useEvent()
  const { can, isOwner, isLoading } = useEventRole()
  const { user, isLoading: authLoading } = useAuth()
  // The phase drives which lifecycle moves and danger-zone actions are offered.
  // It is updated straight from the save response, then confirmed by the refreshed layout.
  const [status, setStatus] = React.useState<EventStatus>(event.status)
  React.useEffect(() => { setStatus(event.status) }, [event.status])

  if (isLoading || authLoading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div>
  if (!user || !can('editEventSettings')) return <Card><CardContent className="p-8"><h1 className="text-2xl font-semibold mb-3">Organizer access required</h1><p className="text-muted-foreground mb-5">Only this event’s owner and admins can change these settings.</p><Button asChild variant="outline"><Link href={`/e/${event.slug}`}>Return to the gathering</Link></Button></CardContent></Card>

  return <div className="max-w-4xl space-y-8">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-sm text-muted-foreground mb-2">Your gathering, your rhythm</p>
        <h1 className="text-4xl font-semibold">Event settings</h1>
        <p className="text-muted-foreground mt-3 max-w-xl">Currently <span className="font-medium text-foreground">{STATUS_INFO[status].label.toLowerCase()}</span>. Each section saves on its own.</p>
      </div>
      <Button variant="outline" asChild><Link href={`/e/${event.slug}`}>View event <ArrowUpRight className="h-4 w-4 ml-2" /></Link></Button>
    </div>
    <nav aria-label="Settings sections" className="-mx-1 overflow-x-auto">
      <ul className="flex gap-2 px-1 pb-1">
        {SECTIONS.map(section => <li key={section.id}><a href={`#${section.id}`} className="inline-block whitespace-nowrap rounded-full border bg-card px-3 py-1.5 text-sm hover:border-primary hover:text-primary">{section.label}</a></li>)}
        {isOwner ? <li><a href="#danger" className="inline-block whitespace-nowrap rounded-full border border-destructive/40 bg-card px-3 py-1.5 text-sm text-destructive hover:bg-destructive/5">Danger zone</a></li> : null}
      </ul>
    </nav>
    <LifecycleSection event={event} status={status} onChanged={setStatus} />
    <BasicsSection event={event} />
    <DatesSection event={event} />
    <ParticipationSection event={event} />
    <VotingSection event={event} />
    <BrandingSection event={event} />
    {isOwner ? <DangerZone event={event} status={status} /> : null}
  </div>
}
