'use client'

import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Calendar, CheckCircle, Loader2, Users, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'

interface InvitationInfo {
  event: { name: string; slug: string; description: string | null; start_date: string; end_date: string }
  role: string
  expires_at: string
  email_bound: boolean
  is_expired: boolean
  is_used: boolean
  is_revoked: boolean
  max_uses: number | null
  use_count: number
  exhausted: boolean
}

const formatDay = (date: string) =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export default function AcceptEventInvitationPage() {
  const router = useRouter()
  const params = useParams()
  const token = params.token as string
  const { user, isLoading: authLoading } = useAuth()

  const [invitation, setInvitation] = React.useState<InvitationInfo | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [accepting, setAccepting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<{ message: string; slug: string } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    apiFetch<InvitationInfo>(`/api/v1/invitations/${encodeURIComponent(token)}`)
      .then((data) => { if (!cancelled) setInvitation(data) })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'This invitation could not be loaded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  React.useEffect(() => {
    if (!success) return
    const timer = window.setTimeout(() => router.push(`/e/${success.slug}`), 2000)
    return () => window.clearTimeout(timer)
  }, [success, router])

  const returnTo = `/invite/e/${token}`

  const handleAccept = async () => {
    setAccepting(true)
    setError(null)
    try {
      const data = await apiFetch<{ message: string; eventSlug: string }>(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' })
      setSuccess({ message: data.message, slug: data.eventSlug })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`)
        return
      }
      setError(e instanceof ApiError ? e.message : 'The invitation could not be accepted.')
    } finally {
      setAccepting(false)
    }
  }

  if (loading || authLoading) {
    return <div className="min-h-screen flex items-center justify-center" role="status" aria-label="Loading invitation"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  if (error && !invitation) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center">
            <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" aria-hidden />
            <h1 className="text-xl font-semibold mb-2">Invitation not available</h1>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button asChild variant="outline"><Link href="/">Go home</Link></Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (success) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center" role="status">
            <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" aria-hidden />
            <h1 className="text-xl font-semibold mb-2">You&apos;re in!</h1>
            <p className="text-muted-foreground mb-4">{success.message}</p>
            <Button asChild><Link href={`/e/${success.slug}`}>Go to the gathering</Link></Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (!invitation) return null
  const invalid = invitation.is_expired || invitation.is_used || invitation.is_revoked || invitation.exhausted

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{invitation.event.name}</CardTitle>
          <CardDescription>You&apos;ve been invited to join this gathering</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {invitation.event.description && <p className="text-sm text-muted-foreground">{invitation.event.description}</p>}
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1"><Calendar className="h-4 w-4" aria-hidden />{formatDay(invitation.event.start_date)} – {formatDay(invitation.event.end_date)}</span>
            <span className="flex items-center gap-1 capitalize"><Users className="h-4 w-4" aria-hidden />{invitation.role.replace('_', ' ')}</span>
          </div>
          {invitation.email_bound && !invalid && (
            <p className="text-xs text-muted-foreground">This invitation was sent to a specific email address. Sign in with that address to accept it.</p>
          )}
          {error && <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">{error}</div>}
          {invalid ? (
            <div className="rounded-lg bg-muted p-4 text-center" role="status">
              <XCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" aria-hidden />
              <p className="font-medium">
                {invitation.is_revoked ? 'This invitation has been revoked'
                  : invitation.is_expired ? 'This invitation has expired'
                    : invitation.is_used ? 'This invitation has already been used'
                      : 'This invitation has reached its use limit'}
              </p>
              {invitation.exhausted && !invitation.is_revoked && !invitation.is_expired && (
                <p className="text-sm text-muted-foreground mt-1">All {invitation.max_uses} {invitation.max_uses === 1 ? 'place' : 'places'} on this link have been claimed. Ask the organizer for a new one.</p>
              )}
            </div>
          ) : user ? (
            <Button onClick={() => void handleAccept()} className="w-full" size="lg" disabled={accepting}>
              {accepting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Joining…</> : 'Accept invitation'}
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-center text-muted-foreground">Sign in or create an account to accept this invitation</p>
              <Button asChild className="w-full" size="lg"><Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in to accept</Link></Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
