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
  /**
   * venue: a room; self: an exact self-hosted point; coarse: a ≈1 km area; me: the viewer
   * (browser-only); corner: a custom map's corner handle in the editor (design §1.5).
   */
  kind: 'venue' | 'self' | 'coarse' | 'me' | 'corner'
  count?: number
  draggable?: boolean
  selected?: boolean
}

/** `[longitude, latitude]`, GeoJSON order. */
export type LngLat = [number, number]

/**
 * A venue outline on the map (design §1.4): one closed ring with the room's name. App-side only —
 * outlines never reach a record.
 */
export interface MapShape {
  id: string
  label: string
  /** Closed ring: the last vertex repeats the first. */
  ring: LngLat[]
  selected?: boolean
}

/** A custom map image drawn under the pins and outlines (design §1.5). */
export interface MapImage {
  /** App-hosted `/uploads/…` path. */
  url: string
  /** Top-left, top-right, bottom-right, bottom-left. */
  corners: [LngLat, LngLat, LngLat, LngLat]
  opacity: number
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
  /** Venue outlines, drawn under the pins with a clickable name label. */
  shapes?: MapShape[]
  /** The outline being drawn right now: an open ring, one vertex per click. */
  draft?: LngLat[] | null
  /** A custom map image under everything else. */
  image?: MapImage | null
  /** False hides the basemap entirely (image-only custom map): no tiles, no labels. */
  basemap?: boolean
  /** Keeps the view inside this box and refuses to zoom out past the fit (image-only mode). */
  clampTo?: [[number, number], [number, number]] | null
  onPinClick?: (id: string) => void
  onPinDrag?: (id: string, point: LatLng) => void
  onMapClick?: (point: LatLng) => void
  onMapDoubleClick?: (point: LatLng) => void
  onShapeClick?: (id: string) => void
  onViewChange?: (view: MapView) => void
  onError?: () => void
  onReady?: () => void
  handleRef?: React.MutableRefObject<MapHandle | null>
}
