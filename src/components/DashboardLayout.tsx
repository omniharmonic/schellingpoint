'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import { WorkspaceHeader, type WorkspaceBack } from '@/components/WorkspaceHeader'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Presentation,
  Calendar,
  ClipboardList,
  Users,
  PlusCircle,
  Settings,
  BarChart3,
  MapPin,
  MessageCircleQuestion,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/toast'
import { CreditGauge } from '@/components/CreditGauge'
import { MobileTabBar } from '@/components/MobileTabBar'
import { MoreSheet } from '@/components/MoreSheet'
import { NotificationBell } from '@/components/NotificationBell'
import { OnboardingModal } from '@/components/auth/OnboardingModal'
import { AccountModalProvider, useAccountModal, WorkspaceUserMenu } from '@/components/WorkspaceUserMenu'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { VotingProvider } from '@/hooks/useVoting'
import { useEvent, useEventHasKnowledge, useEventRole } from '@/contexts/EventContext'

interface DashboardLayoutProps {
  children: React.ReactNode
}

// The gauge lives in its own file now that the drawer it used to sit in is gone (design §2.5);
// re-exported so callers that knew it from here still find it.
export { CreditGauge } from '@/components/CreditGauge'

/** One sidebar width, used by the aside and the main element's offset. */
const SIDEBAR_WIDTH = 'w-[240px] lg:w-[260px]'
const SIDEBAR_OFFSET = 'md:ml-[240px] lg:ml-[260px]'

/**
 * The workspace sidebar, in two groups (design §1): the four destinations the bottom bar also
 * carries, then the ones a tap deeper. `hasKnowledge` (server-computed, `EventProvider`) adds
 * "Ask", which is offered only to a viewer who can actually read a transcript of this gathering
 * (design §10.2).
 *
 * "My schedule" is not a nav item: it is a view of Schedule (design §4).
 */
export function getNavGroups(eventSlug: string, opts: { hasKnowledge?: boolean } = {}) {
  return [
    [
      { href: `/e/${eventSlug}/dashboard`, label: 'Home', icon: BarChart3 },
      { href: `/e/${eventSlug}/sessions`, label: 'Sessions', icon: Presentation },
      { href: `/e/${eventSlug}/schedule`, label: 'Schedule', icon: Calendar },
      { href: `/e/${eventSlug}/map`, label: 'Map', icon: MapPin },
    ],
    [
      { href: `/e/${eventSlug}/participants`, label: 'People', icon: Users },
      { href: `/e/${eventSlug}/my-votes`, label: 'My votes', icon: ClipboardList },
      ...(opts.hasKnowledge ? [{ href: `/e/${eventSlug}/ask`, label: 'Ask', icon: MessageCircleQuestion }] : []),
    ],
  ]
}

/** Flat nav list, for label lookups and anything that does not care about the grouping. */
export function getNavItems(eventSlug: string, opts: { hasKnowledge?: boolean } = {}) {
  return getNavGroups(eventSlug, opts).flat()
}

/**
 * Route → breadcrumb label for pages inside the workspace that are not nav items.
 * Longest suffix first so `/settings/notifications` wins over `/settings`.
 */
const ROUTE_LABELS: ReadonlyArray<readonly [suffix: string, label: string]> = [
  ['/settings/notifications', 'Notification preferences'],
  ['/notifications', 'Notifications'],
  ['/settings', 'Settings'],
  ['/propose', 'Propose a session'],
  ['/tickets', 'Tickets'],
  ['/checkin', 'Check-in'],
  ['/ask', 'Ask the gathering'],
  ['/admin', 'Organizer workspace'],
]

export function workspaceLabel(pathname: string | null, eventSlug: string): string {
  if (!pathname) return 'Your gathering'
  const nav = getNavItems(eventSlug).find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
  if (nav) return nav.label
  const base = `/e/${eventSlug}`
  const hit = ROUTE_LABELS.find(([suffix]) => pathname === `${base}${suffix}` || pathname.startsWith(`${base}${suffix}/`))
  return hit?.[1] ?? 'Your gathering'
}

/**
 * Where the mobile context row's back link goes, when there is one (design §2.3, §5.1).
 * A session page belongs to the list it came from; a top-level page has nowhere to go back to
 * and shows its own name instead.
 */
export function workspaceBack(pathname: string | null, eventSlug: string): WorkspaceBack | null {
  if (!pathname) return null
  const base = `/e/${eventSlug}`
  if (pathname.startsWith(`${base}/sessions/`)) return { href: `${base}/sessions`, label: 'Sessions' }
  return null
}

// ============================================================================
// Main Layout
// ============================================================================

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const event = useEvent()
  // One ballot fetch per event for everything rendered in the workspace (gauge, cards, My votes),
  // and one Account modal for every way into it (header avatar, More sheet, ?settings=1).
  return (
    <VotingProvider eventSlug={event.slug}>
      <AccountModalProvider gathering={{ slug: event.slug, name: event.name }}>
        <DashboardShell>{children}</DashboardShell>
      </AccountModalProvider>
    </VotingProvider>
  )
}

