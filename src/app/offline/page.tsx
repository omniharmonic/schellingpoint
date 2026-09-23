import type { Metadata } from 'next'
import Link from 'next/link'
import { CloudOff } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'Offline | unconference',
  robots: { index: false, follow: false },
}

/**
 * The page the service worker serves when a request cannot reach the network at all.
 *
 * It is deliberately plain and deliberately honest about what still works: a schedule that was
 * loaded once is readable offline, and nothing that needs the server — voting, RSVPs, check-in
 * — is quietly queued behind the person's back.
 */
export default function OfflinePage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-2xl border bg-card p-8 text-center">
        <CloudOff className="mx-auto mb-4 h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <h1 className="mb-2 text-xl font-semibold">You are offline</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Schedules you have already opened are still readable — try going back. Anything that needs the
          server (voting, RSVPs, check-in) waits until you have a connection again; nothing is sent without you.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline"><Link href="/">Home</Link></Button>
          <Button asChild><a href="/events">Try again</a></Button>
        </div>
      </div>
    </main>
  )
}
