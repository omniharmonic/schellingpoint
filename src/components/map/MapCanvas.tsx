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
import type { LngLat, MapCanvasProps, MapHandle, MapImage, MapPin, MapShape, MapView } from './types'

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
  corner: 'hsl(262 60% 45%)',
}

/** Venue outlines (design §1.4): the same green as a room pin, at fill weight. */
const SHAPE_COLOR = 'hsl(163 48% 27%)'
const DRAFT_COLOR = 'hsl(32 85% 33%)'

const SOURCES = {
  shapes: 'sp-shapes',
  draft: 'sp-draft',
  image: 'sp-custom-map',
} as const
const LAYERS = {
  image: 'sp-custom-map-layer',
  shapeFill: 'sp-shapes-fill',
  shapeLine: 'sp-shapes-line',
  draftFill: 'sp-draft-fill',
  draftLine: 'sp-draft-line',
  draftPoints: 'sp-draft-points',
} as const

function shapeCollection(shapes: readonly MapShape[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: shapes.map((shape) => ({
      type: 'Feature' as const,
      id: shape.id,
      properties: { id: shape.id, label: shape.label, selected: shape.selected ? 1 : 0 },
      geometry: { type: 'Polygon' as const, coordinates: [shape.ring] },
    })),
  }
}

/** The ring being drawn: a polygon once it has three corners, a line before that, plus its corners. */
function draftCollection(ring: readonly LngLat[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  if (ring.length >= 3) {
    features.push({
      type: 'Feature',
      properties: { kind: 'area' },
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
    })
  } else if (ring.length === 2) {
    features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: [...ring] } })
  }
  for (const point of ring) {
    features.push({ type: 'Feature', properties: { kind: 'vertex' }, geometry: { type: 'Point', coordinates: point } })
  }
  return { type: 'FeatureCollection', features }
}

/** The label that names an outline: a DOM marker, so no glyph font is needed (image-only mode has none). */
function shapeLabelElement(shape: MapShape): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'sp-map-shape-label'
  el.dataset.shapeId = shape.id
  el.textContent = shape.label
  el.setAttribute('aria-label', shape.label)
  el.style.cssText =
    'max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;'
    + 'background:rgb(255 255 255 / .92);color:#111;border:1px solid rgb(0 0 0 / .18);border-radius:4px;'
    + `padding:1px 6px;font:600 11px/16px system-ui,sans-serif;box-shadow:0 1px 2px rgb(0 0 0 / .2);${shape.selected ? 'outline:2px solid ' + SHAPE_COLOR + ';' : ''}`
  return el
}

/** The centre of a ring's bounding box: where its label sits. */
function ringCenter(ring: readonly LngLat[]): [number, number] {
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [(west + east) / 2, (south + north) / 2]
}

/**
 * A style with no basemap at all: the image-only custom map (design §1.5). No tile source is
 * requested, so no tiles are fetched and nothing of the real world is drawn.
 */
