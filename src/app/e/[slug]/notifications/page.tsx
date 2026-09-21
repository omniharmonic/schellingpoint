'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bell, CheckCheck, Loader2, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { safeActionPath, useNotifications, type Notification } from '@/hooks/useNotifications'
import { notificationType } from '@/lib/labels'
import { plural } from '@/lib/format'
import { useEvent } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'
import { formatDistanceToNow, format } from 'date-fns'

function NotificationRow({
  notification,
  onMarkAsRead,
}: {
  notification: Notification
  onMarkAsRead: (id: string) => void
}) {
  const router = useRouter()
  const isUnread = !notification.read_at
  const { label, dot } = notificationType(notification.type)

  const handleClick = () => {
    if (isUnread) onMarkAsRead(notification.id)
    const target = safeActionPath(notification.action_url)
    if (target) router.push(target)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'w-full text-left p-4 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0 flex items-start gap-4',
        isUnread && 'bg-muted/30'
      )}
    >
      <div className="flex-shrink-0 mt-1">
        <div className={cn('w-2.5 h-2.5 rounded-full', dot)} aria-hidden="true" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-muted-foreground tracking-wide">{label}</span>
          {isUnread && <span className="text-xs font-medium text-primary">New</span>}
        </div>
        <p className={cn('text-sm', isUnread ? 'font-medium' : 'text-muted-foreground')}>{notification.title}</p>
        {notification.body && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{notification.body}</p>}
      </div>

      <div className="flex-shrink-0 text-right">
        <p className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
        </p>
        <p className="text-xs text-muted-foreground/60 mt-0.5">{format(new Date(notification.created_at), 'MMM d, h:mm a')}</p>
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
    refresh,
  } = useNotifications({ eventSlug: event.slug, limit: 30 })

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Notifications"
          subtitle={unreadCount > 0 ? `${plural(unreadCount, 'unread notification')}` : 'All caught up.'}
          actions={
            <>
              {unreadCount > 0 && (
                <Button variant="outline" size="sm" onClick={() => markAllAsRead()}>
                  <CheckCheck className="h-4 w-4 mr-2" aria-hidden="true" />
                  Mark all as read
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link href={`/e/${event.slug}/settings/notifications`}>
                  <Settings className="h-4 w-4 mr-2" aria-hidden="true" />
                  Preferences
                </Link>
              </Button>
            </>
          }
        />

        <Card>
          <CardContent className="p-0">
            {error && notifications.length === 0 && !isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-center" role="alert">
                <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => refresh()}>
                  Try again
                </Button>
              </div>
            ) : isLoading ? (
              <div className="flex items-center justify-center py-12" role="status" aria-label="Loading notifications">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Bell className="h-12 w-12 text-muted-foreground/30 mb-4" aria-hidden="true" />
                <h2 className="font-medium text-lg mb-1">No notifications</h2>
                <p className="text-sm text-muted-foreground max-w-sm">
                  When something happens with your sessions or the gathering, you’ll see it here.
                </p>
              </div>
            ) : (
              <div>
                {notifications.map((notification) => (
                  <NotificationRow key={notification.id} notification={notification} onMarkAsRead={markAsRead} />
                ))}
                {hasMore && (
                  <div className="p-3 text-center">
                    <Button variant="ghost" size="sm" onClick={() => loadMore()} loading={isLoadingMore}>
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
