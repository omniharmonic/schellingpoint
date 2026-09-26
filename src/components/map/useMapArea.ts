'use client'

/**
 * The gathering's map area, outlines and indoor map, from `GET /api/v1/events/[slug]/map`
 * (design §1.2). One read for every surface that opens a map, so the member map, the session
 * previews and the proposal picker all agree on where the map starts.
 *
 * A failure is silent on purpose: every caller can still open its map on its own pins.
 */
import * as React from 'react'
import { apiFetch } from '@/lib/api/client'
import type { CustomMap } from '@/lib/geo/custom-map'
import type { LngLat, MapView } from './types'

export interface MapAreaOutline {
  venue_id: string
  name: string
  ring: LngLat[]
}

export interface MapArea {
  /** The resolved area: the organizer's override, or the fit of the located rooms. */
  view: MapView | null
  outlines: MapAreaOutline[]
  customMap: CustomMap | null
  loading: boolean
}

const EMPTY: MapArea = { view: null, outlines: [], customMap: null, loading: true }

export function useMapArea(slug: string | null | undefined): MapArea {
  const [area, setArea] = React.useState<MapArea>(EMPTY)
  React.useEffect(() => {
    if (!slug) return
    let mounted = true
    apiFetch<{ view: MapView | null; outlines?: MapAreaOutline[]; custom_map: CustomMap | null }>(
      `/api/v1/events/${encodeURIComponent(slug)}/map`,
    )
      .then((data) => {
        if (!mounted) return
        setArea({ view: data.view ?? null, outlines: data.outlines ?? [], customMap: data.custom_map ?? null, loading: false })
      })
      .catch(() => mounted && setArea((current) => ({ ...current, loading: false })))
    return () => {
      mounted = false
    }
  }, [slug])
  return area
}
