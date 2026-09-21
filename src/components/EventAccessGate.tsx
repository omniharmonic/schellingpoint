'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { SiteHeader } from '@/components/SiteHeader'
import { Button } from '@/components/ui/button'
import { safeReturnPath } from '@/lib/auth-redirect'

/**
 * Why the event page could not be shown. Callers that know the event exists
 * pass `draft` or `private` so the viewer gets a specific message; with no
 * reason the gate falls back to the generic "not available" copy, which never
 * reveals whether a slug exists.
 */
export type EventAccessReason = 'draft' | 'private' | 'unknown'

interface EventAccessGateProps {
  reason?: EventAccessReason
}

export function EventAccessGate({ reason = 'unknown' }: EventAccessGateProps) {
  const { user, isLoading } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const refreshed = useRef(false)
  useEffect(() => {
    if (!isLoading && user && !refreshed.current) {
      refreshed.current = true
      router.refresh()
    }
  }, [isLoading, user, router])

  const returnTo = safeReturnPath(pathname)
  const signInHref = `/login?returnTo=${encodeURIComponent(returnTo)}`

  let title = 'This gathering isn’t available'
  let body = user
    ? 'The link may have changed, or this gathering may need an invitation. Drafts are available to their organizers.'
    : 'Sign in to open a private gathering or one you’re organizing.'
  if (reason === 'draft') {
    title = 'This gathering hasn’t been published yet'
    body = user
      ? 'Its organizers are still setting things up. If you are an organizer, ask the owner to add you as an admin.'
      : 'Its organizers are still setting things up. If you are an organizer, sign in to open it.'
  } else if (reason === 'private') {
    title = 'This gathering is invite-only'
    body = user
      ? 'If you received an invitation link, open it to join.'
      : 'If you received an invitation link, open it to join. Already a member? Sign in to continue.'
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-xl px-6 py-24 text-center">
        <p className="eyebrow mb-4">unconference</p>
        <h1 className="page-title">{isLoading ? 'Finding your gathering…' : title}</h1>
        <p className="mt-5 text-muted-foreground">{isLoading ? 'Checking your access.' : body}</p>
        {!isLoading && reason === 'private' && (
          <p className="mt-3 text-sm text-muted-foreground">
            Invitation links look like <span className="font-mono text-xs">unconference.events/invite/e/…</span> — open
            the one you were sent in this browser, or ask the organizer for a new one.
          </p>
        )}
        {!isLoading && (
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {!user && (
              <Button asChild>
                <Link href={signInHref}>Sign in</Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link href="/events">Explore gatherings</Link>
            </Button>
          </div>
        )}
      </main>
    </>
  )
}
