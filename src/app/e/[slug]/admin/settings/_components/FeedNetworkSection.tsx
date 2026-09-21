'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check, ExternalLink, Fingerprint, Megaphone, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WarningBox } from '@/components/WarningBox'
import type { EventNetwork } from '@/contexts/EventContext'
import type { Event } from '@/types/event'
import { SectionCard } from './SectionCard'
import { createIdentity, SettingsError } from './shared'

/**
 * The gathering's own identity on the network (spec §8): its handle and DID, whether its
 * records are published, and — when minting failed at creation — a retry. The feed
 * (spec §7) posts from this same account once it ships; until then this card says so.
 */
export function FeedNetworkSection({ event, network }: { event: Event; network: EventNetwork | null }) {
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

  return <SectionCard id="feed-network" title="Feed & network" description="The gathering’s own public identity on the open social network, separate from any organizer’s account.">
    {pending && !created ? <WarningBox title="Identity not yet created" role={flaggedPending ? 'alert' : undefined}>
      <p>The gathering was saved, but its network identity could not be created. It stays a draft until it has one; nothing else is affected.</p>
      {error ? <p className="mt-2 text-destructive" role="alert">{error}</p> : null}
      <Button type="button" size="sm" className="mt-3" loading={busy} onClick={retry}>{busy ? null : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}Retry</Button>
    </WarningBox> : <div className="space-y-4">
      {created ? <p className="flex items-center gap-2 text-sm text-success"><Check className="h-4 w-4" aria-hidden="true" />Identity created: @{created}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border p-4">
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><Fingerprint className="h-3.5 w-3.5" aria-hidden="true" />Handle</p>
          <p className="mt-1 break-all font-mono text-sm">@{network?.handle ?? created}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-xs text-muted-foreground">DID</p>
          <p className="mt-1 break-all font-mono text-xs">{network?.did ?? '…'}</p>
        </div>
      </div>
      <div className="rounded-xl border bg-secondary/40 p-4 text-sm">
        {network?.publishedAt
          ? <p>Published {new Date(network.publishedAt).toLocaleString()}. Its name, dates, description and rules are public records; they update when you save changes here.</p>
          : <p>Nothing is published yet. Moving the gathering out of draft writes its public records; a draft publishes nothing and can still be deleted entirely.</p>}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button asChild><Link href={`/e/${event.slug}/admin/atproto`}>Open Feed & network page</Link></Button>
        {network?.publishedAt && profileUrl ? <Button asChild variant="outline"><a href={profileUrl} target="_blank" rel="noopener noreferrer">View on the network<ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden="true" /></a></Button> : null}
        {recordUrl ? <Button asChild variant="ghost"><a href={recordUrl} target="_blank" rel="noopener noreferrer">Inspect the record<ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden="true" /></a></Button> : null}
      </div>
    </div>}
    <div className="flex gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
      <Megaphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>Feed posting arrives in the next release. Announcements and schedule changes will be able to go out from this account, and you will choose which ones here. There is nothing to switch on yet.</p>
    </div>
  </SectionCard>
}
