'use client'

/**
 * A small non-interactive map with one pin for the session page (spec §8.4). `coarse` draws an
 * approximate area instead of a point: what a non-attendee sees for a self-hosted session.
 */
import * as React from 'react'
import { GatheringMap, type MapPin } from './GatheringMap'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'
import { cn } from '@/lib/utils'

export interface StaticVenueMapProps {
  lat: number
  lng: number
  label: string
  coarse?: boolean
  className?: string
}

export function StaticVenueMap({ lat, lng, label, coarse = false, className }: StaticVenueMapProps) {
  const pins = React.useMemo<MapPin[]>(() => [{ id: 'here', lat, lng, label, kind: coarse ? 'coarse' : 'venue' }], [lat, lng, label, coarse])
  const view = React.useMemo(() => ({ center: [lng, lat] as [number, number], zoom: coarse ? 13 : 15 }), [lat, lng, coarse])
  return (
    <div className={cn('h-40 w-full overflow-hidden rounded-lg border', className)}>
      <GatheringMap pins={pins} view={view} interactive={false} fitToPins={false} fallback={null} />
    </div>
  )
}

/**
 * The session's location map by tier, or nothing: a venue's point (a private residence's only
 * with attendee details), a self-hosted session's exact point for attendees or its ≈1 km area.
 */
export function SessionLocationMap({ session, className }: { session: Pick<SessionView, 'is_self_hosted' | 'location_geo' | 'venue' | 'title'>; className?: string }) {
  if (session.is_self_hosted) {
    const geo = session.location_geo
    if (!geo) return null
    return (
      <div className={className}>
        <StaticVenueMap lat={geo.lat} lng={geo.lng} label={session.title} coarse={!geo.exact} />
        {!geo.exact && <p className="mt-1 text-xs text-muted-foreground">Approximate area · the exact spot is shared with confirmed attendees.</p>}
      </div>
    )
  }
  const geo = session.venue?.geo
  if (!geo || !session.venue) return null
  return (
    <div className={className}>
      <StaticVenueMap lat={geo.lat} lng={geo.lng} label={session.venue.name} />
    </div>
  )
}
