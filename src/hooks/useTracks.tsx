'use client'

import * as React from 'react'
import { apiFetch } from '@/lib/api/client'

export interface Track {
  id: string
  name: string
  slug: string
  description: string | null
  color: string | null
  display_order: number | null
}

interface UseTracksResult {
  tracks: Track[]
  isLoading: boolean
  error: string | null
}

/** The active tracks of one event (`GET /api/v1/events/[slug]/tracks`). */
export function useTracks(eventSlug: string | null | undefined): UseTracksResult {
  const [tracks, setTracks] = React.useState<Track[]>([])
  const [isLoading, setIsLoading] = React.useState(!!eventSlug)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!eventSlug) {
      setTracks([])
      setIsLoading(false)
      return
    }
    let mounted = true
    setIsLoading(true)
    apiFetch<{ tracks: Track[] }>(`/api/v1/events/${encodeURIComponent(eventSlug)}/tracks`)
      .then((data) => {
        if (!mounted) return
        setTracks(data.tracks)
        setError(null)
      })
      .catch((err) => {
        if (mounted) setError(err instanceof Error ? err.message : 'Tracks could not load')
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [eventSlug])

  return { tracks, isLoading, error }
}
