'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileText, LayoutGrid, Settings, ArrowLeft, Megaphone, BarChart3, Tags, Ticket, DollarSign, Users, Menu, X, ScanLine } from 'lucide-react'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { NetworkMark } from '@/components/GatheringArtwork'
import { WorkspaceHeader } from '@/components/WorkspaceHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const event = useEvent()
  const { can, isAdmin } = useEventRole()
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  const base = `/e/${event.slug}/admin`
  const groups = [
    { label: 'Program', items: [
      { label: 'Overview & sessions', href: base, icon: FileText, show: true },
      { label: 'Schedule builder', href: `${base}/schedule`, icon: LayoutGrid, show: can('manageSchedule') },
      { label: 'Tracks', href: `${base}/tracks`, icon: Tags, show: can('manageTracks') },
    ] },
    { label: 'Community', items: [
      { label: 'Members', href: `${base}/members`, icon: Users, show: isAdmin },
      { label: 'Messages', href: `${base}/communications`, icon: Megaphone, show: can('sendCommunications') },
      { label: 'Check-in', href: `/e/${event.slug}/checkin`, icon: ScanLine, show: can('checkInAttendees') },
    ] },
    { label: 'Event', items: [
      { label: 'Event settings', href: `${base}/settings`, icon: Settings, show: can('editEventSettings') },
      { label: 'Spaces & times', href: `${base}/setup`, icon: Settings, show: can('manageVenues') },
      { label: 'Tickets', href: `${base}/tickets`, icon: Ticket, show: isAdmin },
      { label: 'Revenue', href: `${base}/revenue`, icon: DollarSign, show: isAdmin },
      { label: 'Analytics', href: `${base}/analytics`, icon: BarChart3, show: can('viewAnalytics') },
    ] },
  ]
  const active = (href: string) => href === base ? pathname === base || pathname?.startsWith(`${base}/sessions`) : pathname === href || pathname?.startsWith(`${href}/`)
  const current = groups.flatMap(g => g.items).find(item => active(item.href))?.label || 'Organizer workspace'
  React.useEffect(() => { setOpen(false) }, [pathname])
  React.useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [])
  const navigation = <nav aria-label="Organizer navigation" className="space-y-6">
    {groups.map(group => group.items.some(item => item.show) && <div key={group.label}>
      <p className="px-3 mb-2 text-xs text-muted-foreground">{group.label}</p>
      <div className="space-y-1">{group.items.filter(item => item.show).map(item => <Link key={item.href} href={item.href} aria-current={active(item.href) ? 'page' : undefined} className="workspace-nav-link"><item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6}/>{item.label}</Link>)}</div>
    </div>)}
  </nav>
  return <div className="min-h-screen bg-background flex">
    <a href="#workspace-main" className="skip-link">Skip to content</a>
    <aside className="hidden md:flex flex-col w-[240px] lg:w-[260px] border-r bg-card fixed inset-y-0 left-0 z-20">
      <Link href="/" className="flex items-center gap-3 h-[76px] px-6 border-b font-semibold"><NetworkMark className="h-7 w-7 text-primary"/>Schelling Point</Link>
      <div className="px-5 py-6"><p className="font-semibold text-lg leading-snug mb-2 break-words">{event.name}</p><Badge variant="secondary">Organizer workspace</Badge></div>
      <div className="flex-1 overflow-y-auto px-3 pb-6">{navigation}</div>
      <div className="p-4 border-t"><Link href={`/e/${event.slug}/dashboard`} className="workspace-nav-link"><ArrowLeft className="h-4 w-4"/>Attendee view</Link></div>
    </aside>
    <div className="md:hidden fixed top-0 inset-x-0 z-30 border-b bg-card">
      <div className="h-16 flex items-center justify-between px-4 gap-3"><Link href={`/e/${event.slug}`} className="flex items-center gap-2 min-w-0"><NetworkMark className="h-7 w-7 shrink-0 text-primary"/><span className="truncate font-semibold">{event.name}</span></Link><Button variant="ghost" size="icon" onClick={() => setOpen(!open)} aria-label={open ? 'Close organizer navigation' : 'Open organizer navigation'} aria-expanded={open} aria-controls="admin-mobile-nav">{open ? <X className="h-5 w-5"/> : <Menu className="h-5 w-5"/>}</Button></div>
      {open && <div id="admin-mobile-nav" className="px-4 py-5 border-t max-h-[calc(100dvh-4rem)] overflow-y-auto">{navigation}<Link href={`/e/${event.slug}/dashboard`} className="workspace-nav-link mt-4"><ArrowLeft className="h-4 w-4"/>Attendee view</Link></div>}
    </div>
    <main id="workspace-main" tabIndex={-1} className="flex-1 min-w-0 md:ml-[240px] lg:ml-[260px] min-h-screen pt-16 md:pt-0"><WorkspaceHeader label={current}/><div className="workspace-content">{children}</div></main>
  </div>
}
