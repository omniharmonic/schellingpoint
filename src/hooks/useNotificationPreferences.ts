'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api/client'
import {
  CATEGORY_INFO,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '@/lib/notifications/categories'
import { useAuth } from './useAuth'

/**
 * Notification preferences from `/api/me/notification-preferences`, for one event (by slug)
 * or globally. Values are effective: the event's choice, else the global one, else defaults.
 */

export type { NotificationCategory }
export { NOTIFICATION_CATEGORIES }

export type NotificationChannel = 'email_enabled' | 'in_app_enabled' | 'push_enabled'

export interface NotificationPreference {
  category: NotificationCategory
  email_enabled: boolean
  in_app_enabled: boolean
  push_enabled: boolean
  source: 'event' | 'global' | 'default'
}

/** Category metadata for display. */
export const categoryInfo = CATEGORY_INFO

interface PreferencesResponse {
  scope: 'global' | 'event'
  preferences: NotificationPreference[]
}

const DEFAULTS = { email_enabled: true, in_app_enabled: true, push_enabled: false }

interface UseNotificationPreferencesOptions {
  eventSlug?: string
}

export function useNotificationPreferences(options: UseNotificationPreferencesOptions = {}) {
  const { eventSlug } = options
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [preferences, setPreferences] = useState<NotificationPreference[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [savingCategory, setSavingCategory] = useState<NotificationCategory | null>(null)
  const [error, setError] = useState<string | null>(null)

  const path = eventSlug
    ? `/api/me/notification-preferences?event=${encodeURIComponent(eventSlug)}`
    : '/api/me/notification-preferences'

  const fetchPreferences = useCallback(async () => {
    if (!userId) {
      setPreferences([])
      setIsLoading(false)
      return
    }
    try {
      const data = await apiFetch<PreferencesResponse>(path)
      setPreferences(data.preferences)
      setError(null)
    } catch {
      setError('Failed to load preferences')
    } finally {
      setIsLoading(false)
    }
  }, [userId, path])

  const getPreference = useCallback(
    (category: NotificationCategory): NotificationPreference =>
      preferences.find((p) => p.category === category) ?? { category, ...DEFAULTS, source: 'default' },
    [preferences],
  )

  const updatePreference = useCallback(
    async (category: NotificationCategory, updates: Partial<Pick<NotificationPreference, NotificationChannel>>) => {
      if (!userId) return
      const previous = preferences
      setPreferences((prev) => prev.map((p) => (p.category === category ? { ...p, ...updates } : p)))
      setSavingCategory(category)
      try {
        const data = await apiFetch<PreferencesResponse>(path, {
          method: 'PUT',
          json: { preferences: [{ category, ...updates }] },
        })
        setPreferences(data.preferences)
        setError(null)
      } catch {
        setPreferences(previous)
        setError('Failed to save preference')
      } finally {
        setSavingCategory(null)
      }
    },
    [userId, preferences, path],
  )

  const toggleChannel = useCallback(
    async (category: NotificationCategory, channel: NotificationChannel) => {
      const current = getPreference(category)
      await updatePreference(category, { [channel]: !current[channel] })
    },
    [getPreference, updatePreference],
  )

  useEffect(() => {
    setIsLoading(true)
    fetchPreferences()
  }, [fetchPreferences])

  return {
    preferences,
    isLoading,
    isSaving: savingCategory !== null,
    savingCategory,
    error,
    getPreference,
    updatePreference,
    toggleChannel,
    refresh: fetchPreferences,
  }
}
