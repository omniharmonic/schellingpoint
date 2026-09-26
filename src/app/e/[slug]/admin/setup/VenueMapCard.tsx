'use client'

/**
 * "Map" card on Spaces & times (spec §8.3, design §1): the organizer places rooms, overrides the map
 * area, draws outlines and puts a floor plan over (or instead of) the basemap.
 *
 * Saves go through the venues admin API (point, outline), the event settings route (`map`) and the
 * custom-map route (`custom_map`). None of those columns is ever published.
 *
 * Rooms geocode themselves after a save, so while any room says `pending` this card re-reads the
 * list every couple of seconds until the lookups have landed.
 */
import * as React from 'react'
import { Map as MapIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import type { CustomMap } from '@/lib/geo/custom-map'
import type { OutlinePolygon } from '@/lib/geo/outline'
import type { AdminVenue } from '@/components/admin/types'
import { VenueMapEditor } from '@/components/map/VenueMapEditor'
import type { MapView } from '@/components/map/types'

export interface VenueMapCardProps {
  venues: AdminVenue[]
  /** Admin API base for this event (`/api/v1/events/<slug>/admin`). */
  base: string
  canManage: boolean
  /** Re-read the room list after a pin, outline or lookup changes. */
  onChanged: () => Promise<void>
}

/** How long to keep re-reading while a background lookup is in flight (12 x 2.5 s = 30 s). */
const POLL_MS = 2_500
const POLL_LIMIT = 12

export function VenueMapCard({ venues, base, canManage, onChanged }: VenueMapCardProps) {
  const event = useEvent()
  const { toast } = useToast()
  const [view, setView] = React.useState<MapView | null>(event.map ?? null)
  const [customMap, setCustomMap] = React.useState<CustomMap | null>(null)
  const [canEditCustomMap, setCanEditCustomMap] = React.useState(false)
  const [customBlocked, setCustomBlocked] = React.useState<string | null>(null)

  // Which rooms are waiting, as a value that only changes when the answer does — a poll that
  // changes nothing leaves this identical, so the effect below is not torn down and rebuilt on
  // every tick, and the attempt count is not reset by one.
  const pendingKey = React.useMemo(
    () => venues.filter((v) => v.geocode_status === 'pending').map((v) => v.id).sort().join(','),
    [venues],
  )
  const pollsRef = React.useRef(0)
  // A fresh set of waiting rooms is a fresh budget.
  React.useEffect(() => {
    pollsRef.current = 0
  }, [pendingKey])

  // Design §1.1: the rooms place themselves in `after()`, so watch for the results — but only for
  // half a minute. A lookup that never lands is reported as failed by the server after two minutes,
  // and the room's own "Place" button is the way out either way.
  React.useEffect(() => {
    if (!pendingKey) return
    const timer = setInterval(() => {
      pollsRef.current += 1
      if (pollsRef.current >= POLL_LIMIT) clearInterval(timer)
      void onChanged().catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [pendingKey, onChanged])

  React.useEffect(() => {
    if (!canManage) return
    let mounted = true
    apiFetch<{ custom_map: CustomMap | null; can_upload: boolean }>(`${base}/custom-map`)
      .then((res) => {
        if (!mounted) return
        setCustomMap(res.custom_map)
        setCanEditCustomMap(true)
        setCustomBlocked(res.can_upload ? null : 'Every room here is a private residence, so there is no map to put a floor plan on.')
      })
      // A moderator or track lead may read rooms but not event settings: no floor-plan controls.
      .catch(() => mounted && setCanEditCustomMap(false))
    return () => {
      mounted = false
    }
  }, [base, canManage])

  const saveView = async (next: MapView) => {
    await apiFetch(`/api/events/${event.id}/settings`, { method: 'PATCH', json: { map: next } })
    setView(next)
    toast({ title: 'Map area saved.', variant: 'success' })
  }

  const clearView = async () => {
    await apiFetch(`/api/events/${event.id}/settings`, { method: 'PATCH', json: { map: null } })
    setView(null)
    toast({ title: 'Back to the area that fits the rooms.', variant: 'success' })
  }

  const placeVenue = async (venueId: string, point: { lat: number; lng: number; geocoded_from: string | null } | null) => {
    await apiFetch(`${base}/venues/${venueId}`, {
      method: 'PATCH',
      json: point ? { latitude: point.lat, longitude: point.lng, geocoded_from: point.geocoded_from } : { latitude: null, longitude: null, geocoded_from: null },
    })
    await onChanged()
    toast({ title: point ? 'Room placed on the map.' : 'Pin removed.', variant: 'success' })
  }

  const saveOutline = async (venueId: string, outline: OutlinePolygon | null) => {
    await apiFetch(`${base}/venues/${venueId}`, { method: 'PATCH', json: { outline } })
    await onChanged()
    toast({ title: outline ? 'Outline saved.' : 'Outline removed.', variant: 'success' })
  }

  const saveCustomMap = async (next: CustomMap | null) => {
    const res = await apiFetch<{ custom_map: CustomMap | null }>(`${base}/custom-map`, { method: 'PUT', json: { custom_map: next } })
    setCustomMap(res.custom_map)
    toast({ title: next ? 'Indoor map saved.' : 'Indoor map removed.', variant: 'success' })
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
          onClearView={clearView}
          onPlaceVenue={placeVenue}
          onSaveOutline={saveOutline}
          customMap={customMap}
          onSaveCustomMap={saveCustomMap}
          canEditCustomMap={canManage && canEditCustomMap}
          customMapBlockedReason={customBlocked}
          // Only when there is a real address: a venue *name* on its own ("Test Hall") geocodes to
          // whichever place in the world shares it, and the map opens over the wrong continent.
          seedAddress={event.locationAddress ? [event.locationName, event.locationAddress].filter(Boolean).join(', ') : null}
        />
      </CardContent>
    </Card>
  )
}
