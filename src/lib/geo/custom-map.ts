/**
 * Indoor / hand-drawn maps (design §1.5). Pure: the editor validates with the same code the
 * custom-map route enforces.
 *
 *   { image: '/uploads/<aa>/<sha256>.<ext>', corners: [[lng,lat] x4] | null, opacity, basemap }
 *
 * Two modes:
 *   georeferenced (`basemap: true`, four `corners`) — the floor plan is pinned to the real world by
 *     dragging its corners over the basemap, and every pin keeps its real coordinates;
 *   image-only (`basemap: false`, `corners: null`) — one building, no basemap. The image is placed
 *     on a synthetic extent around the gathering's centre (`imageOnlyExtent`), a box under a
 *     kilometre across. A pin on that box is a position on a picture, not a place, so what leaves is
 *     never the pin: `coarseSessionPoint` publishes the gathering's own rounded centre instead. The
 *     extent is small for looks; the privacy comes from that substitution, not from its size.
 *
 * The image is an app-hosted upload: content-addressed and unguessable, but NOT access-controlled —
 * the same tier as the gathering's logo. The UI says so where the organizer uploads it. Never
 * published: `events.custom_map` is app-side only, like `events.map`.
 */
import { isLatLng, roundCoarse, type LatLng } from './coarse'
import type { LngLat } from './outline'

/** `/uploads/<aa>/<sha256>.<ext>` for the raster types a floor plan may be. */
export const CUSTOM_MAP_IMAGE_RE = /^\/uploads\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpg|webp)$/
/** Floor plans are bigger than logos: design §1.5 allows 8 MB. */
export const CUSTOM_MAP_MAX_BYTES = 8 * 1024 * 1024
export const CUSTOM_MAP_DEFAULT_OPACITY = 0.8

/** Half-width of the image-only extent, in degrees of latitude (≈ 440 m). */
const IMAGE_ONLY_HALF_SPAN = 0.004

export interface CustomMap {
  image: string
  /** Top-left, top-right, bottom-right, bottom-left — MapLibre's `image` source order. */
  corners: [LngLat, LngLat, LngLat, LngLat] | null
  opacity: number
  basemap: boolean
}

