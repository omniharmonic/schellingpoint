'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import { WorkspaceHeader } from '@/components/WorkspaceHeader'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Presentation,
  Calendar,
  Heart,
  ClipboardList,
  Users,
  PlusCircle,
  Settings,
  LogOut,
  BarChart3,
  ChevronLeft,
  Menu,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { NotificationBell } from '@/components/NotificationBell'
import { OnboardingModal } from '@/components/auth/OnboardingModal'
import { SettingsModal } from '@/components/SettingsModal'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { useVoting, VotingProvider } from '@/hooks/useVoting'
import { useEvent, useEventRole } from '@/contexts/EventContext'

interface DashboardLayoutProps {
  children: React.ReactNode
}

function getNavItems(eventSlug: string) {
  return [
    { href: `/e/${eventSlug}/dashboard`, label: 'Your gathering', shortLabel: 'Home', icon: BarChart3 },
    { href: `/e/${eventSlug}/sessions`, label: 'Sessions', shortLabel: 'Sessions', icon: Presentation },
    { href: `/e/${eventSlug}/schedule`, label: 'Schedule', shortLabel: 'Schedule', icon: Calendar },
    { href: `/e/${eventSlug}/my-schedule`, label: 'My Schedule', shortLabel: 'Saved', icon: Heart },
    { href: `/e/${eventSlug}/my-votes`, label: 'My Votes', shortLabel: 'Votes', icon: ClipboardList },
    { href: `/e/${eventSlug}/participants`, label: 'People', shortLabel: 'People', icon: Users },
  ]
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
  // One ballot fetch per event for everything rendered in the workspace (gauge, cards, My Votes).
  return (
    <VotingProvider eventSlug={event.slug}>
      <DashboardShell>{children}</DashboardShell>
    </VotingProvider>
  )
}

