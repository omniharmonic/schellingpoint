import Link from 'next/link'
import { SiteHeader } from '@/components/SiteHeader'
import { Button } from '@/components/ui/button'
import { NetworkMark } from '@/components/GatheringArtwork'

export default function NotFound() {
  return <div className="min-h-screen"><SiteHeader/><main className="max-w-lg mx-auto px-5 py-24 text-center"><NetworkMark className="h-14 w-14 text-primary mx-auto mb-8"/><h1 className="text-4xl font-semibold mb-4">This path doesn’t lead to a gathering.</h1><p className="text-muted-foreground leading-relaxed mb-8">The link may have changed, or this page is no longer available. Let’s find your way back.</p><Button asChild><Link href="/">Explore events</Link></Button></main></div>
}