export class CustomMapError extends Error {
  constructor(message: string, readonly field = 'custom_map') {
    super(message)
    this.name = 'CustomMapError'
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

function corner(value: unknown, index: number): LngLat {
  if (!Array.isArray(value) || value.length < 2) throw new CustomMapError(`Corner ${index + 1} must be a [longitude, latitude] pair`, 'corners')
  const lng = typeof value[0] === 'string' ? Number(value[0]) : value[0]
  const lat = typeof value[1] === 'string' ? Number(value[1]) : value[1]
  if (!isLatLng(lat, lng)) throw new CustomMapError(`Corner ${index + 1} is not a point on Earth`, 'corners')
  return [round6(lng as number), round6(lat as number)]
}

/** Validate a custom map from an untrusted body. `null` clears it. */
export function parseCustomMap(value: unknown): CustomMap | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new CustomMapError('The custom map must be an object')
  const v = value as Record<string, unknown>

  const image = typeof v.image === 'string' ? v.image.trim() : ''
  if (!image) throw new CustomMapError('Upload a floor plan image first', 'image')
  if (!CUSTOM_MAP_IMAGE_RE.test(image)) {
    throw new CustomMapError('The floor plan must be a PNG, JPEG or WebP uploaded to this gathering', 'image')
  }

  const basemap = v.basemap === undefined || v.basemap === null ? true : v.basemap
  if (typeof basemap !== 'boolean') throw new CustomMapError('basemap must be true or false', 'basemap')

  const rawOpacity = v.opacity === undefined || v.opacity === null ? CUSTOM_MAP_DEFAULT_OPACITY : v.opacity
  const opacityNumber = typeof rawOpacity === 'string' ? Number(rawOpacity) : rawOpacity
  if (typeof opacityNumber !== 'number' || !Number.isFinite(opacityNumber) || opacityNumber < 0 || opacityNumber > 1) {
    throw new CustomMapError('The opacity must be between 0 and 1', 'opacity')
  }
  const opacity = Math.round(opacityNumber * 100) / 100

  const rawCorners = v.corners ?? null
  if (!basemap) {
    if (rawCorners !== null) throw new CustomMapError('An image-only map has no corners: it is placed on the gathering’s centre', 'corners')
    return { image, corners: null, opacity, basemap: false }
  }
  if (!Array.isArray(rawCorners) || rawCorners.length !== 4) {
    throw new CustomMapError('A georeferenced map needs exactly four corners', 'corners')
  }
  const corners = rawCorners.map(corner) as [LngLat, LngLat, LngLat, LngLat]
  const lngs = corners.map((c) => c[0])
  const lats = corners.map((c) => c[1])
  if (Math.max(...lngs) - Math.min(...lngs) < 1e-6 || Math.max(...lats) - Math.min(...lats) < 1e-6) {
    throw new CustomMapError('The four corners must enclose an area', 'corners')
  }
  return { image, corners, opacity, basemap: true }
}

/** A stored `events.custom_map`, or null when the column holds something else. */
export function readCustomMap(value: unknown): CustomMap | null {
  try {
    return parseCustomMap(value)
  } catch {
    return null
  }
}

export function isImageOnly(map: CustomMap | null | undefined): boolean {
  return !!map && map.basemap === false && map.corners === null
}

/**
 * Where an image-only floor plan is drawn: a small box around the gathering's centre, its corners
 * in MapLibre's `image` source order (top-left, top-right, bottom-right, bottom-left).
 *
 * `aspect` is the image's width / height, so a wide plan is not stretched to a square. The box never
 * grows past `IMAGE_ONLY_HALF_SPAN` (≈ 440 m), so it covers roughly the ≈1 km cell the gathering
 * already publishes — but what a session in this mode publishes is the centre itself, never a point
 * read off this box.
 */
export function imageOnlyExtent(center: LatLng, aspect = 1): {
  corners: [LngLat, LngLat, LngLat, LngLat]
  bounds: [[number, number], [number, number]]
} {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const cos = Math.max(0.05, Math.cos((center.lat * Math.PI) / 180))
  // Fit the image inside the square box: the long side takes the whole half-span.
  const halfLat = ratio >= 1 ? IMAGE_ONLY_HALF_SPAN / ratio : IMAGE_ONLY_HALF_SPAN
  const halfLngDeg = (ratio >= 1 ? IMAGE_ONLY_HALF_SPAN : IMAGE_ONLY_HALF_SPAN * ratio) / cos
  const west = round6(center.lng - halfLngDeg)
  const east = round6(center.lng + halfLngDeg)
  const south = round6(center.lat - halfLat)
  const north = round6(center.lat + halfLat)
  return {
    corners: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    bounds: [
      [west, south],
      [east, north],
    ],
  }
}

/**
 * The coarse point a self-hosted session publishes (design §1.5). Normally the session's own pin
 * rounded to 2 decimals; on an image-only custom map the pin is a position on a picture, so the
 * gathering's public centre — rounded the same way — is all that leaves.
 *
 * `gatheringCenter` is the centre of the gathering's located PUBLIC rooms. Without one, an
 * image-only session publishes NOTHING: falling back to the pin would publish a position read off a
 * picture as though it were a place, and there is no other point that may stand in — a private
 * residence's cell is exactly what must not leave.
 */
export function coarseSessionPoint(
  pin: LatLng | null,
  options: { customMap?: CustomMap | null; gatheringCenter?: LatLng | null } = {},
): LatLng | null {
  if (isImageOnly(options.customMap ?? null)) {
    const center = options.gatheringCenter ?? null
    return center ? roundCoarse(center.lat, center.lng) : null
  }
  return pin ? roundCoarse(pin.lat, pin.lng) : null
}
