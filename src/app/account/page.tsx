'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
import { PageHeader } from '@/components/PageHeader'
import { AccountPanel } from '@/components/SettingsModal'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/hooks/useAuth'

/**
 * /account — the same Profile / Identity / Notifications tabs as the workspace "Account"
 * dialog, as a page reachable from the site header's profile menu (release design §3).
 * `?tab=identity` opens a tab directly (the ATProto hints link here).
 */
function AccountContent() {
  const { user, isLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get('tab')
  const initialTab = requested === 'identity' || requested === 'notifications' ? requested : 'profile'
  const [dirty, setDirty] = React.useState(false)

  // Warn before leaving the page with unsaved edits.
  React.useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  if (isLoading) {
    return (
      <main className="container mx-auto flex flex-1 items-center justify-center px-5 py-24" role="status" aria-label="Loading your account">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
      </main>
    )
  }

  if (!user) {
    return (
      <main className="container mx-auto max-w-xl px-5 py-24 text-center">
        <h1 className="page-title">Sign in to manage your account</h1>
        <p className="mt-4 text-muted-foreground">Your profile, identity and notification preferences live here once you are signed in.</p>
        <Button asChild className="mt-8">
          <Link href={`/login?returnTo=${encodeURIComponent('/account')}`}>Sign in</Link>
        </Button>
      </main>
    )
  }

  return (
    <main className="container mx-auto max-w-2xl px-5 py-10">
      <PageHeader title="Account" subtitle="Your profile, your identity on the network, and how you hear from gatherings." />
      <Card>
        <CardContent className="p-5 sm:p-6">
          <AccountPanel initialTab={initialTab} onDirtyChange={setDirty} onCancel={() => router.push('/')} cancelLabel="Cancel" />
        </CardContent>
      </Card>
    </main>
  )
}

export default function AccountPage() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <React.Suspense fallback={<div className="flex-1" />}>
        <AccountContent />
      </React.Suspense>
      <Footer variant="minimal" />
    </div>
  )
}
