'use client'

/**
 * The signed-in user block shared by the attendee workspace and the organizer workspace:
 * avatar + name opening a menu (Account · Notification preferences · Gathering page · Sign out),
 * with the NotificationBell beside it. Signed out, it renders a "Sign in" link that returns to
 * the current page.
 *
 *   <div className="border-t p-3"><WorkspaceUserMenu /></div>
 *
 * `variant="avatar"` is the mobile header's one-tap version (design §2.1): just the avatar, and
 * it opens the Account modal directly on its Profile tab instead of a menu.
 *
 * The Account modal itself (`SettingsModal`) and the `?settings=1` deep link belong to
 * `AccountModalProvider`, so a shell that has more than one way in — a header avatar and a
 * "Account" row in the More sheet — opens one dialog, not two. Wrap the shell once:
 *
 *   <AccountModalProvider gathering={{ slug, name }}>…shell…</AccountModalProvider>
 *
 * and call `useAccountModal()?.open()` from anywhere inside. Without a provider the menu falls
 * back to owning a dialog of its own, so `<WorkspaceUserMenu />` still works on its own.
 */

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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

/* ─────────────────────────── the one Account modal ─────────────────────────── */

const AccountModalContext = React.createContext<{ open: () => void } | null>(null)

/** Whoever is inside an `AccountModalProvider` can open the shell's Account modal. */
export function useAccountModal(): { open: () => void } | null {
  return React.useContext(AccountModalContext)
}

/**
 * Owns the shell's Account modal and the `?settings=1` deep link (used by the ATProto
 * "Link a Bluesky account" hint), so every entry point opens the same dialog.
 */
export function AccountModalProvider({
  gathering,
  children,
}: {
  gathering?: { slug: string; name: string | null } | null
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  useSettingsDeepLink(true, setOpen)
  const value = React.useMemo(() => ({ open: () => setOpen(true) }), [])
  return (
    <AccountModalContext.Provider value={value}>
      {children}
      <SettingsModal isOpen={open} onClose={() => setOpen(false)} gathering={gathering} />
    </AccountModalContext.Provider>
  )
}

/**
 * `?settings=1` on any page inside a workspace opens the Account modal, then leaves the URL clean.
 * `enabled` is false for a menu that delegates to a provider, so the link is claimed exactly once.
 *
 * It watches `useSearchParams()`, not just the mount: a link that only adds `?settings=1` to the
 * page you are already on is a client-side navigation, and reading `window.location` once would
 * miss it (the Account card on `/e/[slug]/settings` did nothing at all).
 */
function useSettingsDeepLink(enabled: boolean, open: (value: boolean) => void) {
  const searchParams = useSearchParams()
  const wanted = searchParams?.get('settings') === '1'
  React.useEffect(() => {
    if (!enabled || !wanted || typeof window === 'undefined') return
    open(true)
    const url = new URL(window.location.href)
    url.searchParams.delete('settings')
    window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
  }, [enabled, open, wanted])
}

/* ──────────────────────────────── the menu ──────────────────────────────── */

export interface WorkspaceUserMenuProps {
  className?: string
  /** Called before the Account modal opens (close a sheet or a drawer, for example). */
  onOpenAccount?: () => void
  /** Where sign-out lands; defaults to the gathering page. */
  signOutTo?: string
  /** Render the NotificationBell beside the menu (off when the shell's top bar already has one). */
  withBell?: boolean
  /** `avatar` is the mobile header's single tap straight to Account; `menu` is the full block. */
  variant?: 'menu' | 'avatar'
}

export function WorkspaceUserMenu({
  className,
  onOpenAccount,
  signOutTo,
  withBell = true,
  variant = 'menu',
}: WorkspaceUserMenuProps) {
  const pathname = usePathname()
  const router = useRouter()
  const event = useEvent()
  const { user, profile, signOut } = useAuth()
  const shared = useAccountModal()
  // Only a menu outside a provider keeps a dialog (and the deep link) of its own.
  const [localAccount, setLocalAccount] = React.useState(false)
  useSettingsDeepLink(!shared, setLocalAccount)

  const handleSignOut = async () => {
    await signOut()
    router.push(signOutTo ?? `/e/${event.slug}?logged_out=true`)
  }

  if (!user) {
    if (variant === 'avatar') {
      return (
        <Button asChild variant="ghost" size="sm" className={className}>
          <Link href={`/login?returnTo=${encodeURIComponent(pathname || `/e/${event.slug}`)}`}>Sign in</Link>
        </Button>
      )
    }
    return (
      <Button asChild variant="secondary" size="sm" className={cn('w-full', className)}>
        <Link href={`/login?returnTo=${encodeURIComponent(pathname || `/e/${event.slug}`)}`}>Sign in</Link>
      </Button>
    )
  }

  const name = viewerDisplayName(profile, user)
  const openAccount = () => {
    onOpenAccount?.()
    if (shared) shared.open()
    else setLocalAccount(true)
  }
  const fallbackModal = shared ? null : (
    <SettingsModal
      isOpen={localAccount}
      onClose={() => setLocalAccount(false)}
      gathering={{ slug: event.slug, name: event.name }}
    />
  )
  const avatar = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-xs font-medium text-muted-foreground">
      {profile?.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        viewerInitial(profile, user)
      )}
    </span>
  )

  if (variant === 'avatar') {
    return (
      <>
        <button
          type="button"
          onClick={openAccount}
          aria-label={`Account, ${name}`}
          className={cn(
            'inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          {avatar}
        </button>
        {fallbackModal}
      </>
    )
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
              {avatar}
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
      {fallbackModal}
    </>
  )
}
