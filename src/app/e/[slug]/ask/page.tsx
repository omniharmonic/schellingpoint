'use client'

/**
 * Members → Ask the gathering (design 2026-09-25 §2.2): the integrated chat, the organizers'
 * themes as starting points, and — because nobody could find it — the "Your AI assistant" card
 * for members who would rather ask from their own assistant.
 *
 * The nav item appears whenever the gathering has transcripts turned on; this page explains what
 * is still missing (no transcripts, no key) instead of the item disappearing.
 */

import * as React from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { AskPanel, type AskTheme } from '@/components/knowledge/AskPanel'
import { AssistantCard } from '@/components/knowledge/AssistantCard'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'

export default function AskPage() {
  const event = useEvent()
  const { user, isLoading } = useAuth()
  const { role, isAdmin } = useEventRole()
  const returnTo = encodeURIComponent(`/e/${event.slug}/ask`)
  const organizer = isAdmin || role === 'moderator'
  // The organizers' themes, members-only like everything else on this page.
  const [themes, setThemes] = React.useState<AskTheme[]>([])

  return (
    <DashboardLayout>
      <PageHeader
        title="Ask the gathering"
        subtitle="Questions answered from the session transcripts members have shared, with the session and moment each answer draws on."
      />
      {isLoading ? (
        // Nothing is mounted until the viewer is known: the member branch would otherwise fire its
        // own requests as an anonymous visitor and flash a 401 before the sign-in card appears.
        <p className="text-sm text-muted-foreground" role="status">Loading…</p>
      ) : !user ? (
        <div className="rounded-2xl border bg-card p-8 text-center">
          <p className="mb-4 text-sm text-muted-foreground">Sign in to ask questions about this gathering.</p>
          <Button asChild>
            <Link href={`/login?returnTo=${returnTo}`}>Sign in</Link>
          </Button>
        </div>
      ) : !role ? (
        <div className="rounded-2xl border bg-card p-8 text-center">
          <p className="mb-4 text-sm text-muted-foreground">Ask the gathering is for members. Join to read transcripts and ask questions.</p>
          <JoinGatheringButton />
        </div>
      ) : (
        <div className="space-y-8">
          <AskPanel
            eventSlug={event.slug}
            variant={organizer ? 'organizer' : 'member'}
            showThemes
            onAvailability={(info) => setThemes(info.themes)}
          />

          {themes.length > 0 && (
            <Card data-testid="ask-themes">
              <CardHeader>
                <CardTitle className="text-lg">What this gathering has been talking about</CardTitle>
                <CardDescription>
                  Themes the organizers drew from the session transcripts and stand behind. Members only — never published.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {themes.map((t) => (
                  <div key={t.title} className="rounded-xl border p-4">
                    <p className="font-medium">{t.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{t.summary}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {organizer && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Organizer note</CardTitle>
                <CardDescription>
                  Members see the same page. The provider key, the themes members start from and transcript coverage all live on the{' '}
                  <Link href={`/e/${event.slug}/admin/knowledge`} className="underline">Knowledge page</Link>.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          <AssistantCard gatheringName={event.name} />
        </div>
      )}
    </DashboardLayout>
  )
}
