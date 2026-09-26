'use client'

/**
 * The gathering map (spec §8.2): MapLibre loaded lazily on the client only. While the canvas
 * loads a neutral placeholder holds its space; if the style or WebGL fails, `fallback` (the
 * page's list view) takes over and `onError` is reported so the page can switch its layout.
 */
import * as React from 'react'
import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MapCanvasProps } from './types'

export type { LngLat, MapHandle, MapImage, MapPin, MapShape, MapView } from './types'

const MapCanvas = dynamic(() => import('./MapCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground" aria-busy="true">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      <span className="sr-only">Loading the map</span>
    </div>
  ),
})

export interface GatheringMapProps extends MapCanvasProps {
  /** Shown instead of the map when it cannot load. */
  fallback?: React.ReactNode
}

export function GatheringMap({ fallback, onError, className, ...props }: GatheringMapProps) {
  const [failed, setFailed] = React.useState(false)
  const handleError = React.useCallback(() => {
    setFailed(true)
    onError?.()
  }, [onError])
  if (failed) {
    return (
      <div className={cn('h-full w-full', className)}>
        {fallback ?? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            The map could not be loaded.
          </div>
        )}
      </div>
    )
  }
  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <MapCanvas {...props} onError={handleError} />
    </div>
  )
}
