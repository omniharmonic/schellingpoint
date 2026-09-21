'use client'

/**
 * The signed-in user block shared by the attendee workspace and the organizer workspace:
 * avatar + name opening a menu (Account · Notification preferences · Gathering page · Sign out),
 * with the NotificationBell beside it. Signed out, it renders a "Sign in" link that returns to
 * the current page.
 *
 * It owns the Account modal (`SettingsModal`) and the `?settings=1` deep link, so a shell only
 * needs to render `<WorkspaceUserMenu />` once — in the sidebar footer and again inside the
 * mobile drawer if it wants both (each instance manages its own modal state).
 *
 *   <div className="border-t p-3"><WorkspaceUserMenu /></div>
 */

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Bell, ChevronDown, ExternalLink, LogOut, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NotificationBell } from '@/components/NotificationBell'
import { SettingsModal } from '@/components/SettingsModal'
import { useAuth, viewerDisplayName, viewerInitial } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { cn } from '@/lib/utils'

export interface WorkspaceUserMenuProps {
  className?: string
  /** Called before the Account modal opens (close a mobile drawer, for example). */
  onOpenAccount?: () => void
  /** Where sign-out lands; defaults to the gathering page. */
  signOutTo?: string
  /** Render the NotificationBell beside the menu (off when the shell's top bar already has one). */
  withBell?: boolean
}

export function WorkspaceUserMenu({ className, onOpenAccount, signOutTo, withBell = true }: WorkspaceUserMenuProps) {
  const pathname = usePathname()
  const router = useRouter()
  const event = useEvent()
  const { user, profile, signOut } = useAuth()
  const [showAccount, setShowAccount] = React.useState(false)

  // Deep link: any page inside a workspace can open the Account modal with ?settings=1
  // (used by the ATProto "Link a Bluesky account" hint).
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (url.searchParams.get('settings') === '1') {
      setShowAccount(true)
      url.searchParams.delete('settings')
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
    }
  }, [])

  const handleSignOut = async () => {
    await signOut()
    router.push(signOutTo ?? `/e/${event.slug}?logged_out=true`)
  }

  if (!user) {
    return (
      <Button asChild variant="secondary" size="sm" className={cn('w-full', className)}>
        <Link href={`/login?returnTo=${encodeURIComponent(pathname || `/e/${event.slug}`)}`}>Sign in</Link>
      </Button>
    )
  }

  const name = viewerDisplayName(profile, user)
  const openAccount = () => {
    onOpenAccount?.()
    setShowAccount(true)
  }

  return (
    <>
      <div className={cn('flex items-center gap-1', className)}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Account menu for ${name}`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-xs font-medium text-muted-foreground">
                {profile?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  viewerInitial(profile, user)
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-tight">{name}</span>
                {user.handle && profile?.display_name && (
                  <span className="block truncate text-xs text-muted-foreground">@{user.handle}</span>
                )}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <span className="block truncate text-sm font-medium">{name}</span>
              {user.handle && <span className="block truncate text-xs text-muted-foreground">@{user.handle}</span>}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openAccount} className="gap-2">
              <UserRound className="h-4 w-4" aria-hidden="true" /> Account
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => router.push(`/e/${event.slug}/settings/notifications`)} className="gap-2">
              <Bell className="h-4 w-4" aria-hidden="true" /> Notification preferences
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => router.push(`/e/${event.slug}`)} className="gap-2">
              <ExternalLink className="h-4 w-4" aria-hidden="true" /> Gathering page
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleSignOut()} className="gap-2">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {withBell && <NotificationBell />}
      </div>
      <SettingsModal
        isOpen={showAccount}
        onClose={() => setShowAccount(false)}
        gathering={{ slug: event.slug, name: event.name }}
      />
    </>
  )
}
