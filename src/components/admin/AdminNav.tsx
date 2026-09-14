'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  FileText,
  LayoutGrid,
  Settings,
  ArrowLeft,
  Megaphone,
  BarChart3,
  Tags,
  Ticket,
  DollarSign,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface AdminNavProps {
  eventSlug: string
  canManageSchedule: boolean
  canManageVenues: boolean
}

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  active: boolean
  show: boolean
}

export function AdminNav({ eventSlug, canManageSchedule, canManageVenues }: AdminNavProps) {
  const pathname = usePathname()

  const baseUrl = `/e/${eventSlug}/admin`
  const isActive = (path: string) =>
    path === baseUrl ? pathname === baseUrl : pathname?.startsWith(path)

  const navItems: NavItem[] = [
    {
      label: 'Sessions',
      href: baseUrl,
      icon: <FileText className="h-4 w-4" />,
      active: pathname === baseUrl,
      show: true,
    },
    {
      label: 'Schedule',
      href: `${baseUrl}/schedule`,
      icon: <LayoutGrid className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/schedule`),
      show: canManageSchedule,
    },
    {
      label: 'Setup',
      href: `${baseUrl}/setup`,
      icon: <Settings className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/setup`),
      show: canManageVenues,
    },
    {
      label: 'Tracks',
      href: `${baseUrl}/tracks`,
      icon: <Tags className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/tracks`),
      show: true,
    },
    {
      label: 'Tickets',
      href: `${baseUrl}/tickets`,
      icon: <Ticket className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/tickets`),
      show: true,
    },
    {
      label: 'Revenue',
      href: `${baseUrl}/revenue`,
      icon: <DollarSign className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/revenue`),
      show: true,
    },
    {
      label: 'Members',
      href: `${baseUrl}/members`,
      icon: <Users className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/members`),
      show: true,
    },
    {
      label: 'Communications',
      href: `${baseUrl}/communications`,
      icon: <Megaphone className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/communications`),
      show: true,
    },
    {
      label: 'Analytics',
      href: `${baseUrl}/analytics`,
      icon: <BarChart3 className="h-4 w-4" />,
      active: !!isActive(`${baseUrl}/analytics`),
      show: true,
    },
  ].filter((item) => item.show)

  return (
    <header className="border-b border-border bg-background sticky top-0 z-20 ruler-edge">
      <div className="container mx-auto px-4">
        {/* Title row */}
        <div className="flex items-center gap-3 h-12 border-b">
          <Link
            href={`/e/${eventSlug}/sessions`}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            <span className="hidden sm:inline">Back to event</span>
          </Link>
          <div className="h-4 w-px bg-border" />
          <span className="font-semibold text-sm tracking-wide text-muted-foreground">
            Admin
          </span>
        </div>

        {/* Tabs row */}
        <nav
          aria-label="Admin sections"
          className="flex items-stretch overflow-x-auto scrollbar-thin -mx-4 px-4"
        >
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                'group relative inline-flex items-center gap-2 px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors',
                'hover:text-foreground',
                item.active
                  ? 'text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              <span
                className={cn(
                  'transition-colors',
                  item.active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                )}
              >
                {item.icon}
              </span>
              {item.label}
              {item.active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
              )}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  )
}
