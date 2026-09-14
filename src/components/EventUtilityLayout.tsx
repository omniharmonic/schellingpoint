'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useEvent } from '@/contexts/EventContext'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

export function EventUtilityLayout({ children }: { children: React.ReactNode }) {
  const event = useEvent()
  return <div className="min-h-screen flex flex-col"><SiteHeader/><div className="container mx-auto px-5 pt-6"><Link href={`/e/${event.slug}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4"/>Back to {event.name}</Link></div><main className="flex-1">{children}</main><Footer variant="minimal" event={event}/></div>
}