function DashboardShell({ children }: DashboardLayoutProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, profile, needsOnboarding, refreshProfile, signOut } = useAuth()

  const event = useEvent()
  const proposalsOpen = isParticipationOpen(event, 'propose')
  const { isAdmin, voteCredits } = useEventRole()
  const account = useAccountModal()

  const hasKnowledge = useEventHasKnowledge()
  const navGroups = React.useMemo(() => getNavGroups(event.slug, { hasKnowledge }), [event.slug, hasKnowledge])
  const [moreOpen, setMoreOpen] = React.useState(false)

  const [showOnboarding, setShowOnboarding] = React.useState(false)

  React.useEffect(() => {
    if (needsOnboarding) setShowOnboarding(true)
  }, [needsOnboarding])

  // The More sheet is about where you are, so arriving somewhere else closes it.
  React.useEffect(() => {
    setMoreOpen(false)
  }, [pathname])

  const handleOnboardingComplete = () => {
    setShowOnboarding(false)
    refreshProfile()
  }

  const handleSignOut = async () => {
    await signOut()
    router.push(`/e/${event.slug}?logged_out=true`)
  }

  const loginHref = `/login?returnTo=${encodeURIComponent(pathname || `/e/${event.slug}/dashboard`)}`
  const adminActive = pathname?.startsWith(`/e/${event.slug}/admin`)

  const navLinks = (
    <>
      {navGroups.map((group, index) => (
        <div key={index} className={index > 0 ? 'mt-3 space-y-1 border-t border-border pt-3' : 'space-y-1'}>
          {group.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`)
            return (
              <Link key={item.href} href={item.href} aria-current={isActive ? 'page' : undefined} className="workspace-nav-link">
                <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            )
          })}
        </div>
      ))}
      {proposalsOpen && (
        <div className="pt-3 px-1">
          <Button asChild size="sm" className="w-full justify-start gap-2">
            <Link href={`/e/${event.slug}/propose`}>
              <PlusCircle className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              Propose a session
            </Link>
          </Button>
        </div>
      )}
      {isAdmin && (
        <div className="pt-1 px-1">
          <Link href={`/e/${event.slug}/admin`} aria-current={adminActive ? 'page' : undefined} className="workspace-nav-link">
            <Settings className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            Organizer workspace
          </Link>
        </div>
      )}
    </>
  )

  return (
    <div className="min-h-screen bg-background flex">
      <a href="#workspace-main" className="skip-link">Skip to content</a>
      {/* ─── Desktop Sidebar ─── */}
      <aside className={cn('hidden md:flex flex-col flex-shrink-0 border-r border-border bg-card fixed inset-y-0 left-0 z-20', SIDEBAR_WIDTH)}>
        {/* Event branding */}
        <div className="p-5 min-h-[100px] border-b border-border">
          <Link href={`/e/${event.slug}`} className="flex items-center gap-2.5 group">
            {event.logoUrl ? (
              <img src={event.logoUrl} alt="" className="h-8 w-8 rounded object-contain flex-shrink-0" />
            ) : (
              <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center text-primary font-display font-bold text-sm flex-shrink-0" aria-hidden="true">
                {event.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0">
              <div className="font-display font-bold text-sm leading-tight truncate group-hover:text-primary transition-colors">
                {event.name}
              </div>
              <div className="text-xs text-muted-foreground tracking-wider">unconference</div>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <nav aria-label="Event navigation" className="flex-1 py-5 px-3 overflow-y-auto">
          {navLinks}
        </nav>

        {/* Credit gauge */}
        {user && <CreditGauge eventSlug={event.slug} />}
        {user && <CreditGauge eventSlug={event.slug} round="attendance" />}

        {/* User section */}
        <div className="p-3 border-t border-border">
          {user ? (
            <WorkspaceUserMenu />
          ) : (
            <Button asChild size="sm" className="w-full">
              <Link href={loginHref}>Sign in</Link>
            </Button>
          )}
        </div>
      </aside>

      {/* ─── Mobile Header: the gathering, the bell, and one tap to your profile ─── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 border-b border-border bg-background">
        <div className="flex items-center justify-between h-16 px-4">
          <Link href={`/e/${event.slug}`} className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-primary font-display font-bold text-xs flex-shrink-0" aria-hidden="true">
              {event.name.charAt(0)}
            </div>
            <span className="font-display font-bold text-sm truncate">{event.name}</span>
          </Link>
          <div className="flex items-center gap-0.5">
            {user && <NotificationBell />}
            {user ? (
              <WorkspaceUserMenu variant="avatar" />
            ) : (
              <Button asChild size="sm">
                <Link href={loginHref}>Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ─── Main Content ─── */}
      <main id="workspace-main" tabIndex={-1} className={cn('min-w-0 flex-1 min-h-screen pb-safe', SIDEBAR_OFFSET)}>
        {/* Mobile spacer for fixed header */}
        <div className="h-16 md:hidden" />

        <WorkspaceHeader label={workspaceLabel(pathname, event.slug)} back={workspaceBack(pathname, event.slug)} />
        <div className="workspace-content">
          {children}
        </div>
      </main>

      {/* ─── The floating bar, and everything one tap deeper ─── */}
      <MobileTabBar eventSlug={event.slug} pathname={pathname} onMore={() => setMoreOpen(true)} moreOpen={moreOpen} />
      <MoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        eventSlug={event.slug}
        signedIn={!!user}
        hasKnowledge={hasKnowledge}
        proposalsOpen={proposalsOpen}
        isOrganizer={isAdmin}
        onOpenAccount={() => account?.open()}
        onSignOut={() => void handleSignOut()}
      />

      {/* Modals */}
      {showOnboarding && user && (
        <OnboardingModal
          userId={user.id}
          email={user.email || ''}
          initialProfile={profile}
          onComplete={handleOnboardingComplete}
          suggestedTopics={event.suggestedTopics}
          voteCredits={voteCredits}
          votingMechanism={event.votingMechanism}
          requireProposalApproval={event.requireProposalApproval}
        />
      )}
      <Toaster />
    </div>
  )
}
