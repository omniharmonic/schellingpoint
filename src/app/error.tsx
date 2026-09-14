'use client'

import { Button } from '@/components/ui/button'
import Link from 'next/link'

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const needsReload = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module/i.test(`${error.name} ${error.message}`)
  return <main className="min-h-[70vh] flex items-center justify-center p-6"><div className="max-w-md text-center" role="alert"><h1 className="text-3xl font-semibold mb-3">We couldn’t load this page.</h1><p className="text-muted-foreground leading-relaxed mb-6">{needsReload ? 'The app was updated while this page was open. Reload to load the current version. Your saved event draft will still be here.' : 'Something interrupted this page. Try again, or return to your event.'}</p><div className="flex flex-wrap justify-center gap-3"><Button onClick={() => needsReload ? window.location.reload() : reset()}>{needsReload ? 'Reload page' : 'Try again'}</Button><Button asChild variant="outline"><Link href="/">Explore events</Link></Button></div></div></main>
}
