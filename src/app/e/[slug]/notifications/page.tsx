'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bell, CheckCheck, ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DashboardLayout } from '@/components/DashboardLayout'
import { safeActionPath, useNotifications, type Notification } from '@/hooks/useNotifications'
import { TYPE_LABELS } from '@/lib/notifications/categories'
import { useEvent } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { formatDistanceToNow, format } from 'date-fns'

// Color styles for notification types
const typeStyles: Record<string, string> = {
  session_approved: 'bg-green-500',
  session_rejected: 'bg-red-500',
  session_scheduled: 'bg-blue-500',
  session_rescheduled: 'bg-yellow-500',
  session_cancelled: 'bg-red-500',
  cohost_invited: 'bg-indigo-500',
  cohost_accepted: 'bg-green-500',
  cohost_declined: 'bg-orange-500',
  voting_opened: 'bg-primary',
  voting_closed: 'bg-muted-foreground',
  schedule_published: 'bg-primary',
  event_reminder: 'bg-blue-500',
  admin_announcement: 'bg-primary',
  new_proposal: 'bg-cyan-500',
  proposal_needs_review: 'bg-yellow-500',
  proposal_changed: 'bg-yellow-500',
  approval_requested: 'bg-orange-500',
  event_invitation: 'bg-indigo-500',
  ticket_confirmed: 'bg-green-500',
  default: 'bg-muted-foreground',
}

function NotificationRow({
  notification,
  onMarkAsRead,
}: {
  notification: Notification
  onMarkAsRead: (id: string) => void
}) {
  const router = useRouter()
  const isUnread = !notification.read_at
  const style = typeStyles[notification.type] || typeStyles.default
  const typeLabel = TYPE_LABELS[notification.type] || notification.type

  const handleClick = () => {
    if (isUnread) {
      onMarkAsRead(notification.id)
    }
    const target = safeActionPath(notification.action_url)
    if (target) {
      router.push(target)
    }
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        'w-full text-left p-4 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0 flex items-start gap-4',
        isUnread && 'bg-muted/30'
      )}
    >
      {/* Type indicator */}
      <div className="flex-shrink-0 mt-1">
        <div className={cn('w-2.5 h-2.5 rounded-full', style)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-muted-foreground tracking-wide">
            {typeLabel}
          </span>
          {isUnread && (
            <span className="text-xs font-medium text-primary">New</span>
          )}
        </div>
        <p className={cn('text-sm', isUnread ? 'font-medium' : 'text-muted-foreground')}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
            {notification.body}
          </p>
        )}
      </div>

      {/* Timestamp */}
      <div className="flex-shrink-0 text-right">
        <p className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
        </p>
        <p className="text-xs text-muted-foreground/60 mt-0.5">
          {format(new Date(notification.created_at), 'MMM d, h:mm a')}
        </p>
      </div>
    </button>
  )
}

export default function NotificationsPage() {
  const event = useEvent()
  const {
    notifications,
    unreadCount,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    markAsRead,
    markAllAsRead,
    loadMore,
  } = useNotifications({ eventSlug: event.slug, limit: 30 })

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="page-heading">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/e/${event.slug}/dashboard`}>
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Link>
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Notifications</h1>
              <p className="text-sm text-muted-foreground">
                {unreadCount > 0
                  ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`
                  : 'All caught up!'}
              </p>
            </div>
          </div>

          {unreadCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => markAllAsRead()}>
              <CheckCheck className="h-4 w-4 mr-2" />
              Mark all as read
            </Button>
          )}
        </div>

        {/* Notifications list */}
        <Card>
          <CardContent className="p-0">
            {error && notifications.length === 0 && !isLoading ? (
              <div className="py-12 text-center text-sm text-muted-foreground">{error}</div>
            ) : isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Bell className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="font-medium text-lg mb-1">No notifications</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  When something happens with your sessions or the event, you&apos;ll see it here.
                </p>
              </div>
            ) : (
              <div>
                {notifications.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onMarkAsRead={markAsRead}
                  />
                ))}
                {hasMore && (
                  <div className="p-3 text-center">
                    <Button variant="ghost" size="sm" onClick={() => loadMore()} disabled={isLoadingMore}>
                      {isLoadingMore && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Load older notifications
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
