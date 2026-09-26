'use client'

/**
 * The click-to-add-vertex outline tool (design §1.4). No draw library: the ring lives in React
 * state, `MapCanvas` renders it through a MapLibre GeoJSON source with fill and line layers, and
 * the map's own click, double-click and Escape events drive it.
 *
 *   click on the map   adds a corner
 *   double-click       closes the shape (so does "Done")
 *   Escape             cancels the drawing and leaves the stored outline alone
 *   "Clear"            removes the stored outline
 *
 * The shape is validated with `parseOutline` — the same function the venues route enforces — before
 * it is sent, so nothing the editor accepted can be refused on save. Outlines are app-side only and
 * a private residence cannot have one at all, which is why the tool is hidden for those rooms.
 */
import * as React from 'react'
import { Check, Pencil, Trash2, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { OUTLINE_MAX_VERTICES, OUTLINE_MIN_VERTICES, OutlineError, parseOutline, type OutlinePolygon } from '@/lib/geo/outline'
import type { LatLng } from '@/lib/geo/coarse'
import type { LngLat } from './types'

export interface OutlineDrawing {
  /** The room being drawn, or null when the tool is idle. */
  venueId: string | null
  /** The open ring so far, one vertex per click. */
  ring: LngLat[]
  /** `MapCanvas`'s `draft` prop: null while idle. */
  draft: LngLat[] | null
  start: (venueId: string) => void
  addVertex: (point: LatLng) => void
  undo: () => void
  cancel: () => void
  /** Close the ring and hand the polygon to `onSave`. */
  done: () => void
  saving: boolean
  error: string | null
  setError: (message: string | null) => void
}

export interface UseOutlineDrawingOptions {
  /** Persist the finished polygon (the venues PATCH route). */
  onSave: (venueId: string, outline: OutlinePolygon) => Promise<void>
  /** The room's pin, which the outline must sit within 50 km of. */
  pinOf: (venueId: string) => LatLng | null
}

export function useOutlineDrawing({ onSave, pinOf }: UseOutlineDrawingOptions): OutlineDrawing {
  const [venueId, setVenueId] = React.useState<string | null>(null)
  const [ring, setRing] = React.useState<LngLat[]>([])
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const cancel = React.useCallback(() => {
    setVenueId(null)
    setRing([])
    setError(null)
  }, [])

  const start = React.useCallback((id: string) => {
    setVenueId(id)
    setRing([])
    setError(null)
  }, [])

  const addVertex = React.useCallback((point: LatLng) => {
    setError(null)
    setRing((current) => {
      if (current.length >= OUTLINE_MAX_VERTICES) return current
      return [...current, [point.lng, point.lat]]
    })
  }, [])

  const undo = React.useCallback(() => {
    setError(null)
    setRing((current) => current.slice(0, -1))
  }, [])

  const done = React.useCallback(() => {
    if (!venueId) return
    if (ring.length < OUTLINE_MIN_VERTICES) {
      setError(`An outline needs at least ${OUTLINE_MIN_VERTICES} corners.`)
      return
    }
    let polygon: OutlinePolygon | null
    try {
      polygon = parseOutline({ type: 'Polygon', coordinates: [[...ring, ring[0]!]] }, pinOf(venueId))
    } catch (e) {
      setError(e instanceof OutlineError ? e.message : 'That outline could not be used.')
      return
    }
    if (!polygon) {
      setError('That outline could not be used.')
      return
    }
    setSaving(true)
    const id = venueId
    onSave(id, polygon)
      .then(() => {
        setVenueId(null)
        setRing([])
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'The outline could not be saved.'))
      .finally(() => setSaving(false))
  }, [onSave, pinOf, ring, venueId])

  // Escape cancels, wherever the focus is.
  React.useEffect(() => {
    if (!venueId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [venueId, cancel])

  return {
    venueId,
    ring,
    draft: venueId ? ring : null,
    start,
    addVertex,
    undo,
    cancel,
    done,
    saving,
    error,
    setError,
  }
}

export interface OutlineToolProps {
  drawing: OutlineDrawing
  /** The room being drawn, for the instruction line. */
  venueName: string | null
}

/** The instruction bar shown over the map while an outline is being drawn. */
export function OutlineTool({ drawing, venueName }: OutlineToolProps) {
  if (!drawing.venueId) return null
  const corners = drawing.ring.length
  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" role="status" data-testid="outline-tool">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Click the map to trace <strong>{venueName ?? 'this room'}</strong>.{' '}
          {corners === 0
            ? 'Its corners, in order.'
            : `${corners} of at most ${OUTLINE_MAX_VERTICES} corners · double-click or Done to close.`}
        </span>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={drawing.undo} disabled={corners === 0 || drawing.saving}>
            <Undo2 className="mr-1.5 h-4 w-4" aria-hidden />
            Undo
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={drawing.cancel} disabled={drawing.saving}>
            <X className="mr-1.5 h-4 w-4" aria-hidden />
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={drawing.done} loading={drawing.saving} disabled={corners < OUTLINE_MIN_VERTICES}>
            <Check className="mr-1.5 h-4 w-4" aria-hidden />
            Done
          </Button>
        </div>
      </div>
      {drawing.error && <p className="text-sm text-destructive" role="alert">{drawing.error}</p>}
    </div>
  )
}

export interface OutlineButtonsProps {
  hasOutline: boolean
  disabled?: boolean
  busy?: boolean
  onDraw: () => void
  onClear: () => void
}

/** "Outline" / "Redraw" and "Clear" for one room in the editor's list. */
export function OutlineButtons({ hasOutline, disabled, busy, onDraw, onClear }: OutlineButtonsProps) {
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={onDraw} disabled={disabled}>
        <Pencil className="mr-1.5 h-4 w-4" aria-hidden />
        {hasOutline ? 'Redraw' : 'Outline'}
      </Button>
      {hasOutline && (
        <Button type="button" size="sm" variant="ghost" onClick={onClear} loading={busy} aria-label="Clear this room’s outline">
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      )}
    </>
  )
}
