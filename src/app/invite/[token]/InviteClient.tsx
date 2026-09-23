'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Mic, Wrench, MessageSquare, Users, Monitor, User, Loader2, CheckCircle, XCircle, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { SuccessPanel } from '@/components/SuccessPanel'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'
import type { InvitePreview } from '@/app/api/v1/sessions/_lib/invite'

const formatIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  talk: Mic,
  workshop: Wrench,
  discussion: MessageSquare,
  panel: Users,
  demo: Monitor,
}

type InviteData = InvitePreview

// Sessions live under /e/[slug]/sessions; without a slug fall back to the home page.
function sessionHref(eventSlug: string | null | undefined, sessionId: string): string {
  return eventSlug ? `/e/${eventSlug}/sessions/${sessionId}` : '/'
}

interface InviteClientProps {
  token: string
  invite: InviteData | null
}

/** The public shell every invite state shares: header, centred card, footer, "what is this?". */
function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">{children}</Card>
        <p className="mt-4 max-w-md text-center text-xs text-muted-foreground">
          What is this? unconference is where communities propose, choose and schedule the sessions of a gathering
          together. Co-hosts share the running of one session.
        </p>
      </main>
      <Footer variant="minimal" />
    </div>
  )
}

export function InviteClient({ token, invite }: InviteClientProps) {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [isDeclining, setIsDeclining] = React.useState(false)
  const [accepted, setAccepted] = React.useState(false)
  const [declined, setDeclined] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [publishNote, setPublishNote] = React.useState<string | null>(null)

  if (!invite || !invite.session) {
    return (
      <InviteShell>
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="rounded-full bg-destructive/10 p-4">
              <XCircle className="h-12 w-12 text-destructive" aria-hidden="true" />
            </div>
          </div>
          <CardTitle className="text-2xl">Invitation not available</CardTitle>
          <CardDescription>
            This invite link is invalid or has been removed. Ask the person who invited you for a new one.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button asChild variant="outline">
            <Link href="/">Go home</Link>
          </Button>
        </CardContent>
      </InviteShell>
    )
  }

  const session = invite.session
  const eventSlug: string | null = invite.event_slug
  const sessionUrl = sessionHref(eventSlug, session.id)
  const FormatIcon = formatIcons[session.format ?? ''] || Mic

  // Invite is not pending
  if (invite.status !== 'pending') {
    const statusConfig = {
      accepted: { icon: CheckCircle, color: 'text-success', bg: 'bg-success/10', message: 'This invitation has already been accepted.' },
      declined: { icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted', message: 'This invitation was declined. Ask the proposer for a new one if you changed your mind.' },
      expired: { icon: Clock, color: 'text-signal-amber', bg: 'bg-signal-amber/10', message: 'This invitation has expired. Ask the host for a new one.' },
      revoked: { icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/10', message: 'This invitation has been revoked.' },
    }
    const config = statusConfig[invite.status as keyof typeof statusConfig] || statusConfig.expired
    const StatusIcon = config.icon

    return (
      <InviteShell>
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className={`rounded-full ${config.bg} p-4`}>
              <StatusIcon className={`h-12 w-12 ${config.color}`} aria-hidden="true" />
            </div>
          </div>
          <CardTitle className="text-2xl">{session.title}</CardTitle>
          <CardDescription>{config.message}</CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button asChild>
            <Link href={sessionUrl}>View session</Link>
          </Button>
        </CardContent>
      </InviteShell>
    )
  }

  // Declined state — the proposer is told, so they can ask someone else.
  if (declined) {
    return (
      <InviteShell>
        <CardHeader className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-muted p-4">
              <XCircle className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
            </div>
          </div>
          <CardTitle className="text-2xl">Invitation declined</CardTitle>
          <CardDescription>
            Thanks for answering — the proposer has been told, so they can ask someone else.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button asChild variant="outline">
            <Link href="/">Go home</Link>
          </Button>
        </CardContent>
      </InviteShell>
    )
  }

  // Accepted state
  if (accepted) {
    return (
      <InviteShell>
        <CardContent className="pt-6">
          <SuccessPanel
            title="You’re a co-host"
            body={
              <>
                You co-host “{session.title}” and can now edit it with the proposer.
                {publishNote && <span className="block mt-2">{publishNote}</span>}
              </>
            }
            primary={
              <Button asChild>
                <Link href={sessionUrl}>View session</Link>
              </Button>
            }
          />
        </CardContent>
      </InviteShell>
    )
  }

  const handleAccept = async () => {
    setIsAccepting(true)
    setError(null)

    try {
      const result = await apiFetch<{ session_id: string; event_slug: string; atproto?: { error?: string } }>(
        `/api/invite/${token}/accept`,
        { method: 'POST' },
      )
      if (result.atproto?.error) setPublishNote('Your public co-host record could not be written yet; you can retry from the session page.')
      setAccepted(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && /already a co-host/i.test(err.message)) {
        router.push(sessionHref(eventSlug, session.id))
        return
      }
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setIsAccepting(false)
    }
  }

  const handleDecline = async () => {
    setIsDeclining(true)
    setError(null)
    try {
      await apiFetch(`/api/invite/${token}/decline`, { method: 'POST' })
      setDeclined(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setIsDeclining(false)
    }
  }

  return (
    <InviteShell>
      <CardHeader className="text-center">
        <CardDescription className="mb-2">You’ve been invited to co-host</CardDescription>
        <CardTitle className="text-2xl">{session.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Session preview */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FormatIcon className="h-4 w-4" aria-hidden="true" />
            <span className="capitalize">{session.format}</span>
            <span className="text-muted-foreground/50" aria-hidden="true">·</span>
            <span>{session.duration} min</span>
          </div>

          {session.description && (
            <p className="text-sm text-muted-foreground line-clamp-3">{session.description}</p>
          )}

          {/* Primary host */}
          <div className="flex items-center gap-2 pt-2 border-t">
            <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center overflow-hidden">
              {session.host?.avatar_url ? (
                <img src={session.host.avatar_url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <User className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              )}
            </div>
            <span className="text-sm text-muted-foreground">
              {session.host ? `Proposed by ${session.host.display_name || (session.host.handle ? `@${session.host.handle}` : 'a member')}` : `Unclaimed proposal at ${invite.event_name}`}
            </span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Accepting adds you as a co-host and writes a co-host record into your own repository, naming
          this proposal. It is public; you can step down later, which deletes it, but copies may persist on the network.
        </p>

        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {authLoading ? (
          <div className="flex justify-center py-4" role="status" aria-label="Checking your sign-in">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : user ? (
          <div className="space-y-2">
            <Button className="w-full" size="lg" onClick={handleAccept} loading={isAccepting} disabled={isDeclining}>
              Accept invitation
            </Button>
            <Button variant="ghost" className="w-full text-muted-foreground" onClick={handleDecline} loading={isDeclining} disabled={isAccepting}>
              No thanks, decline
            </Button>
          </div>
        ) : (
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted-foreground">Sign in or create an account to accept this invitation</p>
            <Button asChild className="w-full" size="lg">
              <Link href={`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
            </Button>
            <Button variant="ghost" className="w-full text-muted-foreground" onClick={handleDecline} loading={isDeclining}>
              No thanks, decline
            </Button>
          </div>
        )}
      </CardContent>
    </InviteShell>
  )
}
