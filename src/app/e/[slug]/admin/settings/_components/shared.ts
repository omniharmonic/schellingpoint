'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { EventRow } from '@/types/event'

// ============================================================================
// Auth + API helpers (localStorage bearer token, same as the rest of the app)
// ============================================================================

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const key = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`
    return JSON.parse(localStorage.getItem(key) || '{}').access_token || null
  } catch { return null }
}

export class SettingsError extends Error {
  constructor(message: string, public field: string | null = null, public status = 0) { super(message) }
}

async function request(path: string, init: RequestInit) {
  const token = getAccessToken()
  if (!token) throw new SettingsError('Sign in again to save your changes.')
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new SettingsError(data.error || 'Could not save event settings.', data.field ?? null, response.status)
  return data
}

export interface SaveResult { event: EventRow; notified: number }

export function patchEventSettings(eventId: string, patch: Record<string, unknown>): Promise<SaveResult> {
  return request(`/api/events/${eventId}/settings`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteEvent(eventId: string): Promise<{ success: boolean }> {
  return request(`/api/events/${eventId}/settings`, { method: 'DELETE' })
}

// ============================================================================
// Per-section save state
// ============================================================================

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
export interface SaveState { status: SaveStatus; message?: string; field?: string | null }

/**
 * Each settings section saves on its own. After a successful save the server
 * layout is refreshed so `useEvent()` reflects the new values everywhere.
 */
export function useSectionSave(eventId: string) {
  const router = useRouter()
  const [state, setState] = React.useState<SaveState>({ status: 'idle' })
  const save = React.useCallback(async (patch: Record<string, unknown>, successMessage: string | ((result: SaveResult) => string) = 'Saved.'): Promise<SaveResult | null> => {
    setState({ status: 'saving' })
    try {
      const result = await patchEventSettings(eventId, patch)
      setState({ status: 'saved', message: typeof successMessage === 'function' ? successMessage(result) : successMessage })
      router.refresh()
      return result
    } catch (err) {
      const error = err instanceof SettingsError ? err : new SettingsError(err instanceof Error ? err.message : 'Could not save event settings.')
      setState({ status: 'error', message: error.message, field: error.field })
      return null
    }
  }, [eventId, router])
  const reset = React.useCallback(() => setState({ status: 'idle' }), [])
  return { state, save, reset }
}

// ============================================================================
// Event-timezone datetime helpers (datetime-local <-> instants)
// ============================================================================

/** Render an instant as the event's wall-clock time for a datetime-local input. */
export function toEventLocal(date: Date | null | undefined, timezone: string): string {
  if (!date) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
    const part = (type: string) => parts.find(p => p.type === type)?.value ?? '00'
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
  } catch { return '' }
}

/** Format a date-only column (YYYY-MM-DD) for a date input. */
export function toDateInput(date: Date | null | undefined): string {
  return date ? date.toISOString().slice(0, 10) : ''
}
