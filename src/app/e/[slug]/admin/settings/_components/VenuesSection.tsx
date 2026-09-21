'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, Map } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Event } from '@/types/event'
import { SectionCard } from './SectionCard'

/** Rooms and time slots have their own page; the map is not built yet, and this says so. */
export function VenuesSection({ event }: { event: Event }) {
  return <SectionCard id="venues" title="Venues & map" description="Where sessions happen and how people find their way between rooms.">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium">Spaces & times</p>
        <p className="mt-1 text-sm text-muted-foreground">Rooms, capacities and the slot grid live on their own page, since they change while the program takes shape.</p>
      </div>
      <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/setup`}>Open Spaces & times<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Link></Button>
    </div>
    <div className="flex gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
      <Map className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>A map of the venues arrives in a later release. There is nothing to set up for it yet; room names and addresses you enter under Spaces & times will carry over.</p>
    </div>
  </SectionCard>
}
