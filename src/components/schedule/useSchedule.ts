'use client'

/**
 * The schedule's data layer, shared by both tabs (mobile shell design §4).
 *
 * `useSchedule('program')` reads the published program (`status=scheduled&timed=1`);
 * `useSchedule('mine')` reads the viewer's saved sessions (`favorites=1`), including the ones with
 * no time yet so the "Not yet scheduled" tail has something to show. Saving and un-saving go
 * through the same route either way, and on the saved tab an un-save takes the row out of the list.
 *
 * Nothing here reads or exposes a vote count: the sessions route never sends one (spec §5.3).
 */

import * as React from 'react'
import { setFavorite } from '@/components/SessionCard'
import { apiFetch, listFrom } from '@/lib/api/client'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

export type ScheduleViewMode = 'program' | 'mine'

/** A session with the time it happens: its slot, or the host's own time when self-hosted. */
export type ScheduleSession = SessionView & { when: { start_time: string; end_time: string | null } | null }

export function withWhen(session: SessionView): ScheduleSession {
  const start = session.time_slot?.start_time ?? (session.is_self_hosted ? session.self_hosted_start_time : null)
  const end = session.time_slot?.end_time ?? (session.is_self_hosted ? session.self_hosted_end_time : null)
  return { ...session, when: start ? { start_time: start, end_time: end } : null }
}

/** YYYY-MM-DD of an instant in the gathering's timezone, so day boundaries are the organizer's. */
export function dateKey(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(isoString),
  )
}

export function dayLabel(isoString: string, timeZone: string): string {
  return new Date(isoString).toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' })
}

export interface ScheduleData {
  sessions: ScheduleSession[]
  favoriteIds: ReadonlySet<string>
  togglingIds: ReadonlySet<string>
  loading: boolean
  loadError: string | null
  actionError: string | null
  clearActionError: () => void
  /** Flips the favourite; on the saved tab the row leaves the list. Never throws. */
  toggleFavorite: (sessionId: string) => Promise<{ saved: boolean } | null>
}

const QUERY: Record<ScheduleViewMode, string> = {
  program: 'status=scheduled&timed=1&sort=time',
  mine: 'favorites=1&sort=time',
}

export function useSchedule(eventSlug: string, view: ScheduleViewMode, enabled: boolean): ScheduleData {
  const [sessions, setSessions] = React.useState<ScheduleSession[]>([])
  const [favoriteIds, setFavoriteIds] = React.useState<ReadonlySet<string>>(new Set<string>())
  const [togglingIds, setTogglingIds] = React.useState<ReadonlySet<string>>(new Set<string>())
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  // Removed rows are kept so Undo can put them back without a re-read.
  const removed = React.useRef(new Map<string, ScheduleSession>())

  React.useEffect(() => {
    if (!enabled) {
      setSessions([])
      setLoading(false)
      return
    }
    let mounted = true
    setLoading(true)
    apiFetch<{ sessions: SessionView[] }>(
      `/api/v1/events/${encodeURIComponent(eventSlug)}/sessions?${QUERY[view]}`,
      { cache: 'no-store' },
    )
      .then((data) => {
        if (!mounted) return
        const rows = listFrom<SessionView>(data, 'sessions').map(withWhen)
        setSessions(rows)
        setFavoriteIds(new Set(rows.filter((s) => s.is_favorite).map((s) => s.id)))
        setLoadError(null)
      })
      .catch((err) => {
        if (mounted) setLoadError(err instanceof Error ? err.message : 'The schedule could not be loaded.')
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [eventSlug, view, enabled])

  const toggleFavorite = React.useCallback(
    async (sessionId: string) => {
      const wasSaved = favoriteIds.has(sessionId)
      const next = !wasSaved
      const row = sessions.find((s) => s.id === sessionId) ?? removed.current.get(sessionId) ?? null
      setActionError(null)
      setTogglingIds((prev) => new Set(prev).add(sessionId))
      const flip = (on: boolean) =>
        setFavoriteIds((prev) => {
          const set = new Set(prev)
          if (on) set.add(sessionId)
          else set.delete(sessionId)
          return set
        })
      flip(next)
      // On the saved tab the list *is* the favourites, so an un-save removes the row.
      if (view === 'mine') {
        if (next) {
          if (row) setSessions((prev) => (prev.some((s) => s.id === sessionId) ? prev : [...prev, row]))
        } else {
          if (row) removed.current.set(sessionId, row)
          setSessions((prev) => prev.filter((s) => s.id !== sessionId))
        }
      }
      try {
        await setFavorite(eventSlug, sessionId, next)
        return { saved: next }
      } catch (err) {
        flip(wasSaved)
        if (view === 'mine') {
          if (next) setSessions((prev) => prev.filter((s) => s.id !== sessionId))
          else if (row) setSessions((prev) => (prev.some((s) => s.id === sessionId) ? prev : [...prev, row]))
        }
        setActionError(err instanceof Error ? err.message : 'Your saved schedule could not be updated.')
        return null
      } finally {
        setTogglingIds((prev) => {
          const set = new Set(prev)
          set.delete(sessionId)
          return set
        })
      }
    },
    [eventSlug, favoriteIds, sessions, view],
  )

  return {
    sessions,
    favoriteIds,
    togglingIds,
    loading,
    loadError,
    actionError,
    clearActionError: React.useCallback(() => setActionError(null), []),
    toggleFavorite,
  }
}
