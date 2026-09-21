'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ArrowLeft,
  BarChart3,
  CalendarRange,
  DollarSign,
  FileText,
  Globe,
  LayoutGrid,
  Loader2,
  Lock,
  Megaphone,
  Menu,
  ScanLine,
  Settings,
  Tags,
  Ticket,
  Users,
  X,
} from 'lucide-react'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { NetworkMark } from '@/components/GatheringArtwork'
import { WorkspaceHeader } from '@/components/WorkspaceHeader'
import { WorkspaceUserMenu } from '@/components/WorkspaceUserMenu'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Toaster } from '@/components/ui/toast'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const event = useEvent()
  const { can, isAdmin, role, isLoading } = useEventRole()
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  const base = `/e/${event.slug}/admin`
  const groups = [
    { label: 'Program', items: [
      { label: 'Overview & sessions', href: base, icon: FileText, show: can('approveProposals') || can('manageSchedule') },
      { label: 'Schedule builder', href: `${base}/schedule`, icon: LayoutGrid, show: can('manageSchedule') },
      { label: 'Spaces & times', href: `${base}/setup`, icon: CalendarRange, show: can('manageVenues') },
      { label: 'Tracks', href: `${base}/tracks`, icon: Tags, show: can('manageTracks') },
    ] },
    { label: 'Community', items: [
      { label: 'Members', href: `${base}/members`, icon: Users, show: isAdmin },
      { label: 'Announcements & emails', href: `${base}/communications`, icon: Megaphone, show: can('sendCommunications') },
      { label: 'Check-in', href: `${base}/checkin`, icon: ScanLine, show: can('checkInAttendees') },
    ] },
    { label: 'Gathering', items: [
      { label: 'Settings', href: `${base}/settings`, icon: Settings, show: can('editEventSettings') },
      { label: 'Tickets', href: `${base}/tickets`, icon: Ticket, show: isAdmin },
      { label: 'Revenue', href: `${base}/revenue`, icon: DollarSign, show: isAdmin },
      { label: 'Analytics', href: `${base}/analytics`, icon: BarChart3, show: can('viewAnalytics') },
      { label: 'Network', href: `${base}/atproto`, icon: Globe, show: isAdmin || role === 'moderator' },
    ] },
  ]
  // Routes that are not nav items but still need a breadcrumb.
  const extraLabels: Array<{ href: string; label: string }> = [
    { href: `${base}/sessions/new`, label: 'Add a session' },
    { href: `${base}/sessions`, label: 'Overview & sessions' },
  ]
  const active = (href: string) => href === base ? pathname === base || pathname?.startsWith(`${base}/sessions`) : pathname === href || pathname?.startsWith(`${href}/`)
  const current =
    extraLabels.find((item) => pathname === item.href || pathname?.startsWith(`${item.href}/`))?.label ||
    groups.flatMap((g) => g.items).find((item) => active(item.href))?.label ||
    'Organizer workspace'
  React.useEffect(() => { setOpen(false) }, [pathname])
  React.useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [])
  // The organizer workspace is for organizer roles only (volunteers get the door); every API it calls enforces the same.
  const organizer = can('approveProposals') || can('manageSchedule') || can('viewAnalytics') || can('sendCommunications') || can('checkInAttendees')
  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center" role="status" aria-label="Loading organizer workspace"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground"/></div>
  }
  if (!organizer) {
    return <main id="workspace-main" className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md text-center rounded-2xl border bg-card p-8">
        <Lock className="h-8 w-8 mx-auto mb-4 text-muted-foreground" aria-hidden/>
        <h1 className="text-xl font-display font-semibold mb-2">Organizers only</h1>
        <p className="text-sm text-muted-foreground mb-6">{role ? 'Your role in this gathering does not include the organizer workspace.' : 'Sign in with an organizer account to open the organizer workspace.'}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline"><Link href={`/e/${event.slug}`}>Gathering page</Link></Button>
          {!role && <Button asChild><Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/admin`)}`}>Sign in</Link></Button>}
        </div>
      </div>
    </main>
  }
  const navigation = <nav aria-label="Organizer navigation" className="space-y-6">
    {groups.map(group => group.items.some(item => item.show) && <div key={group.label}>
      <p className="px-3 mb-2 text-xs text-muted-foreground">{group.label}</p>
      <div className="space-y-1">{group.items.filter(item => item.show).map(item => <Link key={item.href} href={item.href} aria-current={active(item.href) ? 'page' : undefined} className="workspace-nav-link"><item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} aria-hidden="true"/>{item.label}</Link>)}</div>
    </div>)}
  </nav>
  const attendeeView = <Link href={`/e/${event.slug}/dashboard`} className="workspace-nav-link"><ArrowLeft className="h-4 w-4" aria-hidden="true"/>Attendee view</Link>
  return <div className="min-h-screen bg-background flex">
    <a href="#workspace-main" className="skip-link">Skip to content</a>
    <aside className="hidden md:flex flex-col w-[240px] lg:w-[260px] border-r bg-card fixed inset-y-0 left-0 z-20">
      <Link href={`/e/${event.slug}`} className="flex items-center gap-3 h-[76px] px-6 border-b font-semibold"><NetworkMark className="h-7 w-7 text-primary"/>unconference</Link>
      <div className="px-5 py-6"><p className="font-semibold text-lg leading-snug mb-2 break-words">{event.name}</p><Badge variant="secondary">Organizer workspace</Badge></div>
      <div className="flex-1 overflow-y-auto px-3 pb-6">{navigation}</div>
      <div className="border-t p-3 space-y-2">
        {attendeeView}
        <WorkspaceUserMenu />
      </div>
    </aside>
    <div className="md:hidden fixed top-0 inset-x-0 z-30 border-b bg-card">
      <div className="h-16 flex items-center justify-between px-4 gap-3"><Link href={`/e/${event.slug}`} className="flex items-center gap-2 min-w-0"><NetworkMark className="h-7 w-7 shrink-0 text-primary"/><span className="truncate font-semibold">{event.name}</span></Link><Button variant="ghost" size="icon" onClick={() => setOpen(!open)} aria-label={open ? 'Close organizer navigation' : 'Open organizer navigation'} aria-expanded={open} aria-controls="admin-mobile-nav">{open ? <X className="h-5 w-5"/> : <Menu className="h-5 w-5"/>}</Button></div>
      {open && <div id="admin-mobile-nav" className="px-4 py-5 border-t max-h-[calc(100dvh-4rem)] overflow-y-auto space-y-4">
        {navigation}
        <div className="border-t pt-4 space-y-2">
          {attendeeView}
          <WorkspaceUserMenu onOpenAccount={() => setOpen(false)} />
        </div>
      </div>}
    </div>
    <main id="workspace-main" tabIndex={-1} className="flex-1 min-w-0 md:ml-[240px] lg:ml-[260px] min-h-screen pt-16 md:pt-0">
      <WorkspaceHeader label={current}/>
      <nav aria-label="Breadcrumb" className="md:hidden flex items-center gap-2 border-b bg-card/70 px-5 py-2.5 text-sm">
        <span className="truncate text-muted-foreground">Organizer workspace</span>
        <span className="text-border" aria-hidden="true">/</span>
        <span className="truncate font-medium" aria-current="page">{current}</span>
      </nav>
      <div className="workspace-content">{children}</div>
    </main>
    <Toaster />
  </div>
}
