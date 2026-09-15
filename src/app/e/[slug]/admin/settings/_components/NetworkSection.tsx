'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Check, ExternalLink, Fingerprint, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { EventNetwork } from '@/contexts/EventContext'
import type { Event } from '@/types/event'
import { SectionCard } from './SectionCard'
import { createIdentity, SettingsError } from './shared'

/**
 * The gathering's own identity on the network (spec §8): its handle and DID, whether its
 * records are published, and — when minting failed at creation — a retry.
 */
export function NetworkSection({ event, network }: { event: Event; network: EventNetwork | null }) {
  const router = useRouter()
  const search = useSearchParams()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<string | null>(null)
  const pending = !network?.did
  const flaggedPending = search?.get('identity') === 'pending'

  const retry = async () => {
    setBusy(true); setError(null)
    try {
      const identity = await createIdentity(event.id)
      setCreated(identity.handle)
      router.refresh()
    } catch (err) {
      setError(err instanceof SettingsError ? err.message : 'The identity could not be created. Try again shortly.')
    } finally {
      setBusy(false)
    }
  }

  const profileUrl = network?.handle ? `https://bsky.app/profile/${encodeURIComponent(network.handle)}` : null
  const recordUrl = network?.gatheringUri?.startsWith('at://') ? `https://pdsls.dev/${network.gatheringUri}` : null

  return <SectionCard id="network" title="Network identity" description="The gathering’s own public identity on the open social network, separate from any organizer’s account.">
    {pending && !created ? <div role={flaggedPending ? 'alert' : undefined} className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="flex-1 min-w-[220px] space-y-2">
        <p className="font-medium">Identity not yet created</p>
        <p className="text-sm text-muted-foreground">The gathering was saved, but its network identity could not be created. It stays a draft until it has one; nothing else is affected.</p>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
      <Button type="button" onClick={retry} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}Retry</Button>
    </div> : <div className="space-y-4">
      {created ? <p className="flex items-center gap-2 text-sm text-primary"><Check className="h-4 w-4" />Identity created: @{created}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Fingerprint className="h-3.5 w-3.5" />Handle</p>
          <p className="font-mono text-sm break-all mt-1">@{network?.handle ?? created}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">DID</p>
          <p className="font-mono text-xs break-all mt-1">{network?.did ?? '…'}</p>
        </div>
      </div>
      <div className="rounded-xl border bg-secondary/40 p-4 text-sm">
        {network?.publishedAt
          ? <p>Published {new Date(network.publishedAt).toLocaleString()}. Its name, dates, description and rules are public records; they update when you save changes here.</p>
          : <p>Nothing is published yet. Moving the gathering out of draft writes its public records; a draft publishes nothing and can still be deleted entirely.</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {network?.publishedAt && profileUrl ? <Button asChild variant="outline" size="sm"><a href={profileUrl} target="_blank" rel="noopener noreferrer">View on the network<ExternalLink className="h-3.5 w-3.5 ml-2" /></a></Button> : null}
        {recordUrl ? <Button asChild variant="outline" size="sm"><a href={recordUrl} target="_blank" rel="noopener noreferrer">Inspect the record<ExternalLink className="h-3.5 w-3.5 ml-2" /></a></Button> : null}
        <Button asChild variant="ghost" size="sm"><Link href={`/e/${event.slug}/admin/atproto`}>Network page</Link></Button>
      </div>
    </div>}
  </SectionCard>
}
