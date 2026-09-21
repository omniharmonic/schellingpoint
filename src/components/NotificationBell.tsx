'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bell, CheckCheck, ArrowRight, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { notificationType } from '@/lib/labels'
import { safeActionPath, useNotifications, type Notification } from '@/hooks/useNotifications'
import { useEvent } from '@/contexts/EventContext'
import { formatDistanceToNow } from 'date-fns'

function NotificationItem({
  notification,
  onMarkAsRead,
  onClick,
}: {
  notification: Notification
  onMarkAsRead: (id: string) => void
  onClick?: () => void
}) {
  const router = useRouter()
  const isUnread = !notification.read_at
  const { dot } = notificationType(notification.type)

  const handleClick = () => {
    if (isUnread) onMarkAsRead(notification.id)
    const target = safeActionPath(notification.action_url)
    if (target) router.push(target)
    onClick?.()
  }

  const timeAgo = formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'w-full text-left p-3 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0',
        isUnread && 'bg-muted/30'
      )}
    >
      <div className="flex gap-3">
        <div className="flex-shrink-0 mt-1.5">
          <div className={cn('w-2 h-2 rounded-full', dot)} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={cn('text-sm', isUnread ? 'font-medium' : 'text-muted-foreground')}>{notification.title}</p>
          {notification.body && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{notification.body}</p>}
          <p className="text-xs text-muted-foreground/60 mt-1">{timeAgo}</p>
        </div>
        {isUnread && (
          <div className="flex-shrink-0">
            <div className="w-2 h-2 rounded-full bg-primary" aria-hidden="true" />
            <span className="sr-only">Unread</span>
          </div>
        )}
      </div>
    </button>
  )
}

function NotificationSkeleton() {
  return (
    <div className="p-3 border-b border-border">
      <div className="flex gap-3">
        <Skeleton className="w-2 h-2 rounded-full mt-1.5" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
    </div>
  )
}

export function NotificationBell() {
  const event = useEvent()
  const [isOpen, setIsOpen] = React.useState(false)

  const { notifications, unreadCount, isLoading, markAsRead, markAllAsRead, refresh } = useNotifications({
    eventSlug: event.slug,
    limit: 10,
  })

  // Refresh when popover opens
  React.useEffect(() => {
    if (isOpen) refresh()
  }, [isOpen, refresh])

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}>
          <Bell className="h-4 w-4" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-0 bg-background border shadow-lg" align="end">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <h3 className="font-semibold text-sm">Notifications</h3>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => markAllAsRead()}>
              <CheckCheck className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              Mark all as read
            </Button>
          )}
        </div>

        <ScrollArea className="max-h-[400px]">
          {isLoading ? (
            <>
              <NotificationSkeleton />
              <NotificationSkeleton />
              <NotificationSkeleton />
            </>
          ) : notifications.length === 0 ? (
            <div className="p-6 text-center">
              <Bell className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">No notifications yet</p>
            </div>
          ) : (
            notifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onMarkAsRead={markAsRead}
                onClick={() => setIsOpen(false)}
              />
            ))
          )}
        </ScrollArea>

        <div className="p-2 border-t border-border flex gap-2">
          <Button variant="ghost" size="sm" className="flex-1 text-xs" asChild onClick={() => setIsOpen(false)}>
            <Link href={`/e/${event.slug}/notifications`}>
              View all
              <ArrowRight className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
            </Link>
          </Button>
          <Button variant="ghost" size="sm" className="text-xs" asChild onClick={() => setIsOpen(false)}>
            <Link href={`/e/${event.slug}/settings/notifications`}>
              <Settings className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              Preferences
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
