'use client'

/**
 * "Map" card on Spaces & times (spec §8.3): the organizer sets the map area and places rooms.
 * Saves go through the venues admin API (latitude/longitude/geocoded_from) and the event
 * settings route (`map`).
 */
import * as React from 'react'
import { Map as MapIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import type { AdminVenue } from '@/components/admin/types'
import { VenueMapEditor } from '@/components/map/VenueMapEditor'
import type { MapView } from '@/components/map/types'

export interface VenueMapCardProps {
  venues: AdminVenue[]
  /** Admin API base for this event (`/api/v1/events/<slug>/admin`). */
  base: string
  canManage: boolean
  /** Re-read the room list after a pin changes. */
  onChanged: () => Promise<void>
}

export function VenueMapCard({ venues, base, canManage, onChanged }: VenueMapCardProps) {
  const event = useEvent()
  const { toast } = useToast()
  const [view, setView] = React.useState<MapView | null>(event.map ?? null)

  const saveView = async (next: MapView) => {
    await apiFetch(`/api/events/${event.id}/settings`, { method: 'PATCH', json: { map: next } })
    setView(next)
    toast({ title: 'Map area saved.', variant: 'success' })
  }

  const placeVenue = async (venueId: string, point: { lat: number; lng: number; geocoded_from: string | null } | null) => {
    await apiFetch(`${base}/venues/${venueId}`, {
      method: 'PATCH',
      json: point ? { latitude: point.lat, longitude: point.lng, geocoded_from: point.geocoded_from } : { latitude: null, longitude: null, geocoded_from: null },
    })
    await onChanged()
    toast({ title: point ? 'Room placed on the map.' : 'Pin removed.', variant: 'success' })
  }

  if (venues.length === 0) return null

  return (
    <Card id="venue-map">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><MapIcon className="h-5 w-5" aria-hidden />Map</CardTitle>
      </CardHeader>
      <CardContent>
        <VenueMapEditor
          eventSlug={event.slug}
          venues={venues}
          view={view}
          canManage={canManage}
          onSaveView={saveView}
          onPlaceVenue={placeVenue}
          seedAddress={[event.locationName, event.locationAddress].filter(Boolean).join(', ') || null}
        />
      </CardContent>
    </Card>
  )
}
