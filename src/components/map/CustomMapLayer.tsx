'use client'

/**
 * Indoor / hand-drawn maps on the canvas (design §1.5).
 *
 * `useCustomMapLayer` turns a stored `events.custom_map` into the three props `MapCanvas` needs:
 *
 *   georeferenced (`basemap: true`, four corners) — an `image` source under the pins and outlines,
 *     at the organizer's opacity, with the basemap still there;
 *   image-only (`basemap: false`, `corners: null`) — the image on a synthetic extent around the
 *     gathering's centre, the basemap hidden and the view clamped to the picture. The extent is
 *     small enough that every point on it rounds to the gathering's own ≈1 km cell, which is why a
 *     session placed here publishes the centre and nothing finer.
 *
 * The image's own aspect ratio is measured in the browser so a wide floor plan is not stretched to
 * a square; until it loads the extent is square, which only ever shows the picture slightly off.
 */
import * as React from 'react'
import { imageOnlyExtent, isImageOnly, type CustomMap } from '@/lib/geo/custom-map'
import type { LatLng } from '@/lib/geo/coarse'
import type { LngLat, MapImage, MapPin } from './types'

export interface CustomMapLayer {
  image: MapImage | null
  /** False when the basemap must be hidden entirely (image-only mode). */
  basemap: boolean
  clampTo: [[number, number], [number, number]] | null
}

const IDLE: CustomMapLayer = { image: null, basemap: true, clampTo: null }

/** The natural width / height of an image URL, once the browser has it. */
export function useImageAspect(url: string | null): number | null {
  const [aspect, setAspect] = React.useState<number | null>(null)
  React.useEffect(() => {
    setAspect(null)
    if (!url || typeof window === 'undefined') return
    const img = new window.Image()
    let cancelled = false
    img.onload = () => {
      if (!cancelled && img.naturalWidth > 0 && img.naturalHeight > 0) setAspect(img.naturalWidth / img.naturalHeight)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])
  return aspect
}

export function useCustomMapLayer(customMap: CustomMap | null | undefined, center: LatLng | null): CustomMapLayer {
  const imageOnly = isImageOnly(customMap ?? null)
  const aspect = useImageAspect(imageOnly ? customMap?.image ?? null : null)
  return React.useMemo(() => {
    if (!customMap) return IDLE
    if (!imageOnly) {
      if (!customMap.corners) return IDLE
      return { image: { url: customMap.image, corners: customMap.corners, opacity: customMap.opacity }, basemap: true, clampTo: null }
    }
    if (!center) return IDLE
    const extent = imageOnlyExtent(center, aspect ?? 1)
    return {
      image: { url: customMap.image, corners: extent.corners, opacity: customMap.opacity },
      basemap: false,
      clampTo: extent.bounds,
    }
  }, [customMap, imageOnly, center, aspect])
}

const CORNER_LABELS = ['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const

/** The four draggable handles the organizer georeferences a floor plan with. */
export function cornerPins(corners: readonly LngLat[]): MapPin[] {
  return corners.slice(0, 4).map((corner, index) => ({
    id: `corner:${index}`,
    lat: corner[1],
    lng: corner[0],
    label: CORNER_LABELS[index] ?? `Corner ${index + 1}`,
    kind: 'corner' as const,
    draggable: true,
  }))
}

/** `corner:<index>` → the index, or null for any other pin id. */
export function cornerIndex(pinId: string): number | null {
  const match = /^corner:([0-3])$/.exec(pinId)
  return match ? Number(match[1]) : null
}

/**
 * Sensible starting corners for a freshly uploaded plan: a box filling most of the current view,
 * in MapLibre's image order (top-left, top-right, bottom-right, bottom-left).
 */
export function cornersForBounds(
  bounds: [[number, number], [number, number]],
  inset = 0.15,
): [LngLat, LngLat, LngLat, LngLat] {
  const [[west, south], [east, north]] = bounds
  const padLng = (east - west) * inset
  const padLat = (north - south) * inset
  const w = west + padLng
  const e = east - padLng
  const s = south + padLat
  const n = north - padLat
  const round = (value: number) => Math.round(value * 1e6) / 1e6
  return [
    [round(w), round(n)],
    [round(e), round(n)],
    [round(e), round(s)],
    [round(w), round(s)],
  ]
}