function blankStyle(): NonNullable<maplibregl.MapOptions['style']> {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'sp-blank', type: 'background', paint: { 'background-color': 'hsl(150 8% 96%)' } }],
  }
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
  } else if (pin.kind === 'corner') {
    // A custom map's corner handle: a square, because it is dragged, not pointed with.
    const handle = document.createElement('span')
    handle.style.cssText = `display:block;width:16px;height:16px;border-radius:3px;background:${color};border:2px solid white;box-shadow:0 1px 3px rgb(0 0 0 / .4);`
    el.appendChild(handle)
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
  shapes,
  draft,
  image,
  basemap = true,
  clampTo,
  onPinClick,
  onPinDrag,
  onMapClick,
  onMapDoubleClick,
  onShapeClick,
  onViewChange,
  onError,
  onReady,
  handleRef,
}: MapCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const mapRef = React.useRef<MapLibreMap | null>(null)
  const markersRef = React.useRef<Map<string, Marker>>(new Map())
  const labelsRef = React.useRef<Map<string, Marker>>(new Map())
  const [ready, setReady] = React.useState(false)
  const fittedRef = React.useRef(false)
  const latest = React.useRef({ onPinClick, onPinDrag, onMapClick, onMapDoubleClick, onShapeClick, onViewChange, onError, onReady, pins, draft })
  latest.current = { onPinClick, onPinDrag, onMapClick, onMapDoubleClick, onShapeClick, onViewChange, onError, onReady, pins, draft }

  // Create the map once.
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let map: MapLibreMap
    try {
      pointAtOurWorker()
      map = new maplibregl.Map({
        container,
        // An image-only custom map (design §1.5) hides the basemap: no tile source is even asked for.
        style: basemap ? styleUrl : blankStyle(),
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
      if (target?.closest('.sp-map-pin') || target?.closest('.sp-map-shape-label')) return
      // An outline behaves like a pin: clicking it opens that room. While an outline is being
      // drawn every click is a vertex instead, so the tool is never fighting the shapes under it.
      if (!latest.current.draft && latest.current.onShapeClick && map.getLayer(LAYERS.shapeFill)) {
        const hit = map.queryRenderedFeatures(e.point, { layers: [LAYERS.shapeFill] })[0]
        const id = hit?.properties?.id
        if (typeof id === 'string') {
          latest.current.onShapeClick(id)
          return
        }
      }
      latest.current.onMapClick?.({ lat: Math.round(e.lngLat.lat * 1e6) / 1e6, lng: Math.round(e.lngLat.lng * 1e6) / 1e6 })
    })
    map.on('dblclick', (e) => {
      if (!latest.current.onMapDoubleClick) return
      const target = e.originalEvent.target as HTMLElement | null
      if (target?.closest('.sp-map-pin')) return
      latest.current.onMapDoubleClick({ lat: Math.round(e.lngLat.lat * 1e6) / 1e6, lng: Math.round(e.lngLat.lng * 1e6) / 1e6 })
    })
    map.on('moveend', () => latest.current.onViewChange?.(viewOf(map)))
    return () => {
      for (const m of markersRef.current.values()) m.remove()
      markersRef.current.clear()
      for (const m of labelsRef.current.values()) m.remove()
      labelsRef.current.clear()
      map.remove()
      mapRef.current = null
      setReady(false)
    }
    // The map is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl, interactive, basemap])

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
        anchor: pin.kind === 'coarse' || pin.kind === 'me' || pin.kind === 'corner' ? 'center' : 'bottom',
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

  /**
   * Overlays: the custom map image, then the venue outlines, then the outline being drawn — in that
   * order, so the picture is under the shapes and the pins (DOM markers) stay above all of it.
   * Rebuilt whole on every change; a gathering has a handful of rooms, so this is cheaper than
   * diffing and it cannot drift out of step with the props.
   */
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    let cancelled = false

    const build = () => {
      if (cancelled || !mapRef.current) return
      for (const layer of Object.values(LAYERS)) if (map.getLayer(layer)) map.removeLayer(layer)
      for (const source of Object.values(SOURCES)) if (map.getSource(source)) map.removeSource(source)
      for (const marker of labelsRef.current.values()) marker.remove()
      labelsRef.current.clear()

      if (image) {
        map.addSource(SOURCES.image, { type: 'image', url: image.url, coordinates: image.corners })
        map.addLayer({
          id: LAYERS.image,
          type: 'raster',
          source: SOURCES.image,
          paint: { 'raster-opacity': image.opacity, 'raster-fade-duration': 0 },
        })
      }

      if (shapes && shapes.length) {
        map.addSource(SOURCES.shapes, { type: 'geojson', data: shapeCollection(shapes) })
        map.addLayer({
          id: LAYERS.shapeFill,
          type: 'fill',
          source: SOURCES.shapes,
          paint: { 'fill-color': SHAPE_COLOR, 'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.34, 0.18] },
        })
        map.addLayer({
          id: LAYERS.shapeLine,
          type: 'line',
          source: SOURCES.shapes,
          paint: { 'line-color': SHAPE_COLOR, 'line-width': ['case', ['==', ['get', 'selected'], 1], 3, 2] },
        })
        for (const shape of shapes) {
          if (shape.ring.length < 3) continue
          const marker = new maplibregl.Marker({ element: shapeLabelElement(shape), anchor: 'center' })
            .setLngLat(ringCenter(shape.ring))
            .addTo(map)
          marker.getElement().addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation()
            latest.current.onShapeClick?.(shape.id)
          })
          labelsRef.current.set(shape.id, marker)
        }
      }

      if (draft && draft.length) {
        map.addSource(SOURCES.draft, { type: 'geojson', data: draftCollection(draft) })
        map.addLayer({
          id: LAYERS.draftFill,
          type: 'fill',
          source: SOURCES.draft,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': DRAFT_COLOR, 'fill-opacity': 0.2 },
        })
        map.addLayer({
          id: LAYERS.draftLine,
          type: 'line',
          source: SOURCES.draft,
          filter: ['!=', ['geometry-type'], 'Point'],
          paint: { 'line-color': DRAFT_COLOR, 'line-width': 2, 'line-dasharray': [2, 1] },
        })
        map.addLayer({
          id: LAYERS.draftPoints,
          type: 'circle',
          source: SOURCES.draft,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': DRAFT_COLOR, 'circle-stroke-width': 2 },
        })
      }
    }

    if (map.isStyleLoaded()) build()
    else map.once('styledata', build)
    return () => {
      cancelled = true
    }
  }, [shapes, draft, image, ready])

  // While an outline is being drawn a double-click closes it, so it must not also zoom.
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !interactive) return
    const drawing = !!draft
    if (drawing) map.doubleClickZoom.disable()
    else map.doubleClickZoom.enable()
  }, [draft, ready, interactive])

  // Image-only mode: the picture is all there is, so the view stays on it.
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!clampTo) {
      map.setMaxBounds(null)
      map.setMinZoom(null)
      return
    }
    map.fitBounds(clampTo, { padding: 24, duration: 0 })
    map.setMaxBounds(clampTo)
    map.setMinZoom(Math.max(0, map.getZoom() - 1))
  }, [clampTo, ready])

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
