'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, Mail, Bell, Smartphone, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import {
  NOTIFICATION_CATEGORIES,
  categoryInfo,
  useNotificationPreferences,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreference,
} from '@/hooks/useNotificationPreferences'
import { cn } from '@/lib/utils'

function Toggle({
  enabled,
  onChange,
  disabled,
  saving,
  label,
}: {
  enabled: boolean
  onChange: () => void
  disabled?: boolean
  saving?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onChange}
      disabled={disabled || saving}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
        enabled ? 'bg-primary' : 'bg-muted',
        (disabled || saving) && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
          enabled ? 'translate-x-6' : 'translate-x-1',
        )}
      />
      {saving && <Loader2 className="absolute right-1 h-3 w-3 animate-spin text-white" />}
    </button>
  )
}

function PreferenceRow({
  category,
  pref,
  saving,
  onToggle,
}: {
  category: NotificationCategory
  pref: NotificationPreference
  saving: boolean
  onToggle: (category: NotificationCategory, channel: NotificationChannel) => void
}) {
  const info = categoryInfo[category]
  return (
    <div className="flex items-center justify-between py-4 border-b border-border last:border-b-0">
      <div className="flex-1 mr-4">
        <h4 className="font-medium text-sm">{info.label}</h4>
        <p className="text-xs text-muted-foreground mt-0.5">{info.description}</p>
      </div>
      <div className="flex items-center gap-6">
        <Toggle
          label={`${info.label}: email`}
          enabled={pref.email_enabled}
          onChange={() => onToggle(category, 'email_enabled')}
          saving={saving}
        />
        <Toggle
          label={`${info.label}: in-app`}
          enabled={pref.in_app_enabled}
          onChange={() => onToggle(category, 'in_app_enabled')}
          saving={saving}
        />
        <Toggle label={`${info.label}: push (coming soon)`} enabled={pref.push_enabled} onChange={() => {}} disabled />
      </div>
    </div>
  )
}

export default function NotificationSettingsPage() {
  const event = useEvent()
  const { isAdmin, can } = useEventRole()
  // One hook instance for the whole page, so every row sees the same state.
  const { isLoading, error, getPreference, toggleChannel, savingCategory } = useNotificationPreferences({
    eventSlug: event.slug,
  })

  const showAdminAlerts = isAdmin || can('approveProposals')
  const categories = NOTIFICATION_CATEGORIES.filter((c) => c !== 'admin_alerts' || showAdminAlerts)

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/e/${event.slug}/dashboard`}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Notification Settings</h1>
            <p className="text-sm text-muted-foreground">Control how you receive notifications for {event.name}</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Notification Preferences</CardTitle>
            <CardDescription>Choose which notifications you want to receive and how</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {error && <p className="text-sm text-destructive mb-4">{error}</p>}
                <div className="flex items-center justify-between pb-4 mb-2 border-b border-border">
                  <div className="flex-1" />
                  <div className="flex items-center gap-6">
                    <div className="flex flex-col items-center w-11">
                      <Mail className="h-4 w-4 text-muted-foreground mb-1" />
                      <span className="text-xs text-muted-foreground">Email</span>
                    </div>
                    <div className="flex flex-col items-center w-11">
                      <Bell className="h-4 w-4 text-muted-foreground mb-1" />
                      <span className="text-xs text-muted-foreground">In-app</span>
                    </div>
                    <div className="flex flex-col items-center w-11">
                      <Smartphone className="h-4 w-4 text-muted-foreground mb-1" />
                      <span className="text-xs text-muted-foreground">Push</span>
                    </div>
                  </div>
                </div>

                {categories.map((category) => (
                  <PreferenceRow
                    key={category}
                    category={category}
                    pref={getPreference(category)}
                    saving={savingCategory === category}
                    onToggle={toggleChannel}
                  />
                ))}

                <p className="text-xs text-muted-foreground mt-4 pt-4 border-t border-border">
                  Ticket confirmations are always emailed, since they are your receipt. Push notifications are not
                  available yet.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
