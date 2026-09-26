'use client'

import { PushNotifications } from '@/components/PushNotifications'
import * as React from 'react'
import Link from 'next/link'
import { Mail, Bell, Smartphone, Loader2, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import {
  NOTIFICATION_CATEGORIES,
  categoryInfo,
  useNotificationPreferences,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreference,
} from '@/hooks/useNotificationPreferences'

/** One responsive grid for the header and every row: stacked on phones, four columns from `sm`. */
const ROW_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_5rem_5rem_6rem] sm:items-center'

const CHANNELS: { key: NotificationChannel; label: string; icon: React.ComponentType<{ className?: string }>; comingSoon?: boolean }[] = [
  { key: 'email_enabled', label: 'Email', icon: Mail },
  { key: 'in_app_enabled', label: 'In-app', icon: Bell },
  { key: 'push_enabled', label: 'Push', icon: Smartphone },
]

function PreferenceRow({ category, pref, saving, onToggle }: {
  category: NotificationCategory
  pref: NotificationPreference
  saving: boolean
  onToggle: (category: NotificationCategory, channel: NotificationChannel) => void
}) {
  const info = categoryInfo[category]
  return <div className={`${ROW_GRID} border-b border-border py-4 last:border-b-0`}>
    <div className="min-w-0">
      <h3 className="text-sm font-medium">{info.label}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{info.description}</p>
    </div>
    {CHANNELS.map(channel => {
      const id = `${category}-${channel.key}`
      return <div key={channel.key} className="flex items-center gap-2 sm:justify-center">
        <Switch id={id} checked={pref[channel.key]} onCheckedChange={() => onToggle(category, channel.key)} disabled={saving || channel.comingSoon} aria-labelledby={`${id}-label`} />
        <label id={`${id}-label`} htmlFor={id} className="text-xs text-muted-foreground sm:sr-only">
          {channel.label}{channel.comingSoon ? ' (coming soon)' : ''}
        </label>
      </div>
    })}
  </div>
}

export default function NotificationSettingsPage() {
  const event = useEvent()
  const { isAdmin, can } = useEventRole()
  const { toast } = useToast()
  // One hook instance for the whole page, so every row sees the same state.
  const { isLoading, error, getPreference, toggleChannel, savingCategory } = useNotificationPreferences({ eventSlug: event.slug })

  // The hook swallows the outcome of a save; a save has finished when `savingCategory`
  // returns to null, and `error` is set in the same render when it failed.
  const previousSaving = React.useRef<NotificationCategory | null>(null)
  React.useEffect(() => {
    if (previousSaving.current && !savingCategory) {
      if (error) toast({ title: 'Could not save that preference', description: 'Your previous choice is still in place. Try again.', variant: 'destructive' })
      else toast({ title: 'Preferences saved', variant: 'success' })
    }
    previousSaving.current = savingCategory
  }, [savingCategory, error, toast])

  const showAdminAlerts = isAdmin || can('approveProposals')
  const categories = NOTIFICATION_CATEGORIES.filter(c => c !== 'admin_alerts' || showAdminAlerts)

  return <DashboardLayout>
    <div className="max-w-2xl">
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-sm text-muted-foreground">
        <Link href={`/e/${event.slug}/settings`} className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Settings</Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        <span aria-current="page" className="text-foreground">Notification preferences</span>
      </nav>
      <PageHeader title="Notification preferences" subtitle={`How you hear about ${event.name}. Each switch saves on its own.`} />
      <PushNotifications />
      <Card>
        <CardContent className="p-4 sm:p-6">
          {isLoading ? <div className="flex items-center justify-center py-8" role="status" aria-label="Loading preferences">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div> : <>
            {error && !savingCategory ? <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
            <div className={`${ROW_GRID} hidden border-b border-border pb-3 sm:grid`} aria-hidden="true">
              <div />
              {CHANNELS.map(channel => <div key={channel.key} className="flex flex-col items-center text-center">
                <channel.icon className="mb-1 h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{channel.label}</span>
                {channel.comingSoon ? <span className="text-[11px] leading-tight text-muted-foreground">Coming soon</span> : null}
              </div>)}
            </div>
            {categories.map(category => <PreferenceRow key={category} category={category} pref={getPreference(category)} saving={savingCategory === category} onToggle={toggleChannel} />)}
            <p className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">
              Ticket confirmations are always emailed, since they are your receipt. Push updates are delivered to devices you have enabled, usually within five minutes.
            </p>
          </>}
        </CardContent>
      </Card>
    </div>
  </DashboardLayout>
}
