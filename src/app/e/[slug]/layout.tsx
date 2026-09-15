import type { Metadata } from 'next'
import { EventAccessGate } from '@/components/EventAccessGate'
import { getEventAccess, networkOf } from '@/lib/events'
import { isAdminRole } from '@/lib/permissions'
import { EventProvider } from '@/contexts/EventContext'

interface EventLayoutProps {
  params: Promise<{ slug: string }>
  children: React.ReactNode
}

export default async function EventLayout({ params, children }: EventLayoutProps) {
  const { slug } = await params
  const access = await getEventAccess(slug)

  if (!access.ok) return <EventAccessGate reason={access.reason} />

  const { row, event, viewer, membership } = access
  const network = networkOf(row)
  const organizer = membership ? isAdminRole(membership.role) : false
  // Before publication the gathering's identity is organizer business; afterwards it is public.
  const visibleNetwork = network.publishedAt || organizer ? network : null

  return (
    <EventProvider
      event={event}
      viewerId={viewer?.accountId ?? null}
      initialRole={membership?.role ?? null}
      initialVoteCredits={membership?.voteCredits ?? null}
      network={visibleNetwork}
    >
      {children}
    </EventProvider>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const access = await getEventAccess(slug)

  if (!access.ok) {
    return {
      title: access.reason === 'unknown' ? 'Event Not Found' : 'Gathering not available',
      robots: { index: false },
    }
  }
  const { event } = access
  return {
    title: `${event.name} | unconference`,
    description: event.description || event.tagline || `${event.name} unconference`,
    robots: event.visibility === 'public' ? undefined : { index: false },
    openGraph: {
      title: event.name,
      description: event.description || event.tagline || undefined,
      images: event.bannerUrl ? [event.bannerUrl] : undefined,
    },
  }
}
