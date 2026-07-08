'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'

/**
 * Magic-link landing page.
 *
 * This app uses implicit-flow, localStorage-based auth: Supabase redirects here
 * with the session tokens in the URL *hash* (#access_token=...). The hash never
 * reaches the server, so this must be a client page — `AuthProvider` (mounted in
 * the root layout) reads the hash on mount and establishes the session. We just
 * wait for that to resolve, then route onward.
 */
function AuthCallback() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoading } = useAuth()

  React.useEffect(() => {
    if (isLoading) return
    if (user) {
      const next = searchParams.get('next') || searchParams.get('redirect') || '/'
      router.replace(next)
    } else {
      // Hash was missing/invalid or the link expired.
      router.replace('/login?error=auth')
    }
  }, [user, isLoading, router, searchParams])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-sm text-muted-foreground">Signing you in…</p>
    </div>
  )
}

export default function AuthCallbackPage() {
  // useSearchParams() requires a Suspense boundary in the App Router.
  return (
    <React.Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Signing you in…</p>
        </div>
      }
    >
      <AuthCallback />
    </React.Suspense>
  )
}
