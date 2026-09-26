'use client'

/**
 * Organizer map editor (spec §8.3, design §1).
 *
 * Rooms place themselves: saving an address schedules a server-side lookup, so this editor mostly
 * reports what happened ("Locating…", "Located", "Couldn't locate — place by hand") and offers the
 * fallbacks — "Place" to look up again now, a click on the map, a draggable pin.
 *
 * The map area is derived from the located rooms unless the organizer overrides it: "Auto (fits N
 * rooms)" with "Use this view instead", and "Back to auto" to give the override up again.
 *
 * Outlines are drawn with the click-to-add-vertex tool (`OutlineTool`), and a floor plan can be laid
 * over or instead of the basemap (`CustomMapLayer`). Neither is ever published: a room's footprint
 * is as precise as its address, and a private residence may have no outline at all.
 */
import * as React from 'react'
import { Crosshair, Image as ImageIcon, Loader2, Lock, MapPin, Search, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { addressLine } from '@/lib/geo/coarse'
import { CUSTOM_MAP_DEFAULT_OPACITY, CUSTOM_MAP_MAX_BYTES, type CustomMap } from '@/lib/geo/custom-map'
import { outlineRing, type OutlinePolygon } from '@/lib/geo/outline'
import { mapViewLabel, resolveMapView } from '@/lib/geo/view'
import { uploadFloorPlan } from '@/lib/storage/upload'
import type { AdminVenue } from '@/components/admin/types'
import { AddressSearch, addressParts, useAddressLookup } from './AddressSearch'
import { cornerIndex, cornerPins, cornersForBounds, useCustomMapLayer } from './CustomMapLayer'
import { OutlineButtons, OutlineTool, useOutlineDrawing } from './OutlineTool'
import { GatheringMap, type MapHandle, type MapPin as Pin, type MapShape, type MapView } from './GatheringMap'
import type { LngLat } from './types'

export interface VenueMapEditorProps {
  eventSlug: string
  venues: AdminVenue[]
  /** `events.map`: the organizer's override, or null when the area is derived from the rooms. */
  view: MapView | null
  canManage: boolean
  /** Persist the map area override. */
  onSaveView: (view: MapView) => Promise<void>
  /** Drop the override and go back to the derived area. */
  onClearView: () => Promise<void>
  /** Persist a room's point (null clears it). */
  onPlaceVenue: (venueId: string, point: { lat: number; lng: number; geocoded_from: string | null } | null) => Promise<void>
  /** Persist a room's outline (null clears it). */
  onSaveOutline: (venueId: string, outline: OutlinePolygon | null) => Promise<void>
  /** The gathering's indoor map, and how to change it. */
  customMap?: CustomMap | null
  onSaveCustomMap?: (map: CustomMap | null) => Promise<void>
  /** Owners and admins only; a gathering whose every room is a private residence gets no floor plan. */
  canEditCustomMap?: boolean
  customMapBlockedReason?: string | null
  /** Address text to geocode when no room has a pin yet and no view is saved. */
  seedAddress?: string | null
}

/** The same address on one line: what is recorded as `geocoded_from`, and what a person reads. */
function venueAddress(v: AdminVenue): string {
  return addressLine({
    street: v.address,
    locality: v.locality,
    region: v.region,
    postalCode: v.postal_code,
    country: v.country,
  })
}

const isPlaced = (v: AdminVenue) => typeof v.latitude === 'number' && typeof v.longitude === 'number'

/** What the organizer is told about a room's pin (design §1.1). */
function locationNote(v: AdminVenue): { text: string; tone: 'muted' | 'amber' | 'success' } {
  if (v.geocode_status === 'pending') return { text: 'Locating…', tone: 'muted' }
  if (!isPlaced(v)) {
    if (v.geocode_status === 'failed') return { text: 'Couldn’t locate — place by hand', tone: 'amber' }
    return { text: venueAddress(v) ? 'Not on the map yet' : 'No address yet', tone: 'muted' }
  }
  const coords = `${(v.latitude as number).toFixed(4)}, ${(v.longitude as number).toFixed(4)}`
  if (v.geocode_status === 'manual') return { text: `Placed by hand · ${coords}`, tone: 'success' }
  return { text: `Located · ${coords}`, tone: 'success' }
}

export function VenueMapEditor({
  eventSlug,
  venues,
  view,
  canManage,
  onSaveView,
  onClearView,
  onPlaceVenue,
  onSaveOutline,
  customMap = null,
  onSaveCustomMap,
  canEditCustomMap = false,
  customMapBlockedReason = null,
  seedAddress,
}: VenueMapEditorProps) {
  const handleRef = React.useRef<MapHandle | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [placing, setPlacing] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [savingView, setSavingView] = React.useState(false)
  const [seededView, setSeededView] = React.useState<MapView | null>(null)
  const [mapFailed, setMapFailed] = React.useState(false)
  const lookup = useAddressLookup(eventSlug)

  const placed = React.useMemo(() => venues.filter(isPlaced), [venues])
  const unplaced = React.useMemo(() => venues.filter((v) => !isPlaced(v)), [venues])
  const locating = React.useMemo(() => venues.filter((v) => v.geocode_status === 'pending').length, [venues])

  // Design §1.2: the area is the fit of the located rooms until the organizer overrides it.
  const resolved = React.useMemo(() => resolveMapView({ map: view }, venues), [view, venues])
  const autoLabel = mapViewLabel({ ...resolved, source: 'venues' })

  const pins = React.useMemo<Pin[]>(
    () => placed.map((v) => ({ id: v.id, lat: v.latitude as number, lng: v.longitude as number, label: v.name, kind: 'venue', draggable: canManage })),
    [placed, canManage],
  )

  const shapes = React.useMemo<MapShape[]>(() => {
    const out: MapShape[] = []
    for (const v of venues) {
      const ring = outlineRing(v.outline)
      if (ring) out.push({ id: v.id, label: v.name, ring })
    }
    return out
  }, [venues])

  const drawing = useOutlineDrawing({
    onSave: async (venueId, outline) => {
      await onSaveOutline(venueId, outline)
    },
    pinOf: (venueId) => {
      const v = venues.find((room) => room.id === venueId)
      return v && isPlaced(v) ? { lat: v.latitude as number, lng: v.longitude as number } : null
    },
  })
  const drawingVenue = drawing.venueId ? venues.find((v) => v.id === drawing.venueId) ?? null : null

  /* ── the gathering's floor plan ───────────────────────────────────────── */

  const [cornerDraft, setCornerDraft] = React.useState<[LngLat, LngLat, LngLat, LngLat] | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [customBusy, setCustomBusy] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const gatheringCenter = React.useMemo(() => {
    const v = resolved.view
    return v ? { lat: v.center[1], lng: v.center[0] } : null
  }, [resolved.view])
  const shownCustomMap = React.useMemo<CustomMap | null>(
    () => (customMap && cornerDraft ? { ...customMap, corners: cornerDraft } : customMap),
    [customMap, cornerDraft],
  )
  const layer = useCustomMapLayer(shownCustomMap, gatheringCenter)

  const allPins = React.useMemo<Pin[]>(
    () => (cornerDraft ? [...pins, ...cornerPins(cornerDraft)] : pins),
    [pins, cornerDraft],
  )

  // First view: the gathering's address, once, when nothing else places the map.
  const seededRef = React.useRef(false)
  React.useEffect(() => {
    if (seededRef.current || resolved.view || !seedAddress || !canManage) return
    seededRef.current = true
    lookup
      .search({ query: seedAddress })
      .then(([match]) => {
        if (match) setSeededView({ center: [match.lng, match.lat], zoom: 13 })
      })
      .catch(() => undefined)
    // The seed runs at most once, when there is nothing else to open the map on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.view, seedAddress, canManage])

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
      const [match] = await lookup.search(addressParts({
        street: venue.address,
        locality: venue.locality,
        region: venue.region,
        postalCode: venue.postal_code,
        country: venue.country,
      }))
      if (!match) {
        setError(`No match for “${venue.name}”’s address. Click the map to place it by hand.`)
        setPlacing(venue.id)
        return
      }
      await onPlaceVenue(venue.id, { lat: match.lat, lng: match.lng, geocoded_from: query })
      handleRef.current?.flyTo(match.lat, match.lng, 15)
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

  const clearOutline = async (venue: AdminVenue) => {
    setBusy(venue.id)
    setError(null)
    try {
      await onSaveOutline(venue.id, null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The outline could not be removed.')
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

  const backToAuto = async () => {
    setSavingView(true)
    setError(null)
    try {
      await onClearView()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The map area could not be reset.')
    } finally {
      setSavingView(false)
    }
  }

  const saveCustom = async (next: CustomMap | null) => {
    if (!onSaveCustomMap) return
    setCustomBusy(true)
    setError(null)
    try {
      await onSaveCustomMap(next)
      setCornerDraft(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The floor plan could not be saved.')
    } finally {
      setCustomBusy(false)
    }
  }

  const onFile = async (file: File | null) => {
    if (!file || !onSaveCustomMap) return
    setUploading(true)
    setError(null)
    try {
      const url = await uploadFloorPlan(file, eventSlug)
      const bounds = handleRef.current?.getView()?.bounds
      const corners = bounds ? cornersForBounds(bounds) : null
      await onSaveCustomMap(
        corners
          ? { image: url, corners, opacity: customMap?.opacity ?? CUSTOM_MAP_DEFAULT_OPACITY, basemap: true }
          : { image: url, corners: null, opacity: customMap?.opacity ?? CUSTOM_MAP_DEFAULT_OPACITY, basemap: false },
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The floor plan could not be uploaded.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
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
          {locating > 0 && ` · ${locating} locating…`}
        </p>
        {canManage && !mapFailed && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={view ? 'secondary' : 'outline'} data-testid="map-area-mode">
              {view ? 'Saved view' : autoLabel}
            </Badge>
            <Button type="button" size="sm" variant="outline" onClick={useThisView} loading={savingView}>
              <Crosshair className="mr-1.5 h-4 w-4" aria-hidden />
              Use this view instead
            </Button>
            {view && (
              <Button type="button" size="sm" variant="ghost" onClick={backToAuto} loading={savingView}>
                Back to auto
              </Button>
            )}
          </div>
        )}
      </div>

      {canManage && !mapFailed && (
        <AddressSearch
          eventSlug={eventSlug}
          idPrefix="venue-map-search"
          onPick={(match) => handleRef.current?.flyTo(match.lat, match.lng, 16)}
          disabled={!!drawing.venueId}
          className="max-w-xl"
        />
      )}

      {placingVenue && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" role="status">
          <span>Click the map to place <strong>{placingVenue.name}</strong>.</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setPlacing(null)}>Cancel</Button>
        </div>
      )}
      <OutlineTool drawing={drawing} venueName={drawingVenue?.name ?? null} />
      {cornerDraft && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" role="status">
          <span>Drag the four corner handles onto the matching spots, then save.</span>
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setCornerDraft(null)}>Cancel</Button>
            <Button
              type="button"
              size="sm"
              loading={customBusy}
              onClick={() => customMap && saveCustom({ ...customMap, corners: cornerDraft, basemap: true })}
            >
              Save placement
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <div className="h-80 overflow-hidden rounded-lg border" data-testid="venue-map">
        <GatheringMap
          pins={allPins}
          view={view ?? seededView ?? resolved.view}
          shapes={shapes}
          draft={drawing.draft}
          image={layer.image}
          basemap={layer.basemap}
          clampTo={layer.clampTo}
          handleRef={handleRef}
          onError={() => setMapFailed(true)}
          onMapClick={async (p) => {
            if (!canManage) return
            if (drawing.venueId) {
              drawing.addVertex(p)
              return
            }
            if (!placing) return
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
          onMapDoubleClick={() => {
            if (drawing.venueId) drawing.done()
          }}
          onPinDrag={async (id, p) => {
            if (!canManage) return
            const corner = cornerIndex(id)
            if (corner !== null) {
              setCornerDraft((current) => {
                if (!current) return current
                const next = [...current] as [LngLat, LngLat, LngLat, LngLat]
                next[corner] = [p.lng, p.lat]
                return next
              })
              return
            }
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
          const note = locationNote(v)
          const hasOutline = !!outlineRing(v.outline)
          return (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <MapPin className={isPlaced(v) ? 'h-4 w-4 text-primary' : 'h-4 w-4 text-muted-foreground'} aria-hidden />
                <span className="truncate font-medium">{v.name}</span>
                {v.is_private_residence && (
                  <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3" aria-hidden />Members only</Badge>
                )}
                {hasOutline && <Badge variant="outline">Outlined</Badge>}
                <span
                  className={
note.tone === 'amber' ? 'text-xs text-signal-amber' : 'text-xs text-muted-foreground'}
                  data-testid={`venue-status-${v.id}`}
                >
                  {v.geocode_status === 'pending' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />}
                  {note.text}
                </span>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  {isPlaced(v) ? (
                    <>
                      <Button type="button" size="sm" variant="ghost" onClick={() => handleRef.current?.flyTo(v.latitude as number, v.longitude as number, 16)}>Show</Button>
                      {!v.is_private_residence && (
                        <OutlineButtons
                          hasOutline={hasOutline}
                          disabled={!!drawing.venueId}
                          busy={busy === v.id}
                          onDraw={() => drawing.start(v.id)}
                          onClear={() => clearOutline(v)}
                        />
                      )}
                      <Button type="button" size="sm" variant="ghost" onClick={() => clear(v)} loading={busy === v.id} aria-label={`Remove ${v.name} from the map`}>
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => place(v)} loading={busy === v.id || v.geocode_status === 'pending'}>
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
        Outlines stay in this app: members see them on the gathering map, and no record ever carries one.
      </p>

      {canEditCustomMap && onSaveCustomMap && (
        <div className="space-y-2 rounded-lg border p-3" data-testid="custom-map-controls">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium"><ImageIcon className="h-4 w-4" aria-hidden />Indoor map</h3>
            {customMap ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const bounds = handleRef.current?.getView()?.bounds
                    setCornerDraft(customMap.corners ?? (bounds ? cornersForBounds(bounds) : null))
                  }}
                >
                  Place corners
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => saveCustom(null)} loading={customBusy} aria-label="Remove the indoor map">
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} loading={uploading} disabled={!!customMapBlockedReason}>
                <Upload className="mr-1.5 h-4 w-4" aria-hidden />
                Upload a floor plan
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
          {customMapBlockedReason ? (
            <p className="text-xs text-muted-foreground">{customMapBlockedReason}</p>
          ) : customMap ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Switch
                    id="custom-map-basemap"
                    checked={customMap.basemap}
                    onCheckedChange={(checked) => {
                      const bounds = handleRef.current?.getView()?.bounds
                      const corners = customMap.corners ?? (bounds ? cornersForBounds(bounds) : null)
                      void saveCustom(
                        checked && corners
                          ? { ...customMap, basemap: true, corners }
                          : { ...customMap, basemap: false, corners: null },
                      )
                    }}
                    disabled={customBusy}
                  />
                  <Label htmlFor="custom-map-basemap" className="text-sm">Show the street map underneath</Label>
                </div>
                <div className="flex min-w-[12rem] items-center gap-2">
                  <Label htmlFor="custom-map-opacity" className="text-sm">Opacity</Label>
                  <input
                    id="custom-map-opacity"
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={customMap.opacity}
                    onChange={(e) => void saveCustom({ ...customMap, opacity: Number(e.target.value) })}
                    disabled={customBusy}
                    className="w-32"
                  />
                  <span className="w-10 text-xs text-muted-foreground">{Math.round(customMap.opacity * 100)}%</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {customMap.basemap
                  ? 'Georeferenced: the plan is pinned to the four corners you placed, and every pin keeps its real coordinates.'
                  : 'Image only: the plan is the map, centred on the gathering. A session placed on it publishes the gathering’s area (about 1 km) and nothing finer.'}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              A PNG, JPEG or WebP up to {Math.round(CUSTOM_MAP_MAX_BYTES / (1024 * 1024))} MB. Like the gathering’s logo, the file is served from an
              unguessable but public address — treat the plan as public.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
