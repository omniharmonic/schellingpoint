'use client'

/**
 * The MapLibre canvas (spec §8.2). Only `GatheringMap` imports this file, through `next/dynamic`
 * with `ssr: false`, so `maplibre-gl` (WebGL, `window`) never enters a server bundle.
 *
 * Tiles come from the style URL: OpenFreeMap's `liberty` by default (key-less, no tracking),
 * `NEXT_PUBLIC_MAP_STYLE_URL` overrides. Attribution stays on. Nothing here talks to our server:
 * pins arrive as props already filtered by tier, and a "Near me" position (if any) is just one
 * more pin the browser computed.
 */
import * as React from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { cn } from '@/lib/utils'
import type { MapCanvasProps, MapHandle, MapPin, MapView } from './types'

// `||`, not `??`: the image build defines the variable as an empty string when it is unset.
export const DEFAULT_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty'

/**
 * Where MapLibre's worker script is served from, copied out of `node_modules` by
 * `scripts/copy-maplibre-worker.mjs` (`predev` / `prebuild`).
 *
 * MapLibre 6 starts its worker from a separate file whose URL it derives from `import.meta.url`.
 * Webpack rewrites that to a `file://` path, MapLibre's resolver rejects any non-`http(s)` URL and
 * returns an empty string, and `new Worker('')` then loads the current *page* as the worker —
 * which dies silently. The worker is what fetches vector tiles and glyphs, so without this the map
 * draws only the raster world outline and never loads anything as you zoom in.
 */
export const WORKER_URL = '/maplibre/maplibre-gl-worker.mjs'

let workerUrlSet = false

/** Point MapLibre at our copy of the worker. Once per document, before the first `Map`. */
function pointAtOurWorker(): void {
  if (workerUrlSet || typeof window === 'undefined') return
  workerUrlSet = true
  maplibregl.setWorkerUrl(new URL(WORKER_URL, window.location.origin).href)
}

const PIN_COLORS: Record<MapPin['kind'], string> = {
  venue: 'hsl(163 48% 27%)',
  self: 'hsl(32 85% 33%)',
  coarse: 'hsl(32 85% 33%)',
  me: 'hsl(210 80% 45%)',
}

function pinElement(pin: MapPin): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.setAttribute('aria-label', pin.count !== undefined ? `${pin.label}, ${pin.count} session${pin.count === 1 ? '' : 's'}` : pin.label)
  el.dataset.pinId = pin.id
  el.className = 'sp-map-pin'
  el.style.cssText = 'background:none;border:0;padding:0;cursor:pointer;position:relative;display:block;'
  const color = PIN_COLORS[pin.kind]
  if (pin.kind === 'coarse') {
    // An approximate area, not a point: a soft disc roughly the size of the rounding cell.
    const disc = document.createElement('span')
    disc.style.cssText = `display:block;width:44px;height:44px;border-radius:9999px;background:${color};opacity:.28;border:2px dashed ${color};box-sizing:border-box;`
    el.appendChild(disc)
  } else if (pin.kind === 'me') {
    const dot = document.createElement('span')
    dot.style.cssText = `display:block;width:16px;height:16px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 0 0 2px ${color}66;`
    el.appendChild(dot)
  } else {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 32')
    svg.setAttribute('width', pin.selected ? '34' : '28')
    svg.setAttribute('height', pin.selected ? '44' : '36')
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML = `<path d="M12 0C5.4 0 0 5.4 0 12c0 8.6 12 20 12 20s12-11.4 12-20C24 5.4 18.6 0 12 0z" fill="${color}" stroke="white" stroke-width="1.5"/><circle cx="12" cy="12" r="4.5" fill="white"/>`
    svg.style.display = 'block'
    svg.style.filter = 'drop-shadow(0 1px 2px rgb(0 0 0 / .35))'
    el.appendChild(svg)
  }
  if (pin.count !== undefined && pin.count > 0) {
    const badge = document.createElement('span')
    badge.textContent = String(pin.count)
    badge.style.cssText = 'position:absolute;top:-6px;right:-8px;min-width:18px;height:18px;padding:0 5px;border-radius:9999px;background:white;color:#111;font:600 11px/18px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 1.5px rgb(0 0 0 / .25);'
    el.appendChild(badge)
  }
  if (pin.selected) el.style.zIndex = '2'
  return el
}

function boundsOf(pins: MapPin[]): maplibregl.LngLatBounds | null {
  if (!pins.length) return null
  const b = new maplibregl.LngLatBounds([pins[0]!.lng, pins[0]!.lat], [pins[0]!.lng, pins[0]!.lat])
  for (const p of pins) b.extend([p.lng, p.lat])
  return b
}

function viewOf(map: MapLibreMap): MapView {
  const c = map.getCenter()
  const b = map.getBounds()
  return {
    center: [Math.round(c.lng * 1e6) / 1e6, Math.round(c.lat * 1e6) / 1e6],
    zoom: Math.round(map.getZoom() * 100) / 100,
    bounds: [
      [Math.round(b.getWest() * 1e6) / 1e6, Math.round(b.getSouth() * 1e6) / 1e6],
      [Math.round(b.getEast() * 1e6) / 1e6, Math.round(b.getNorth() * 1e6) / 1e6],
    ],
  }
}

