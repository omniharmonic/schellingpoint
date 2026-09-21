/** Shared shapes for the map components (no MapLibre import: safe in server bundles). */
import type { LatLng } from '@/lib/geo/coarse'

export interface MapView {
  center: [number, number]
  zoom: number
  bounds?: [[number, number], [number, number]]
}

export interface MapPin extends LatLng {
  id: string
  label: string
  /** venue: a room; self: an exact self-hosted point; coarse: a ≈1 km area; me: the viewer (browser-only). */
  kind: 'venue' | 'self' | 'coarse' | 'me'
  count?: number
  draggable?: boolean
  selected?: boolean
}

export interface MapHandle {
  getView(): MapView | null
  flyTo(lat: number, lng: number, zoom?: number): void
  fitToPins(only?: MapPin[]): void
  setView(view: MapView): void
}

export interface MapCanvasProps {
  pins: MapPin[]
  /** The organizer's saved view; when absent the map fits its pins. */
  view?: MapView | null
  fitToPins?: boolean
  interactive?: boolean
  styleUrl?: string
  className?: string
  onPinClick?: (id: string) => void
  onPinDrag?: (id: string, point: LatLng) => void
  onMapClick?: (point: LatLng) => void
  onViewChange?: (view: MapView) => void
  onError?: () => void
  onReady?: () => void
  handleRef?: React.MutableRefObject<MapHandle | null>
}
