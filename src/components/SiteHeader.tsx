'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { LogOut, Plus } from 'lucide-react'
import { NetworkMark } from '@/components/GatheringArtwork'

export function SiteHeader() {
  const { user, profile, isLoading, signOut } = useAuth()
  const pathname = usePathname()
  const loginHref = `/login?redirect=${encodeURIComponent(pathname || '/')}`
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-md">
      <div className="container mx-auto px-5 flex h-[76px] items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 font-display font-semibold text-lg tracking-tight">
          <NetworkMark className="h-8 w-8 text-primary shrink-0" />
          <span className="leading-tight">Schelling Point</span>
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-2 sm:gap-4">
          <Link href="/#upcoming" className="hidden md:block text-sm text-muted-foreground hover:text-foreground">Explore events</Link>
          {isLoading ? <div className="h-10 w-20 rounded-lg bg-muted animate-pulse" /> : user ? <>
            <Button asChild size="sm"><Link href="/create" aria-label="Create an event"><Plus className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">Create event</span></Link></Button>
            <span className="hidden lg:block text-sm max-w-[140px] truncate">{profile?.display_name || user.email?.split('@')[0]}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => signOut()} aria-label="Sign out"><LogOut className="h-4 w-4" /></Button>
          </> : <>
            <Button asChild variant="ghost" size="sm"><Link href={loginHref}>Sign in</Link></Button>
            <Button asChild size="sm" className="hidden sm:inline-flex"><Link href="/create">Create event</Link></Button>
          </>}
        </nav>
      </div>
    </header>
  )
}
