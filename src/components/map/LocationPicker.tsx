'use client'

/**
 * Where a self-hosted session happens (spec §8.3/§8.4, proposer side): the address text
 * (`custom_location`, attendee-only) plus a pin (`location_lat/lng`, the same tier). "Find on
 * map" geocodes the typed address through `useAddressLookup` — the shared lookup the venue editor's
 * address search uses too (design §1.3), so there is one voice and one budget for both;
 * the pin can also be placed by clicking the map and dragged. Non-attendees only ever see the
 * rounded ≈1 km area, which is explained inline.
 */
import * as React from 'react'
import { Crosshair, MapPin, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { roundCoarse } from '@/lib/geo/coarse'
import { useAddressLookup } from './AddressSearch'
import { GatheringMap, type MapHandle, type MapPin as Pin } from './GatheringMap'

export interface LocationValue {
  address: string
  lat: number | null
  lng: number | null
}

export interface LocationPickerProps {
  eventSlug: string
  value: LocationValue
  onChange: (next: LocationValue) => void
  /** Fallback map centre when there is no pin yet (the gathering's map area). */
  initialView?: { center: [number, number]; zoom: number } | null
  idPrefix?: string
  /** Address field label; defaults to "Location details". */
  label?: string
  hint?: React.ReactNode
  disabled?: boolean
}

export function LocationPicker({ eventSlug, value, onChange, initialView, idPrefix = 'location', label = 'Location details', hint, disabled }: LocationPickerProps) {
  const handleRef = React.useRef<MapHandle | null>(null)
  const lookup = useAddressLookup(eventSlug)
  const { looking, error: lookupError, setError: setLookupError } = lookup
  const [lookupLabel, setLookupLabel] = React.useState<string | null>(null)
  const [placing, setPlacing] = React.useState(false)
  const hasPin = value.lat !== null && value.lng !== null

  const pins = React.useMemo<Pin[]>(
    () => (hasPin ? [{ id: 'session', lat: value.lat as number, lng: value.lng as number, label: 'Your session', kind: 'self', draggable: !disabled }] : []),
    [hasPin, value.lat, value.lng, disabled],
  )
  const view = React.useMemo(() => {
    if (hasPin) return { center: [value.lng as number, value.lat as number] as [number, number], zoom: 15 }
    return initialView ?? null
    // Only the first pin/centre matters; later moves come through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPin ? 'pin' : initialView ? 'area' : 'none'])

  const setPoint = (lat: number, lng: number) => {
    onChange({ ...value, lat, lng })
    handleRef.current?.flyTo(lat, lng, 15)
  }

  const findOnMap = async () => {
    const query = value.address.trim()
    if (query.length < 3) {
      setLookupError('Type the address first.')
      return
    }
    setLookupLabel(null)
    const [match] = await lookup.search({ query })
    if (!match) return
    setLookupLabel(match.label)
    setPoint(match.lat, match.lng)
  }

  const coarse = hasPin ? roundCoarse(value.lat as number, value.lng as number) : null

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-address`} className="flex items-center gap-2">
          <MapPin className="h-4 w-4" aria-hidden />
          {label}
        </Label>
        <Textarea
          id={`${idPrefix}-address`}
          value={value.address}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
          placeholder="Where will your session be held? Include the address, room and any directions attendees need…"
          rows={3}
          maxLength={300}
          disabled={disabled}
          aria-describedby={`${idPrefix}-address-hint`}
        />
        <p id={`${idPrefix}-address-hint`} className="text-xs text-muted-foreground">
          {hint ?? <>{value.address.length}/300 · Shown only to confirmed attendees, hosts and organizers. Never published.</>}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={findOnMap} loading={looking} disabled={disabled}>
          <Search className="mr-1.5 h-4 w-4" aria-hidden />
          Find on map
        </Button>
        <Button type="button" variant={placing ? 'default' : 'outline'} size="sm" onClick={() => setPlacing((p) => !p)} disabled={disabled} aria-pressed={placing}>
          <Crosshair className="mr-1.5 h-4 w-4" aria-hidden />
          {placing ? 'Click the map to place' : 'Place by hand'}
        </Button>
        {hasPin && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...value, lat: null, lng: null })} disabled={disabled}>
            <X className="mr-1.5 h-4 w-4" aria-hidden />
            Remove pin
          </Button>
        )}
      </div>
      {lookupError && <p className="text-sm text-destructive" role="alert">{lookupError}</p>}
      {lookupLabel && !lookupError && <p className="text-xs text-muted-foreground">Matched: {lookupLabel}</p>}

      <div className="h-56 overflow-hidden rounded-lg border" data-testid={`${idPrefix}-map`}>
        <GatheringMap
          pins={pins}
          view={view}
          fitToPins={false}
          handleRef={handleRef}
          onMapClick={(p) => {
            if (disabled) return
            if (placing || !hasPin) {
              setPoint(p.lat, p.lng)
              setPlacing(false)
            }
          }}
          onPinDrag={(_, p) => onChange({ ...value, lat: p.lat, lng: p.lng })}
          fallback={<p className="p-4 text-sm text-muted-foreground">The map is unavailable right now. Your address text is still saved.</p>}
        />
      </div>
      {hasPin && coarse ? (
        <p className="text-xs text-muted-foreground">
          Confirmed attendees see the exact spot; everyone else an area of about 1 km ({coarse.lat.toFixed(2)},{' '}
          {coarse.lng.toFixed(2)}). Drag the pin to adjust.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Optional. Add a pin so attendees can find you; everyone else sees an area of about 1 km.
        </p>
      )}
    </div>
  )
}
