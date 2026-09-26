'use client'

/**
 * Everything the bottom bar's four tabs do not hold, one tap deeper (design §2.2).
 *
 * People, My votes, Ask, Propose a session, Organizer workspace, Notification preferences,
 * Account, Sign out — in that order, one action per row, each row a 44px target. The viewer's
 * credit gauge sits in the header, which is where it went when the nav drawer was removed (§2.5).
 *
 * It is a `ui/dialog` bottom sheet, so Radix owns the focus trap, Escape and the backdrop; the
 * shell closes it on a route change.
 */

import * as React from 'react'
import Link from 'next/link'
import {
  ClipboardList,
  LogOut,
  MessageCircleQuestion,
  PlusCircle,
  Settings,
  UserRound,
  Users,
  Bell,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CreditGauge } from '@/components/CreditGauge'
import { InstallAppRow } from '@/components/InstallApp'
import { cn } from '@/lib/utils'

export interface MoreSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  eventSlug: string
  /** Whether the viewer is signed in (the gauge and Sign out are theirs alone). */
  signedIn: boolean
  /** "Ask" is offered only to a viewer who can read a transcript of this gathering. */
  hasKnowledge?: boolean
  /** "Propose a session" appears only while proposals are open. */
  proposalsOpen?: boolean
  /** "Organizer workspace" appears only to organizers. */
  isOrganizer?: boolean
  onOpenAccount: () => void
  onSignOut: () => void
}

const ROW =
  'flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function MoreSheet({
  open,
  onOpenChange,
  eventSlug,
  signedIn,
  hasKnowledge,
  proposalsOpen,
  isOrganizer,
  onOpenAccount,
  onSignOut,
}: MoreSheetProps) {
  const base = `/e/${eventSlug}`
  const close = () => onOpenChange(false)

  const links: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { href: `${base}/participants`, label: 'People', icon: Users },
    { href: `${base}/my-votes`, label: 'My votes', icon: ClipboardList },
    ...(hasKnowledge ? [{ href: `${base}/ask`, label: 'Ask', icon: MessageCircleQuestion }] : []),
    ...(proposalsOpen ? [{ href: `${base}/propose`, label: 'Propose a session', icon: PlusCircle }] : []),
    ...(isOrganizer ? [{ href: `${base}/admin`, label: 'Organizer workspace', icon: Settings }] : []),
    { href: `${base}/settings/notifications`, label: 'Notification preferences', icon: Bell },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="bottom" size="sm" data-testid="more-sheet" className="gap-3">
        <DialogHeader>
          <DialogTitle>More</DialogTitle>
          <DialogDescription>The rest of this gathering, and your account.</DialogDescription>
        </DialogHeader>

        {signedIn && (
          <div className="overflow-hidden rounded-xl border border-border">
            <CreditGauge eventSlug={eventSlug} className="border-t-0" />
            <CreditGauge eventSlug={eventSlug} round="attendance" />
          </div>
        )}

        <nav aria-label="More of this gathering" className="-mx-1 flex flex-col">
          {links.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} onClick={close} className={ROW}>
              <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
              {label}
            </Link>
          ))}
          {signedIn && (
            <>
              <button
                type="button"
                onClick={() => {
                  close()
                  onOpenAccount()
                }}
                className={cn(ROW, 'text-left')}
              >
                <UserRound className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
                Account
              </button>
              <button
                type="button"
                onClick={() => {
                  close()
                  onSignOut()
                }}
                className={cn(ROW, 'mt-1 border-t border-border text-left')}
              >
                <LogOut className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
                Sign out
              </button>
            </>
          )}
        </nav>

        {/* Installing is not a destination, so it sits outside the nav — and it draws nothing at
            all on a browser with no install to offer, or once the offer has been turned down. */}
        <InstallAppRow className={cn(ROW, '-mx-1 w-full text-left')} onInstalled={close} />
      </DialogContent>
    </Dialog>
  )
}