export default function MapCanvas({
  pins,
  view,
  fitToPins = true,
  interactive = true,
  styleUrl = DEFAULT_STYLE_URL,
  className,
  onPinClick,
  onPinDrag,
  onMapClick,
  onViewChange,
  onError,
  onReady,
  handleRef,
}: MapCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const mapRef = React.useRef<MapLibreMap | null>(null)
  const markersRef = React.useRef<Map<string, Marker>>(new Map())
  const [ready, setReady] = React.useState(false)
  const fittedRef = React.useRef(false)
  const latest = React.useRef({ onPinClick, onPinDrag, onMapClick, onViewChange, onError, onReady, pins })
  latest.current = { onPinClick, onPinDrag, onMapClick, onViewChange, onError, onReady, pins }

  // Create the map once.
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let map: MapLibreMap
    try {
      pointAtOurWorker()
      map = new maplibregl.Map({
        container,
        style: styleUrl,
        center: view?.center ?? [0, 20],
        zoom: view?.zoom ?? 1.5,
        interactive,
        attributionControl: { compact: false },
      })
    } catch (e) {
      console.warn('[map] could not start MapLibre:', e instanceof Error ? e.message : e)
      latest.current.onError?.()
      return
    }
    mapRef.current = map
    if (interactive) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // Markers are DOM, not style: they go on as soon as the map exists, so pins show even while a
    // slow style is still loading (and the page still gets a usable map if only the tiles are late).
    setReady(true)
    let errored = false
    map.on('error', (e) => {
      // A style or tile that will not load: the page falls back to its list.
      const status = (e as { error?: { status?: number } }).error?.status
      if (errored) return
      if (!map.isStyleLoaded() || status === 0) {
        errored = true
        console.warn('[map] style failed to load:', e.error?.message ?? 'unknown error')
        latest.current.onError?.()
      }
    })
    map.on('load', () => latest.current.onReady?.())
    map.on('click', (e) => {
      const target = e.originalEvent.target as HTMLElement | null
      if (target?.closest('.sp-map-pin')) return
      latest.current.onMapClick?.({ lat: Math.round(e.lngLat.lat * 1e6) / 1e6, lng: Math.round(e.lngLat.lng * 1e6) / 1e6 })
    })
    map.on('moveend', () => latest.current.onViewChange?.(viewOf(map)))
    return () => {
      for (const m of markersRef.current.values()) m.remove()
      markersRef.current.clear()
      map.remove()
      mapRef.current = null
      setReady(false)
    }
    // The map is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl, interactive])

  // Imperative handle for "Use this view", "Near me", re-fit.
  React.useEffect(() => {
    if (!handleRef) return
    const handle: MapHandle = {
      getView: () => (mapRef.current ? viewOf(mapRef.current) : null),
      flyTo: (lat, lng, zoom) => mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? Math.max(mapRef.current.getZoom(), 14), duration: 600 }),
      fitToPins: (only) => {
        const map = mapRef.current
        const b = boundsOf(only ?? latest.current.pins)
        if (map && b) map.fitBounds(b, { padding: 56, maxZoom: 16, duration: 400 })
      },
      setView: (v) => {
        const map = mapRef.current
        if (!map) return
        if (v.bounds) map.fitBounds(v.bounds, { padding: 0, duration: 0 })
        else map.jumpTo({ center: v.center, zoom: v.zoom })
      },
    }
    handleRef.current = handle
    return () => {
      handleRef.current = null
    }
  }, [handleRef])

  // Pins: rebuild markers when the list changes (cheap at the scale of a gathering).
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const m of markersRef.current.values()) m.remove()
    markersRef.current.clear()
    for (const pin of pins) {
      const marker = new maplibregl.Marker({
        element: pinElement(pin),
        anchor: pin.kind === 'coarse' || pin.kind === 'me' ? 'center' : 'bottom',
        draggable: !!pin.draggable,
      })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map)
      marker.getElement().addEventListener('click', (ev: MouseEvent) => {
        ev.stopPropagation()
        latest.current.onPinClick?.(pin.id)
      })
      if (pin.draggable) {
        marker.on('dragend', () => {
          const p = marker.getLngLat()
          latest.current.onPinDrag?.(pin.id, { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 })
        })
      }
      markersRef.current.set(pin.id, marker)
    }
    if (fitToPins && !fittedRef.current && !view && pins.length) {
      fittedRef.current = true
      const b = boundsOf(pins)
      if (b) map.fitBounds(b, { padding: 56, maxZoom: pins.length === 1 ? 15 : 16, duration: 0 })
    }
  }, [pins, ready, fitToPins, view])

  // A view supplied later (the organizer's saved area) is applied once.
  const appliedViewRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !view) return
    const key = JSON.stringify(view)
    if (appliedViewRef.current === key) return
    appliedViewRef.current = key
    if (view.bounds) map.fitBounds(view.bounds, { padding: 0, duration: 0 })
    else map.jumpTo({ center: view.center, zoom: view.zoom })
  }, [view, ready])

  return <div ref={containerRef} className={cn('h-full w-full', className)} role="region" aria-label="Map" />
}
