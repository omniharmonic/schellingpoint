'use client'

/**
 * Organizer map editor (spec §8.3): set the gathering's map area ("Use this view"), place each
 * room by geocoding its address or by clicking the map, drag pins to adjust. Private residences
 * are placed too (organizers and attendees see them) but their pin never reaches a record.
 */
import * as React from 'react'
import { Crosshair, Lock, MapPin, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import type { AdminVenue } from '@/components/admin/types'
import { GatheringMap, type MapHandle, type MapPin as Pin, type MapView } from './GatheringMap'

export interface VenueMapEditorProps {
  eventSlug: string
  venues: AdminVenue[]
  view: MapView | null
  canManage: boolean
  /** Persist the map area. */
  onSaveView: (view: MapView) => Promise<void>
  /** Persist a room's point (null clears it). */
  onPlaceVenue: (venueId: string, point: { lat: number; lng: number; geocoded_from: string | null } | null) => Promise<void>
  /** Address text to geocode when no room has a pin yet and no view is saved. */
  seedAddress?: string | null
}

function venueAddress(v: AdminVenue): string {
  return [v.address, v.locality, v.region, v.postal_code, v.country].filter((s) => s && s.trim()).join(', ')
}

export function VenueMapEditor({ eventSlug, venues, view, canManage, onSaveView, onPlaceVenue, seedAddress }: VenueMapEditorProps) {
  const handleRef = React.useRef<MapHandle | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [placing, setPlacing] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [savingView, setSavingView] = React.useState(false)
  const [seededView, setSeededView] = React.useState<MapView | null>(null)
  const [mapFailed, setMapFailed] = React.useState(false)

  const placed = React.useMemo(() => venues.filter((v) => typeof v.latitude === 'number' && typeof v.longitude === 'number'), [venues])
  const unplaced = React.useMemo(() => venues.filter((v) => !(typeof v.latitude === 'number' && typeof v.longitude === 'number')), [venues])

  const pins = React.useMemo<Pin[]>(
    () => placed.map((v) => ({ id: v.id, lat: v.latitude as number, lng: v.longitude as number, label: v.name, kind: 'venue', draggable: canManage })),
    [placed, canManage],
  )

  const geocode = React.useCallback(async (query: string) => {
    const res = await apiFetch<{ result: { lat: number; lng: number; label: string } | null }>(`/api/v1/events/${encodeURIComponent(eventSlug)}/admin/geocode`, {
      method: 'POST',
      json: { query },
    })
    return res.result
  }, [eventSlug])

  // First view: the gathering's address, once, when nothing else places the map.
  const seededRef = React.useRef(false)
  React.useEffect(() => {
    if (seededRef.current || view || placed.length || !seedAddress || !canManage) return
    seededRef.current = true
    geocode(seedAddress)
      .then((r) => {
        if (r) setSeededView({ center: [r.lng, r.lat], zoom: 13 })
      })
      .catch(() => undefined)
  }, [view, placed.length, seedAddress, canManage, geocode])

  const place = async (venue: AdminVenue) => {
    const query = venueAddress(venue)
    if (!query) {
      setPlacing(venue.id)
      setError(null)
      return
    }
    setBusy(venue.id)
    setError(null)
    try {
      const r = await geocode(query)
      if (!r) {
        setError(`No match for “${venue.name}”’s address. Click the map to place it by hand.`)
        setPlacing(venue.id)
        return
      }
      await onPlaceVenue(venue.id, { lat: r.lat, lng: r.lng, geocoded_from: query })
      handleRef.current?.flyTo(r.lat, r.lng, 15)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The room could not be placed.')
    } finally {
      setBusy(null)
    }
  }

  const clear = async (venue: AdminVenue) => {
    setBusy(venue.id)
    setError(null)
    try {
      await onPlaceVenue(venue.id, null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The pin could not be removed.')
    } finally {
      setBusy(null)
    }
  }

  const useThisView = async () => {
    const v = handleRef.current?.getView()
    if (!v) return
    setSavingView(true)
    setError(null)
    try {
      await onSaveView(v)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The map area could not be saved.')
    } finally {
      setSavingView(false)
    }
  }

  const placingVenue = placing ? venues.find((v) => v.id === placing) ?? null : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {placed.length === 0
            ? 'No rooms are on the map yet.'
            : `${plural(placed.length, 'room')} on the map${unplaced.length ? ` · ${plural(unplaced.length, 'room')} to place` : ''}`}
        </p>
        {canManage && !mapFailed && (
          <Button type="button" size="sm" variant="outline" onClick={useThisView} loading={savingView}>
            <Crosshair className="mr-1.5 h-4 w-4" aria-hidden />
            Use this view as the map area
          </Button>
        )}
      </div>
      {placingVenue && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" role="status">
          <span>Click the map to place <strong>{placingVenue.name}</strong>.</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setPlacing(null)}>Cancel</Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <div className="h-80 overflow-hidden rounded-lg border" data-testid="venue-map">
        <GatheringMap
          pins={pins}
          view={view ?? seededView}
          handleRef={handleRef}
          onError={() => setMapFailed(true)}
          onMapClick={async (p) => {
            if (!placing || !canManage) return
            const venue = venues.find((v) => v.id === placing)
            setPlacing(null)
            if (!venue) return
            setBusy(venue.id)
            try {
              await onPlaceVenue(venue.id, { lat: p.lat, lng: p.lng, geocoded_from: null })
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'The room could not be placed.')
            } finally {
              setBusy(null)
            }
          }}
          onPinDrag={async (id, p) => {
            if (!canManage) return
            setBusy(id)
            try {
              await onPlaceVenue(id, { lat: p.lat, lng: p.lng, geocoded_from: null })
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'The pin could not be moved.')
            } finally {
              setBusy(null)
            }
          }}
          fallback={<p className="p-4 text-sm text-muted-foreground">The map is unavailable right now. Rooms keep their saved coordinates.</p>}
        />
      </div>

      <ul className="divide-y rounded-lg border" aria-label="Rooms on the map">
        {venues.map((v) => {
          const isPlaced = typeof v.latitude === 'number' && typeof v.longitude === 'number'
          return (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <MapPin className={isPlaced ? 'h-4 w-4 text-primary' : 'h-4 w-4 text-muted-foreground'} aria-hidden />
                <span className="truncate font-medium">{v.name}</span>
                {v.is_private_residence && (
                  <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3" aria-hidden />Members only</Badge>
                )}
                {isPlaced ? (
                  <span className="text-xs text-muted-foreground">{(v.latitude as number).toFixed(4)}, {(v.longitude as number).toFixed(4)}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not on the map</span>
                )}
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  {isPlaced ? (
                    <>
                      <Button type="button" size="sm" variant="ghost" onClick={() => handleRef.current?.flyTo(v.latitude as number, v.longitude as number, 16)}>Show</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => clear(v)} loading={busy === v.id} aria-label={`Remove ${v.name} from the map`}>
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => place(v)} loading={busy === v.id}>
                      <Search className="mr-1.5 h-4 w-4" aria-hidden />
                      Place
                    </Button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        A public room’s pin is published with the room. A private residence’s pin is shown to members only; its record carries the neighbourhood, never the point.
      </p>
    </div>
  )
}
