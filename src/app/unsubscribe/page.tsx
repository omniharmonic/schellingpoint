import type { Metadata } from 'next'
import { sql } from '@/lib/db'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe'
import { UnsubscribeClient } from './UnsubscribeClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Unsubscribe',
  description: 'Turn off notification emails.',
  robots: { index: false, follow: false },
}

/**
 * `/unsubscribe?t=<token>` — the footer link of every notification email (inventory P2-7).
 *
 * The page only reads the token. Turning email off is a POST from the button, so a mail
 * client prefetching the link never unsubscribes anyone by accident.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>
}) {
  const params = await searchParams
  const raw = Array.isArray(params.t) ? params.t[0] : params.t
  const token = typeof raw === 'string' ? raw : ''
  const scope = verifyUnsubscribeToken(token)

  let eventName: string | null = null
  if (scope?.eventId) {
    const [event] = await sql<{ name: string }[]>`select name from events where id = ${scope.eventId}`
    eventName = event?.name ?? null
  }

  return <UnsubscribeClient token={token} valid={Boolean(scope)} eventName={eventName} />
}
