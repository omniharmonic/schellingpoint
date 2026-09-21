'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, Plus, UserRound, CalendarRange, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/toast'
import { useAuth, viewerDisplayName, viewerInitial } from '@/hooks/useAuth'
import { NetworkMark } from '@/components/GatheringArtwork'
import { safeReturnPath } from '@/lib/auth-redirect'

/**
 * The public-site chrome (landing, directory, gathering front page, tickets, legal pages).
 * Signed-in people get a profile menu (Account · My gatherings · Sign out); everyone gets one
 * "Create a gathering" label. Mounts the toaster once for every page that uses this header.
 */
export function SiteHeader() {
  const { user, profile, isLoading, signOut } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const loginHref = `/login?returnTo=${encodeURIComponent(safeReturnPath(pathname))}`
  const name = viewerDisplayName(profile, user)

  return (
    <>
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-md">
      <div className="container mx-auto px-5 flex h-[76px] items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 font-display font-bold text-xl tracking-[-0.045em]">
          <NetworkMark className="h-8 w-8 text-primary shrink-0" />
          <span className="leading-tight">unconference</span>
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-2 sm:gap-3">
          <Link href="/events" className="hidden md:block text-sm text-muted-foreground hover:text-foreground">
            Explore gatherings
          </Link>
          {isLoading ? (
            // Same footprint as the signed-in cluster (button + menu) so nothing shifts on resolve.
            <div className="flex items-center gap-2" aria-hidden="true">
              <div className="h-10 w-10 sm:w-[172px] rounded-lg bg-muted animate-pulse" />
              <div className="h-10 w-10 lg:w-[150px] rounded-full bg-muted animate-pulse" />
            </div>
          ) : user ? (
            <>
              <Button asChild size="sm">
                <Link href="/create" aria-label="Create a gathering">
                  <Plus className="h-4 w-4 sm:mr-2" aria-hidden="true" />
                  <span className="hidden sm:inline">Create a gathering</span>
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-10 items-center gap-2 rounded-full border border-border pl-1 pr-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    aria-label={`Account menu for ${name}`}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground">
                      {profile?.avatar_url ? (
                        <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        viewerInitial(profile, user)
                      )}
                    </span>
                    <span className="hidden lg:block max-w-[110px] truncate text-sm">{name}</span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    {user.handle && <span className="block truncate text-xs text-muted-foreground">@{user.handle}</span>}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => router.push('/account')} className="gap-2">
                    <UserRound className="h-4 w-4" aria-hidden="true" /> Account
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => router.push('/#my-gatherings')} className="gap-2">
                    <CalendarRange className="h-4 w-4" aria-hidden="true" /> My gatherings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()} className="gap-2">
                    <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href={loginHref}>Sign in</Link>
              </Button>
              <Button asChild size="sm" className="hidden sm:inline-flex">
                <Link href="/create">Create a gathering</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
    <Toaster />
    </>
  )
}
