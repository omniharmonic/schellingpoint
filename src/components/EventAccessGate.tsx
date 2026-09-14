'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { SiteHeader } from '@/components/SiteHeader'
import { Button } from '@/components/ui/button'

export function EventAccessGate() {
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
  return <><SiteHeader /><main className="mx-auto max-w-xl px-6 py-24 text-center">
    <p className="eyebrow mb-4">Schelling Point</p>
    <h1 className="text-4xl font-semibold tracking-tight">{isLoading ? 'Finding your gathering…' : 'This gathering isn’t available'}</h1>
    <p className="mt-5 text-muted-foreground">{isLoading ? 'Checking your access.' : user ? 'The link may have changed, or this gathering may need an invitation. Drafts are available to their organizers.' : 'Sign in to access a private gathering or an event you’re organizing.'}</p>
    {!isLoading && <div className="mt-8 flex justify-center gap-3">
      {!user && <Button asChild><Link href={`/login?redirect=${encodeURIComponent(pathname)}`}>Sign in</Link></Button>}
      <Button variant="outline" asChild><Link href="/#upcoming">Explore gatherings</Link></Button>
    </div>}
  </main></>
}
