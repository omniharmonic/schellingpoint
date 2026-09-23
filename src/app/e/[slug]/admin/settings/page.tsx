'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowUpRight, Loader2 } from 'lucide-react'
import { useEvent, useEventNetwork, useEventRole } from '@/contexts/EventContext'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { eventStatusBadge } from '@/lib/labels'
import { DEFAULT_POLICY_THRESHOLDS } from '@/lib/events/policy'
import { cn } from '@/lib/utils'
import type { EventStatus } from '@/types/event'
import { BasicsSection } from './_components/BasicsSection'
import { DatesSection } from './_components/DatesSection'
import { VenuesSection } from './_components/VenuesSection'
import { ParticipationSection } from './_components/ParticipationSection'
import { VotingSection } from './_components/VotingSection'
import { SafeguardsSection } from './_components/SafeguardsSection'
import { BrandingSection } from './_components/BrandingSection'
import { ImagesSection } from './_components/ImagesSection'
import { FeedNetworkSection } from './_components/FeedNetworkSection'
import { LifecycleSection } from './_components/LifecycleSection'
import { CloneSection } from './_components/CloneSection'
import { DangerZone } from './_components/DangerZone'
import { SETTINGS_SECTIONS } from './_components/labels'

/**
 * Which section is under the reader: the first section (in page order) that crosses the
 * band just below the sticky header. `aria-current="location"` goes on its pill.
 */
function useScrollSpy(ids: readonly string[]): string | null {
  const [active, setActive] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const elements = ids.map(id => document.getElementById(id)).filter((el): el is HTMLElement => !!el)
    if (!elements.length) return
    const visible = new Set<string>()
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id)
        else visible.delete(entry.target.id)
      }
      const first = ids.find(id => visible.has(id))
      if (first) setActive(first)
    }, { rootMargin: '-96px 0px -55% 0px', threshold: 0 })
    elements.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [ids])
  return active
}

const SECTION_IDS: readonly string[] = SETTINGS_SECTIONS.map(section => section.id)
const NO_SECTIONS: readonly string[] = []

export default function EventSettingsPage() {
  const event = useEvent()
  const network = useEventNetwork()
  const { can, isOwner, isLoading } = useEventRole()
  const { user, isLoading: authLoading } = useAuth()
  // The phase drives which lifecycle moves and danger-zone actions are offered.
  // It is updated straight from the save response, then confirmed by the refreshed layout.
  const [status, setStatus] = React.useState<EventStatus>(event.status)
  React.useEffect(() => { setStatus(event.status) }, [event.status])
  const allowed = Boolean(user) && can('editEventSettings')
  const active = useScrollSpy(allowed && !isLoading && !authLoading ? SECTION_IDS : NO_SECTIONS)

  if (isLoading || authLoading) {
    return <div className="flex justify-center py-20" role="status" aria-label="Loading settings"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }
  if (!allowed) {
    return <div className="max-w-4xl">
      <Card><CardContent className="p-6 sm:p-8">
        <h1 className="page-title mb-3">Organizer access required</h1>
        <p className="mb-5 text-muted-foreground">Only this gathering’s owner and admins can change these settings.</p>
        <Button asChild variant="outline"><Link href={`/e/${event.slug}`}>Gathering page</Link></Button>
      </CardContent></Card>
    </div>
  }

  return <div className="max-w-4xl space-y-8">
    <PageHeader
      title="Settings"
      subtitle={<>Currently <span className="font-medium text-foreground">{eventStatusBadge(status).label.toLowerCase()}</span>. Each section saves on its own.</>}
      actions={<Button variant="outline" asChild><Link href={`/e/${event.slug}`}>Gathering page<ArrowUpRight className="ml-2 h-4 w-4" aria-hidden="true" /></Link></Button>}
      className="mb-0"
    />
    <nav aria-label="Settings sections" className="-mx-1 overflow-x-auto">
      <ul className="flex gap-2 px-1 pb-1">
        {SETTINGS_SECTIONS.map(section => {
          const current = active === section.id
          return <li key={section.id}>
            <a href={`#${section.id}`} aria-current={current ? 'location' : undefined}
              className={cn('inline-flex min-h-10 items-center whitespace-nowrap rounded-full border px-3.5 text-sm transition-colors', current ? 'border-primary bg-primary/10 font-medium text-primary' : 'bg-card hover:border-primary hover:text-primary')}>
              {section.label}
            </a>
          </li>
        })}
      </ul>
    </nav>
    <BasicsSection event={event} />
    <DatesSection event={event} />
    <VenuesSection event={event} />
    <ParticipationSection event={event} />
    <VotingSection event={event} />
    <SafeguardsSection event={event} thresholds={network?.thresholds ?? DEFAULT_POLICY_THRESHOLDS} />
    <BrandingSection event={event} />
    <ImagesSection event={event} />
    <React.Suspense fallback={null}><FeedNetworkSection event={event} network={network} /></React.Suspense>
    <LifecycleSection event={event} status={status} onChanged={setStatus} hasIdentity={Boolean(network?.did)} />
    <CloneSection event={event} />
    {isOwner ? <div className="border-t pt-8"><DangerZone event={event} status={status} published={Boolean(network?.publishedAt)} /></div> : null}
  </div>
}
