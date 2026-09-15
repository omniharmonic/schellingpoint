'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api/client'
import { useAuth } from './useAuth'

/**
 * The signed-in person's notifications, from `GET /api/me/notifications`.
 * Refreshes every 30 seconds while the tab is visible and whenever the window regains focus.
 */

export interface Notification {
  id: string
  event_id: string | null
  event_slug: string | null
  type: string
  title: string
  body: string | null
  data: Record<string, unknown> | null
  action_url: string | null
  created_at: string
  read_at: string | null
}

interface FeedResponse {
  notifications: Notification[]
  unreadCount: number
  nextCursor: string | null
}

interface UseNotificationsOptions {
  /** Only this event's notifications (by slug). */
  eventSlug?: string
  /** Page size, 1..50. */
  limit?: number
}

const POLL_MS = 30_000

/** Only app-relative links are followed from a notification. */
export function safeActionPath(url: string | null): string | null {
  return url && url.startsWith('/') && !url.startsWith('//') ? url : null
}

export function useNotifications(options: UseNotificationsOptions = {}) {
  const { limit = 10, eventSlug } = options
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Number of rows beyond the first page the person has loaded, so polling keeps them.
  const extraPages = useRef(0)

  const query = useCallback(
    (cursor?: string | null) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (eventSlug) params.set('event', eventSlug)
      if (cursor) params.set('cursor', cursor)
      return `/api/me/notifications?${params}`
    },
    [limit, eventSlug],
  )

  const fetchNotifications = useCallback(async () => {
    if (!userId) {
      setNotifications([])
      setUnreadCount(0)
      setNextCursor(null)
      setIsLoading(false)
      return
    }
    try {
      const data = await apiFetch<FeedResponse>(query())
      setUnreadCount(data.unreadCount)
      if (extraPages.current === 0) {
        setNotifications(data.notifications)
        setNextCursor(data.nextCursor)
      } else {
        // Older pages are loaded: update rows we already show and prepend new ones.
        setNotifications((prev) => {
          const fresh = new Map(data.notifications.map((n) => [n.id, n]))
          const known = new Set(prev.map((n) => n.id))
          return [...data.notifications.filter((n) => !known.has(n.id)), ...prev.map((n) => fresh.get(n.id) ?? n)]
        })
      }
      setError(null)
    } catch {
      setError('Failed to load notifications')
    } finally {
      setIsLoading(false)
    }
  }, [userId, query])

  const loadMore = useCallback(async () => {
    if (!userId || !nextCursor || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      const data = await apiFetch<FeedResponse>(query(nextCursor))
      extraPages.current += 1
      setNotifications((prev) => {
        const seen = new Set(prev.map((n) => n.id))
        return [...prev, ...data.notifications.filter((n) => !seen.has(n.id))]
      })
      setNextCursor(data.nextCursor)
      setUnreadCount(data.unreadCount)
    } catch {
      setError('Failed to load more notifications')
    } finally {
      setIsLoadingMore(false)
    }
  }, [userId, nextCursor, isLoadingMore, query])

  const markRead = useCallback(async (body: { ids: string[] } | { all: true; event?: string }) => {
    await apiFetch<{ updated: number }>('/api/me/notifications/read', { method: 'POST', json: body })
  }, [])

  const markAsRead = useCallback(
    async (notificationId: string) => {
      if (!userId) return
      const now = new Date().toISOString()
      let changed = false
      setNotifications((prev) =>
        prev.map((n) => {
          if (n.id !== notificationId || n.read_at) return n
          changed = true
          return { ...n, read_at: now }
        }),
      )
      if (changed) setUnreadCount((c) => Math.max(0, c - 1))
      try {
        await markRead({ ids: [notificationId] })
      } catch {
        fetchNotifications()
      }
    },
    [userId, markRead, fetchNotifications],
  )

  const markAllAsRead = useCallback(async () => {
    if (!userId) return
    const now = new Date().toISOString()
    setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })))
    setUnreadCount(0)
    try {
      await markRead(eventSlug ? { all: true, event: eventSlug } : { all: true })
    } catch {
      fetchNotifications()
    }
  }, [userId, eventSlug, markRead, fetchNotifications])

  // Initial load, and reload when the person or scope changes.
  useEffect(() => {
    extraPages.current = 0
    setIsLoading(true)
    fetchNotifications()
  }, [fetchNotifications])

  // Poll while visible; refresh on focus. No realtime channel.
  useEffect(() => {
    if (!userId) return
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') fetchNotifications()
    }
    const timer = window.setInterval(refreshIfVisible, POLL_MS)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [userId, fetchNotifications])

  return {
    notifications,
    unreadCount,
    isLoading,
    isLoadingMore,
    hasMore: nextCursor !== null,
    error,
    markAsRead,
    markAllAsRead,
    loadMore,
    refresh: fetchNotifications,
    refreshCount: fetchNotifications,
  }
}
