'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import { WorkspaceHeader } from '@/components/WorkspaceHeader'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Presentation,
  Calendar,
  Heart,
  ClipboardList,
  Users,
  PlusCircle,
  Settings,
  BarChart3,
  Menu,
  X,
  MapPin,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Toaster } from '@/components/ui/toast'
import { NotificationBell } from '@/components/NotificationBell'
import { OnboardingModal } from '@/components/auth/OnboardingModal'
import { WorkspaceUserMenu } from '@/components/WorkspaceUserMenu'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { useVoting, VotingProvider } from '@/hooks/useVoting'
import { useEvent, useEventRole } from '@/contexts/EventContext'

interface DashboardLayoutProps {
  children: React.ReactNode
}

/** One sidebar width, used by the aside and the main element's offset. */
const SIDEBAR_WIDTH = 'w-[240px] lg:w-[260px]'
const SIDEBAR_OFFSET = 'md:ml-[240px] lg:ml-[260px]'

export function getNavItems(eventSlug: string) {
  return [
    { href: `/e/${eventSlug}/dashboard`, label: 'Home', icon: BarChart3 },
    { href: `/e/${eventSlug}/sessions`, label: 'Sessions', icon: Presentation },
    { href: `/e/${eventSlug}/schedule`, label: 'Schedule', icon: Calendar },
    { href: `/e/${eventSlug}/map`, label: 'Map', icon: MapPin },
    { href: `/e/${eventSlug}/my-schedule`, label: 'My schedule', icon: Heart },
    { href: `/e/${eventSlug}/my-votes`, label: 'My votes', icon: ClipboardList },
    { href: `/e/${eventSlug}/participants`, label: 'People', icon: Users },
  ]
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

// ============================================================================
// Credit Gauge — compact sidebar widget
// ============================================================================

function CreditGauge({ eventSlug }: { eventSlug: string }) {
  const voting = useVoting(eventSlug)
  if (!voting.signedIn || voting.status !== 'open' || voting.loading) return null
  const { budget, spent, remaining, mechanism } = voting
  const pct = budget > 0 ? (remaining / budget) * 100 : 0
  const noun = mechanism === 'approval' ? 'Approvals' : 'Voting credits'

  return (
    <div className="px-4 py-3 border-t border-border">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs text-muted-foreground" id={`credit-gauge-${eventSlug}`}>
          {noun}
        </span>
        <span className="text-sm font-bold tabular-nums text-primary">
          {remaining}<span className="text-muted-foreground font-normal">/{budget}</span>
        </span>
      </div>
      <Progress value={pct} className="h-1.5" aria-labelledby={`credit-gauge-${eventSlug}`} aria-valuetext={`${remaining} of ${budget} left, ${spent} used`} />
      <p className="text-xs text-muted-foreground mt-1">
        {voting.canVote ? 'Support the ideas you want to see.' : voting.reason}
      </p>
    </div>
  )
}

// ============================================================================
// Main Layout
// ============================================================================

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const event = useEvent()
  // One ballot fetch per event for everything rendered in the workspace (gauge, cards, My votes).
  return (
    <VotingProvider eventSlug={event.slug}>
      <DashboardShell>{children}</DashboardShell>
    </VotingProvider>
  )
}

function DashboardShell({ children }: DashboardLayoutProps) {
  const pathname = usePathname()
  const { user, profile, needsOnboarding, refreshProfile } = useAuth()

  const event = useEvent()
  const proposalsOpen = isParticipationOpen(event, 'propose')
  const { isAdmin, voteCredits } = useEventRole()

  const navItems = React.useMemo(() => getNavItems(event.slug), [event.slug])
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)

  const [showOnboarding, setShowOnboarding] = React.useState(false)

  React.useEffect(() => {
    if (needsOnboarding) setShowOnboarding(true)
  }, [needsOnboarding])

  // Close mobile nav on route change
  React.useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  const handleOnboardingComplete = () => {
    setShowOnboarding(false)
    refreshProfile()
  }

  const loginHref = `/login?returnTo=${encodeURIComponent(pathname || `/e/${event.slug}/dashboard`)}`
  const adminActive = pathname?.startsWith(`/e/${event.slug}/admin`)

  const navLinks = (
    <>
      {navItems.map((item) => {
        const Icon = item.icon
        const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`)
        return (
          <Link key={item.href} href={item.href} aria-current={isActive ? 'page' : undefined} className="workspace-nav-link">
            <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        )
      })}
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

  // The mobile bar already carries the bell, so the mobile nav's user block omits it.
  const userBlock = (withBell: boolean) => user ? (
    <WorkspaceUserMenu withBell={withBell} onOpenAccount={() => setMobileNavOpen(false)} />
  ) : (
    <Button asChild size="sm" className="w-full">
      <Link href={loginHref}>Sign in</Link>
    </Button>
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
        <nav aria-label="Event navigation" className="flex-1 py-5 px-3 space-y-1 overflow-y-auto">
          {navLinks}
        </nav>

        {/* Credit gauge */}
        {user && <CreditGauge eventSlug={event.slug} />}

        {/* User section */}
        <div className="p-3 border-t border-border">{userBlock(true)}</div>
      </aside>

      {/* ─── Mobile Header ─── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 border-b border-border bg-background">
        <div className="flex items-center justify-between h-16 px-4">
          <Link href={`/e/${event.slug}`} className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-primary font-display font-bold text-xs flex-shrink-0" aria-hidden="true">
              {event.name.charAt(0)}
            </div>
            <span className="font-display font-bold text-sm truncate">{event.name}</span>
          </Link>
          <div className="flex items-center gap-1">
            {user && <NotificationBell />}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={mobileNavOpen ? 'Close event navigation' : 'Open event navigation'}
              aria-expanded={mobileNavOpen}
              aria-controls="event-mobile-nav"
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
            >
              {mobileNavOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </Button>
          </div>
        </div>

        {/* Mobile nav dropdown */}
        {mobileNavOpen && (
          <div id="event-mobile-nav" className="border-t border-border bg-card px-4 py-3 space-y-1 animate-slide-down max-h-[calc(100dvh-4rem)] overflow-y-auto">
            <nav aria-label="Event navigation" className="space-y-1">{navLinks}</nav>
            {user && (
              <div className="mt-2">
                <CreditGauge eventSlug={event.slug} />
              </div>
            )}
            <div className="pt-2 border-t border-border mt-2">{userBlock(false)}</div>
          </div>
        )}
      </div>

      {/* ─── Main Content ─── */}
      <main id="workspace-main" tabIndex={-1} className={cn('min-w-0 flex-1 min-h-screen', SIDEBAR_OFFSET)}>
        {/* Mobile spacer for fixed header */}
        <div className="h-16 md:hidden" />

        <WorkspaceHeader label={workspaceLabel(pathname, event.slug)} />
        <div className="workspace-content">
          {children}
        </div>
      </main>

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
