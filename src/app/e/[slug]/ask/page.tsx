'use client'

/**
 * Members → Ask the gathering (design §10.3): streamed answers built only from this gathering's
 * transcripts, with sources that link to the session's transcript. The panel explains when it
 * becomes available (transcripts + a configured provider).
 */

import * as React from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { AskPanel } from '@/components/knowledge/AskPanel'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'

export default function AskPage() {
  const event = useEvent()
  const { user, isLoading } = useAuth()
  const { role } = useEventRole()
  const returnTo = encodeURIComponent(`/e/${event.slug}/ask`)

  return (
    <DashboardLayout>
      <PageHeader
        title="Ask the gathering"
        subtitle="Questions answered from the session transcripts members have shared, with the session and moment each answer draws on."
      />
      {!isLoading && !user ? (
        <div className="rounded-2xl border bg-card p-8 text-center">
          <p className="mb-4 text-sm text-muted-foreground">Sign in to ask questions about this gathering.</p>
          <Button asChild><Link href={`/login?returnTo=${returnTo}`}>Sign in</Link></Button>
        </div>
      ) : !isLoading && user && !role ? (
        <div className="rounded-2xl border bg-card p-8 text-center">
          <p className="mb-4 text-sm text-muted-foreground">Ask the gathering is for members. Join to read transcripts and ask questions.</p>
          <JoinGatheringButton />
        </div>
      ) : (
        <AskPanel eventSlug={event.slug} variant="member" />
      )}
    </DashboardLayout>
  )
}
