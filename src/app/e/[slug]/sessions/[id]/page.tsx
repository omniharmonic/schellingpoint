import type { Metadata } from 'next'
import { getEventBySlug, getEventAccessReason } from '@/lib/events'
import { EventAccessGate } from '@/components/EventAccessGate'
import { loadEventAccess, isUuid } from '@/app/api/v1/sessions/_lib/access'
import { getSession } from '@/app/api/v1/sessions/_lib/read'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import { SessionDetailClient } from './SessionDetailClient'

interface SessionPageProps {
  params: Promise<{ slug: string; id: string }>
}

/** The session as the current viewer may see it (same R9 filter as the API). */
async function loadSession(slug: string, id: string) {
  if (!isUuid(id)) return null
  const access = await loadEventAccess(undefined, slug)
  if (access instanceof Response) return null
  return getSession(access, id)
}

export async function generateMetadata({ params }: SessionPageProps): Promise<Metadata> {
  const { slug, id } = await params
  const event = await getEventBySlug(slug)
  if (!event) {
    return { title: 'Event Not Found', description: 'This event could not be found.' }
  }
  const session = await loadSession(slug, id)
  if (!session) {
    return { title: `Session Not Found - ${event.name}`, description: 'This session could not be found.' }
  }

  const byline = hostByline({ ...session, listed_as: undefined })
  const trackName = session.track?.name ? ` | ${session.track.name}` : ''
  const format = session.format ? session.format.charAt(0).toUpperCase() + session.format.slice(1) : 'Session'
  const rawDescription = session.description || `Join this session at ${event.name}`
  const truncated = rawDescription.length > 155 ? `${rawDescription.substring(0, 152)}...` : rawDescription
  const description = `${format} · ${byline}${trackName}. ${truncated}`
  const siteUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001').replace(/\/+$/, '')
  const sessionUrl = `${siteUrl}/e/${slug}/sessions/${id}`
  const image = event.bannerUrl || '/og-image.png'

  return {
    title: `${session.title} - ${event.name}`,
    description,
    openGraph: {
      title: session.title,
      description,
      url: sessionUrl,
      siteName: event.name,
      images: [{ url: image, width: 1200, height: 630, alt: `${session.title} - ${event.name}` }],
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title: session.title,
      description,
      images: [image],
    },
  }
}

export default async function SessionDetailPage({ params }: SessionPageProps) {
  const { slug, id } = await params
  const event = await getEventBySlug(slug)
  if (!event) {
    return <EventAccessGate reason={await getEventAccessReason(slug)} />
  }
  const session = await loadSession(slug, id)
  return <SessionDetailClient sessionId={id} initialSession={session} />
}