function DashboardShell({ children }: DashboardLayoutProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, profile, signOut, needsOnboarding, refreshProfile } = useAuth()

  const event = useEvent()
  const proposalsOpen = isParticipationOpen(event, 'propose')
  const { isAdmin, voteCredits } = useEventRole()

  const navItems = React.useMemo(() => getNavItems(event.slug), [event.slug])
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)

  const handleSignOut = async () => {
    await signOut()
    router.push(`/e/${event.slug}?logged_out=true`)
  }
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [showSettings, setShowSettings] = React.useState(false)
  // Deep link: any page inside the workspace can open profile settings with ?settings=1
  // (used by the ATProto "Link a Bluesky account" hint).
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (url.searchParams.get('settings') === '1') {
      setShowSettings(true)
      url.searchParams.delete('settings')
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
    }
  }, [])

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

  return (
    <div className="min-h-screen bg-background flex">
      <a href="#workspace-main" className="skip-link">Skip to content</a>
      {/* ─── Desktop Sidebar ─── */}
      <aside className="hidden md:flex flex-col w-[240px] lg:w-[260px] flex-shrink-0 border-r border-border bg-card fixed inset-y-0 left-0 z-20">
        {/* Event branding */}
        <div className="p-5 min-h-[100px] border-b border-border">
          <Link href={`/e/${event.slug}`} className="flex items-center gap-2.5 group">
            {event.logoUrl ? (
              <img src={event.logoUrl} alt={event.name} className="h-8 w-8 rounded object-contain flex-shrink-0" />
            ) : (
              <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center text-primary font-display font-bold text-sm flex-shrink-0">
                {event.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0">
              <div className="font-display font-bold text-sm leading-tight truncate group-hover:text-primary transition-colors">
                {event.name}
              </div>
              <div className="text-xs text-muted-foreground tracking-wider">
                unconference
              </div>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <nav aria-label="Event navigation" className="flex-1 py-5 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'workspace-nav-link',
                  isActive
                    ? 'bg-secondary text-secondary-foreground font-semibold'
                    : 'text-muted-foreground'
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
                <span className="text-xs tracking-wider">{item.label}</span>
              </Link>
            )
          })}

          {/* Propose action */}
          {proposalsOpen && <div className="pt-3 px-1">
            <Button asChild size="sm" className="w-full justify-start gap-2 text-xs tracking-wider">
              <Link href={`/e/${event.slug}/propose`}>
                <PlusCircle className="h-4 w-4" strokeWidth={1.5} />
                Propose a session
              </Link>
            </Button>
          </div>

          }
          {/* Admin link */}
          {isAdmin && (
            <div className="pt-1 px-1">
              <Link
                href={`/e/${event.slug}/admin`}
                className={cn(
                  'workspace-nav-link',
                  pathname?.startsWith(`/e/${event.slug}/admin`)
                    ? 'text-primary bg-primary/8'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                <Settings className="h-4 w-4" strokeWidth={1.5} />
                Admin
              </Link>
            </div>
          )}
        </nav>

        {/* Credit gauge */}
        {user && <CreditGauge eventSlug={event.slug} />}

        {/* User section */}
        <div className="p-3 border-t border-border">
          {user ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80 transition-opacity"
              >
                <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center overflow-hidden border border-border flex-shrink-0">
                  {profile?.avatar_url ? (
                    <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-xs font-medium text-muted-foreground">
                      {(profile?.display_name || user.email || '?')[0].toUpperCase()}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground truncate">
                  {profile?.display_name || user.email?.split('@')[0]}
                </span>
              </button>
              <div className="flex items-center gap-1">
                <NotificationBell />
                <Button variant="ghost" size="icon-sm" onClick={handleSignOut} title="Sign out">
                  <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              </div>
            </div>
          ) : (
            <Link
              href={`/login?redirect=${encodeURIComponent(pathname || `/e/${event.slug}/dashboard`)}`}
              className="flex items-center justify-center px-3 py-2 text-xs rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
            >
              Sign In
            </Link>
          )}
        </div>
      </aside>

      {/* ─── Mobile Header ─── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 border-b border-border bg-background">
        <div className="flex items-center justify-between h-16 px-4">
          <Link href={`/e/${event.slug}`} className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-primary font-display font-bold text-xs flex-shrink-0">
              {event.name.charAt(0)}
            </div>
            <span className="font-display font-bold text-sm truncate">{event.name}</span>
          </Link>
          <div className="flex items-center gap-2">
            {user && <NotificationBell />}
            <button
              aria-label={mobileNavOpen ? "Close event navigation" : "Open event navigation"}
              aria-expanded={mobileNavOpen}
              aria-controls="event-mobile-nav"
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              className="p-2 rounded-md text-muted-foreground hover:text-foreground"
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile nav dropdown */}
        {mobileNavOpen && (
          <div id="event-mobile-nav" className="border-t border-border bg-card px-4 py-3 space-y-1 animate-slide-down max-h-[calc(100dvh-4rem)] overflow-y-auto">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'workspace-nav-link',
                    isActive
                      ? 'bg-secondary text-secondary-foreground font-semibold'
                      : 'text-muted-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.5} />
                  <span className="text-xs tracking-wider">{item.label}</span>
                </Link>
              )
            })}
            {proposalsOpen && <Link
              href={`/e/${event.slug}/propose`}
              className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-primary text-xs tracking-wider"
            >
              <PlusCircle className="h-4 w-4" strokeWidth={1.5} />
              Propose Session
            </Link>}
            {isAdmin && (
              <Link
                href={`/e/${event.slug}/admin`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-muted-foreground text-xs tracking-wider"
              >
                <Settings className="h-4 w-4" strokeWidth={1.5} />
                Admin
              </Link>
            )}
            {user ? (
              <>
                <div className="mt-2">
                  <CreditGauge eventSlug={event.slug} />
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border mt-2 px-3">
                  <button
                    onClick={() => { setMobileNavOpen(false); setShowSettings(true); }}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center overflow-hidden border border-border">
                      {profile?.avatar_url ? (
                        <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-xs font-medium text-muted-foreground">
                          {(profile?.display_name || user.email || '?')[0].toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className="truncate max-w-[140px]">{profile?.display_name || user.email?.split('@')[0]}</span>
                  </button>
                  <Button variant="ghost" size="icon-sm" onClick={handleSignOut} title="Sign out">
                    <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </Button>
                </div>
              </>
            ) : (
              <div className="pt-2 border-t border-border mt-2 px-3">
                <Link
                  href={`/login?redirect=${encodeURIComponent(pathname || `/e/${event.slug}/dashboard`)}`}
                  className="flex items-center justify-center py-2.5 text-xs rounded-md bg-primary text-primary-foreground"
                >
                  Sign In
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Main Content ─── */}
      <main id="workspace-main" tabIndex={-1} className="min-w-0 flex-1 md:ml-[240px] lg:ml-[260px] min-h-screen">
        {/* Mobile spacer for fixed header */}
        <div className="h-16 md:hidden" />

        <WorkspaceHeader label={navItems.find(item => pathname === item.href || pathname?.startsWith(`${item.href}/`))?.label || (pathname?.endsWith('/propose') ? 'Propose a session' : pathname?.endsWith('/settings/notifications') ? 'Notification preferences' : pathname?.endsWith('/notifications') ? 'Notifications' : 'Your gathering')} />
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
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </div>
  )
}
