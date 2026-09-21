'use client'

import * as React from 'react'
import Link from 'next/link'
import { AtSign, Bell, ChevronRight, UserRound } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useEvent } from '@/contexts/EventContext'

/**
 * `/e/[slug]/settings`: the participant's settings for this gathering (spec §3 "Account").
 * Lists what exists today and is honest about what does not.
 */
export default function ParticipantSettingsPage() {
  const event = useEvent()
  const base = `/e/${event.slug}`

  return <DashboardLayout>
    <div className="max-w-2xl">
      <PageHeader title="Settings" subtitle={`Your choices for ${event.name}. Your profile and identity live under Account.`} />
      <div className="space-y-4">
        <Card interactive className="group">
          <Link href={`${base}/settings/notifications`} className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CardContent className="flex items-center gap-4 p-4 sm:p-6">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bell className="h-5 w-5" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Notification preferences</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">Which updates reach you by email and in the app.</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
            </CardContent>
          </Link>
        </Card>
        <Card interactive className="group">
          <Link href={`${base}/settings?settings=1`} className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CardContent className="flex items-center gap-4 p-4 sm:p-6">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><UserRound className="h-5 w-5" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Account</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">Your profile, network identity and messaging handle.</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
            </CardContent>
          </Link>
        </Card>
        <Card className="border-dashed">
          <CardContent className="flex items-center gap-4 p-4 sm:p-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><AtSign className="h-5 w-5" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 font-medium">Feed mentions<Badge variant="muted">Not yet available</Badge></span>
              <span className="mt-0.5 block text-sm text-muted-foreground">Arrives with the gathering feed in the next release. You will choose here whether posts can mention you.</span>
            </span>
          </CardContent>
        </Card>
      </div>
    </div>
  </DashboardLayout>
}
