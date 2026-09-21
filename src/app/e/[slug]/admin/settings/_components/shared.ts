'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch, ApiError } from '@/lib/api/client'
import type { EventRow } from '@/types/event'
import { LEGACY_SOCIAL_ALIASES, LEGACY_SOCIAL_KEYS, LEGACY_SOCIAL_LABELS, MAX_SOCIAL_LINKS, type LegacySocialKey } from './labels'

// ============================================================================
// API helpers (same-origin, session cookie — plan §3.3)
// ============================================================================

export class SettingsError extends Error {
  constructor(message: string, public field: string | null = null, public status = 0, public code?: string) { super(message) }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown }): Promise<T> {
  try {
    return await apiFetch<T>(path, init)
  } catch (err) {
    if (err instanceof ApiError) {
      const message = err.status === 401 ? 'Sign in again to save your changes.' : err.message || 'Could not save event settings.'
      throw new SettingsError(message, err.field ?? null, err.status, err.code)
    }
    throw new SettingsError('Could not reach the server. Check your connection and try again.')
  }
}

/** One best-effort write to the network after a save (see `src/lib/events/network.ts`). */
export interface NetworkWrite { action: 'publish-gathering' | 'publish-policy'; ok: boolean; written: string[]; errors: string[] }

export interface SaveResult { event: EventRow & { actor_did?: string | null; atproto_published_at?: string | null }; notified: number; network?: NetworkWrite[] }

export function patchEventSettings(eventId: string, patch: Record<string, unknown>): Promise<SaveResult> {
  return request(`/api/events/${eventId}/settings`, { method: 'PATCH', json: patch })
}

export function deleteEvent(eventId: string): Promise<{ success: boolean }> {
  return request(`/api/events/${eventId}/settings`, { method: 'DELETE' })
}

export function createIdentity(eventId: string): Promise<{ did: string; handle: string; minted: boolean }> {
  return request(`/api/events/${eventId}/identity`, { method: 'POST', json: {} })
}

/** A sentence for the save banner when the network side of a save did not fully land. */
export function networkNote(result: SaveResult): string {
  const failed = (result.network ?? []).filter(w => !w.ok)
  if (!failed.length) return ''
  return ' Saved, but its public records were not all updated; retry from the Network page.'
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
      const message = typeof successMessage === 'function' ? successMessage(result) : successMessage
      setState({ status: 'saved', message: `${message}${networkNote(result)}` })
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

// ============================================================================
// Dirty tracking and the social-links list
// ============================================================================

/** Structural equality for the small plain objects sections build for `save()`. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface SocialLink { label: string; url: string }

type StoredSocial = Partial<Record<LegacySocialKey, string>> & { links?: SocialLink[] }

/** Legacy keys + `links` → one list for the editor (readers merge the same way). */
export function socialToLinks(social: unknown): SocialLink[] {
  const stored = (social && typeof social === 'object' ? social : {}) as StoredSocial
  const list: SocialLink[] = []
  for (const key of LEGACY_SOCIAL_KEYS) {
    const url = stored[key]
    if (typeof url === 'string' && url.trim()) list.push({ label: LEGACY_SOCIAL_LABELS[key], url: url.trim() })
  }
  for (const link of Array.isArray(stored.links) ? stored.links : []) {
    if (link && typeof link.url === 'string' && link.url.trim()) list.push({ label: String(link.label ?? '').trim(), url: link.url.trim() })
  }
  return list.slice(0, MAX_SOCIAL_LINKS)
}

/**
 * The editor's list → the stored shape: a label matching a legacy key (case-insensitively)
 * writes that key, everything else goes to `links`. Legacy keys with no entry are sent as
 * null so the server clears them.
 */
export function linksToSocial(links: SocialLink[]): Record<LegacySocialKey, string | null> & { links: SocialLink[] } {
  const social: Record<LegacySocialKey, string | null> & { links: SocialLink[] } = { twitter: null, telegram: null, discord: null, website: null, links: [] }
  for (const entry of links) {
    const raw = entry.url.trim()
    if (!raw) continue
    const url = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`
    const label = entry.label.trim() || hostLabel(url)
    const legacy = LEGACY_SOCIAL_ALIASES[label.toLowerCase()]
    if (legacy && !social[legacy]) social[legacy] = url
    else social.links.push({ label, url })
  }
  social.links = social.links.slice(0, MAX_SOCIAL_LINKS)
  return social
}

function hostLabel(url: string): string {
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '') } catch { return 'Link' }
}
