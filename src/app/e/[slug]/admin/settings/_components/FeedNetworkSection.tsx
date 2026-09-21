'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check, ExternalLink, Fingerprint, Megaphone, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { WarningBox } from '@/components/WarningBox'
import type { EventNetwork } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, Field, Toggle } from './SectionCard'
import { createIdentity, SettingsError, useSectionSave } from './shared'

/** What the gathering account posts when the feed is on (design §7.3) — the plain-language list. */
const WHAT_GETS_POSTED: Array<{ when: string; what: string }> = [
  { when: 'The gathering is first published', what: 'its name, dates, place (the location name only, never an address) and a link.' },
  { when: 'Proposals open · Voting opens', what: 'one line each, with a link.' },
  { when: 'The schedule is published', what: '“The schedule is out: N sessions across M rooms”, with a link.' },
  { when: 'A session first appears on the published schedule', what: 'its title, day and time, room, and “hosted by the host” — or “hosted by @handle” only when that host switched on “mention me” in their own settings for this gathering.' },
  { when: 'A published session is moved or cancelled (after organizer approvals)', what: 'a new post saying so, with a link. Nothing is edited or deleted.' },
]

const NEVER_POSTED = 'Never posted: names organizers typed for hosts, exact addresses or meeting links, vote counts, attendee lists, anything from a private or draft gathering.'

interface FeedStatus {
  enabled: boolean
  digestThreshold: number
  blocked: string | null
  counts: { queued: number; posted: number; failed: number }
}

const THRESHOLDS = [3, 5, 10, 15, 20, 25, 50]

/**
 * The gathering's own identity on the network (spec §8) and its feed (design §7): the handle and
 * DID, whether its records are published, the "post activity" switch with the list of what gets
 * posted, the digest threshold, and — when minting failed at creation — a retry.
 */
export function FeedNetworkSection({ event, network }: { event: Event; network: EventNetwork | null }) {
  const router = useRouter()
  const search = useSearchParams()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<string | null>(null)
  const pending = !network?.did
  const flaggedPending = search?.get('identity') === 'pending'

  const { state, save } = useSectionSave(event.id)
  const [feed, setFeed] = React.useState<FeedStatus | null>(null)
  const [feedError, setFeedError] = React.useState<string | null>(null)
  const [enabled, setEnabled] = React.useState(false)
  const [threshold, setThreshold] = React.useState(10)

  const loadFeed = React.useCallback(async () => {
    try {
      const status = await apiFetch<FeedStatus>(`/api/v1/events/${encodeURIComponent(event.slug)}/feed`)
      setFeed(status)
      setEnabled(status.enabled)
      setThreshold(status.digestThreshold)
      setFeedError(null)
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : 'The feed status could not be loaded.')
    }
  }, [event.slug])

  React.useEffect(() => { void loadFeed() }, [loadFeed])

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

  const dirty = !!feed && (enabled !== feed.enabled || threshold !== feed.digestThreshold)
  const thresholdOptions = THRESHOLDS.includes(threshold) ? THRESHOLDS : [...THRESHOLDS, threshold].sort((a, b) => a - b)
  const profileUrl = network?.handle ? `https://bsky.app/profile/${encodeURIComponent(network.handle)}` : null
  const recordUrl = network?.gatheringUri?.startsWith('at://') ? `https://pdsls.dev/${network.gatheringUri}` : null
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)

  return <SectionCard id="feed-network" title="Feed & network" description="The gathering’s own public identity on the open social network, separate from any organizer’s account."
    onSubmit={async () => {
      const result = await save({ feed_posts: enabled, feed_digest_threshold: threshold }, enabled ? 'Feed posting is on.' : 'Feed posting is off.')
      if (result) await loadFeed()
    }}
    footer={<SaveBar state={state} dirty={dirty} />}>
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
        <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/atproto`}>Open Feed & network page</Link></Button>
        {network?.publishedAt && profileUrl ? <Button asChild variant="outline"><a href={profileUrl} target="_blank" rel="noopener noreferrer">View on the network<ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden="true" /></a></Button> : null}
        {recordUrl ? <Button asChild variant="ghost"><a href={recordUrl} target="_blank" rel="noopener noreferrer">Inspect the record<ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden="true" /></a></Button> : null}
      </div>
    </div>}

    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Feed</p>
          <p className="text-sm text-muted-foreground">When on, the gathering’s account posts about its own activity so anyone on Bluesky can follow it. Off by default. Posts are written by the gathering, never by an organizer’s account, and every one is in the audit trail.</p>
        </div>
      </div>
      {feedError ? <p className="text-sm text-destructive" role="alert">{feedError}</p> : null}
      <Toggle id="feed-posts" checked={enabled} onChange={setEnabled} label="Post activity to the gathering’s feed"
        description={feed?.blocked && feed.enabled ? `On, but nothing is posted right now: ${feed.blocked}.` : 'Only a public gathering that is out of draft posts anything.'} />
      {fieldError('feed_posts') ? <p className="text-sm text-destructive" role="alert">{fieldError('feed_posts')}</p> : null}
      <Field label="Fold session posts into one digest above" htmlFor="feed-digest-threshold" error={fieldError('feed_digest_threshold')}
        hint={`When one schedule publish adds more than ${threshold} sessions, one post says how many were added instead of one post per session.`}>
        <Select id="feed-digest-threshold" value={threshold} onChange={e => setThreshold(parseInt(e.target.value, 10))} wrapperClassName="max-w-[220px]" error={!!fieldError('feed_digest_threshold')}>
          {thresholdOptions.map(n => <option key={n} value={n}>{n} sessions</option>)}
        </Select>
      </Field>
      <div className="text-sm">
        <p className="font-medium">What gets posted</p>
        <dl className="mt-2 grid gap-2">
          {WHAT_GETS_POSTED.map((row) => (
            <div key={row.when}><dt className="text-foreground">{row.when}</dt><dd className="text-muted-foreground">{row.what}</dd></div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">{NEVER_POSTED}</p>
        <p className="mt-2 text-xs text-muted-foreground">Hosts are mentioned by handle only when they switch that on themselves, per gathering, under Settings → Feed mentions. Otherwise posts say “the host”.</p>
      </div>
      {feed ? <p className="text-xs text-muted-foreground">
        {feed.counts.posted} posted · {feed.counts.queued} queued · {feed.counts.failed} failed. See and retry them on the <Link className="underline" href={`/e/${event.slug}/admin/atproto#feed`}>Feed & network page</Link>.
      </p> : null}
    </div>
  </SectionCard>
}
