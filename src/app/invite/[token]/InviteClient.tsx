'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Mic, Wrench, MessageSquare, Users, Monitor, User, Loader2, CheckCircle, XCircle, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export function InviteClient({ token, invite }: InviteClientProps) {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const [isAccepting, setIsAccepting] = React.useState(false)
  const [accepted, setAccepted] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [publishNote, setPublishNote] = React.useState<string | null>(null)

  if (!invite || !invite.session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-destructive/10 p-4">
                <XCircle className="h-12 w-12 text-destructive" />
              </div>
            </div>
            <CardTitle className="text-2xl">Invite Not Found</CardTitle>
            <CardDescription>
              This invite link is invalid or has been removed.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild>
              <Link href="/">Go Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const session = invite.session
  const eventSlug: string | null = invite.event_slug
  const sessionUrl = sessionHref(eventSlug, session.id)
  const FormatIcon = formatIcons[session.format ?? ''] || Mic

  // Invite is not pending
  if (invite.status !== 'pending') {
    const statusConfig = {
      accepted: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-500/10', message: 'This invite has already been accepted.' },
      expired: { icon: Clock, color: 'text-yellow-500', bg: 'bg-yellow-500/10', message: 'This invite has expired.' },
      revoked: { icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/10', message: 'This invite has been revoked.' },
    }
    const config = statusConfig[invite.status as keyof typeof statusConfig] || statusConfig.expired
    const StatusIcon = config.icon

    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className={`rounded-full ${config.bg} p-4`}>
                <StatusIcon className={`h-12 w-12 ${config.color}`} />
              </div>
            </div>
            <CardTitle className="text-2xl">{session.title}</CardTitle>
            <CardDescription>{config.message}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild>
              <Link href={sessionUrl}>View Session</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Accepted state
  if (accepted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-green-500/10 p-4">
                <CheckCircle className="h-12 w-12 text-green-500" />
              </div>
            </div>
            <CardTitle className="text-2xl">You're a Co-Host!</CardTitle>
            <CardDescription>
              You co-host &ldquo;{session.title}&rdquo; and can now edit it with the proposer.
            </CardDescription>
            {publishNote && <p className="text-sm text-muted-foreground mt-2">{publishNote}</p>}
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild>
              <Link href={sessionUrl}>View Session</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
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
      if (result.atproto?.error) setPublishNote('You are a co-host. Your public co-host record could not be written yet; you can retry from the session page.')
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardDescription className="mb-2">You've been invited to co-host</CardDescription>
          <CardTitle className="text-2xl">{session.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Session preview */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FormatIcon className="h-4 w-4" />
              <span className="capitalize">{session.format}</span>
              <span className="text-muted-foreground/50">•</span>
              <span>{session.duration} min</span>
            </div>

            {session.description && (
              <p className="text-sm text-muted-foreground line-clamp-3">
                {session.description}
              </p>
            )}

            {/* Primary host */}
            <div className="flex items-center gap-2 pt-2 border-t">
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                {session.host?.avatar_url ? (
                  <img
                    src={session.host.avatar_url}
                    alt={session.host.display_name || ''}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <User className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
              <span className="text-sm text-muted-foreground">
                {session.host ? `Proposed by ${session.host.display_name || (session.host.handle ? `@${session.host.handle}` : 'a participant')}` : `Unclaimed proposal at ${invite.event_name}`}
              </span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Accepting adds you as a co-host and writes a co-host record into your own repository, naming
            this proposal. It is public; you can step down later, which deletes it, but copies may persist on the network.
          </p>

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {authLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : user ? (
            <Button className="w-full" onClick={handleAccept} disabled={isAccepting}>
              {isAccepting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Accepting...
                </>
              ) : (
                'Accept Co-Host Invitation'
              )}
            </Button>
          ) : (
            <div className="space-y-3 text-center">
              <p className="text-sm text-muted-foreground">
                Sign in to accept this invitation
              </p>
              <Button asChild className="w-full">
                <Link href={`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`}>
                  Sign In to Accept
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
