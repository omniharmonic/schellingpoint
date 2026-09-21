'use client'

import * as React from 'react'
import Link from 'next/link'
import { AtSign, Bell, ChevronRight, UserRound } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useEvent } from '@/contexts/EventContext'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'

interface MySettings {
  role: string
  mention_in_posts: boolean
  feed_posts: boolean
  has_handle: boolean
}

/**
 * The person's own consent to be @-mentioned in THIS gathering's feed posts (design §7.2).
 * Shown only to accounts with a handle a mention could render; explains the per-gathering scope.
 * Saved through `PATCH …/participants/me` — the person's switch and nobody else's.
 */
function FeedMentionsCard({ slug, eventName, handle }: { slug: string; eventName: string; handle: string }) {
  const [settings, setSettings] = React.useState<MySettings | null>(null)
  const [state, setState] = React.useState<'loading' | 'ready' | 'not-member' | 'error' | 'saving'>('loading')
  const [message, setMessage] = React.useState<string | null>(null)
  const path = `/api/v1/events/${encodeURIComponent(slug)}/participants/me`

  React.useEffect(() => {
    let cancelled = false
    apiFetch<MySettings>(path)
      .then((s) => { if (!cancelled) { setSettings(s); setState('ready') } })
      .catch((e) => {
        if (cancelled) return
        setState(e instanceof ApiError && (e.status === 403 || e.status === 404) ? 'not-member' : 'error')
      })
    return () => { cancelled = true }
  }, [path])

  const toggle = async (on: boolean) => {
    setState('saving'); setMessage(null)
    try {
      const saved = await apiFetch<MySettings>(path, { method: 'PATCH', json: { mention_in_posts: on } })
      setSettings(saved)
      setMessage(on ? `Posts about sessions you host here may mention @${handle}.` : 'Posts about your sessions will say “the host” from now on.')
      setState('ready')
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Your choice could not be saved. Try again.')
      setState('ready')
    }
  }

  if (state === 'not-member') return null
  const checked = settings?.mention_in_posts ?? false

  return <Card>
    <CardContent className="flex items-start gap-4 p-4 sm:p-6">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><AtSign className="h-5 w-5" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <label htmlFor="mention-in-posts" className="cursor-pointer">Feed mentions</label>
          {settings && !settings.feed_posts ? <Badge variant="muted">This gathering is not posting yet</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Let {eventName} mention <span className="font-mono">@{handle}</span> in its posts about the sessions you host. This choice is for this gathering only; other gatherings ask you separately. Off by default — until you switch it on, posts say “the host” and link to your session page instead.
        </p>
        <div className="flex items-center gap-3 pt-1">
          <Switch id="mention-in-posts" checked={checked} disabled={state !== 'ready'} onCheckedChange={(on) => void toggle(on)} aria-describedby="mention-in-posts-hint" />
          <span id="mention-in-posts-hint" className="text-sm">{checked ? 'Posts about my sessions may mention my handle' : 'Posts about my sessions say “the host”'}</span>
        </div>
        {message ? <p className="text-sm text-muted-foreground" role="status">{message}</p> : null}
        {state === 'error' ? <p className="text-sm text-destructive" role="alert">Your settings for this gathering could not be loaded.</p> : null}
        <p className="text-xs text-muted-foreground">Only you can change this. Turning it off applies to the next post; posts already made stay as they are.</p>
      </div>
    </CardContent>
  </Card>
}

/**
 * `/e/[slug]/settings`: the participant's settings for this gathering (spec §3 "Account").
 */
export default function ParticipantSettingsPage() {
  const event = useEvent()
  const { user } = useAuth()
  const base = `/e/${event.slug}`

  return <DashboardLayout>
    <div className="max-w-2xl">
      <PageHeader title="Settings" subtitle={`Your choices for ${event.name}. Your profile and identity live under Account.`} />
      <div className="space-y-4">
        <Card interactive className="group">
          <Link href={`${base}/settings/notifications`} className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CardContent className="flex items-center gap-4 p-4 sm:p-6">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bell className="h-5 w-5" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Notification preferences</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">Which updates reach you by email and in the app.</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
            </CardContent>
          </Link>
        </Card>
        <Card interactive className="group">
          <Link href={`${base}/settings?settings=1`} className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CardContent className="flex items-center gap-4 p-4 sm:p-6">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><UserRound className="h-5 w-5" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Account</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">Your profile, network identity and messaging handle.</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
            </CardContent>
          </Link>
        </Card>
        {user?.handle ? <FeedMentionsCard slug={event.slug} eventName={event.name} handle={user.handle} /> : null}
      </div>
    </div>
  </DashboardLayout>
}
