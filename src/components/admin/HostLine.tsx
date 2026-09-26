'use client'

/**
 * The one-line "who is hosting" under a session in the organizer screens, with the host's name
 * linking to their profile in this gathering (design §3.2).
 *
 * The link appears only for a session with a real host account; an organizer-typed "Listed as …"
 * name belongs to nobody with a profile, and is never a link (and never published — see
 * `session_host_listings`).
 */

import Link from 'next/link'
import { hostLabel, type AdminSession } from '@/components/admin/types'
import { profileHref } from '@/app/e/[slug]/people/shared'
import { cn } from '@/lib/utils'

export type HostLineSession = Pick<AdminSession, 'host_id' | 'host_display_name' | 'host_did' | 'listed_host_name'>

export function HostLine({
  session,
  slug,
  className,
}: {
  session: HostLineSession
  slug: string
  className?: string
}) {
  const label = hostLabel(session)
  if (!label) return null
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {session.host_did ? (
        <Link href={profileHref(slug, session.host_did)} className="hover:text-primary hover:underline">
          {label}
        </Link>
      ) : (
        label
      )}
    </p>
  )
}
