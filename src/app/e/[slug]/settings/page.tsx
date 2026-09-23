'use client'

import * as React from 'react'
import Link from 'next/link'
import { AtSign, Bell, ChevronRight, DoorOpen, ScrollText, UserRound } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useEvent, useEventRole } from '@/contexts/EventContext'
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
 * "Leave this gathering" (spec §8 "Leaving and ending").
 *
 * The other half of Join, which until now was a one-way door. The confirm spells out what
 * actually happens, because the two surprising parts are worth saying out loud: RSVPs are
 * cancelled (the seat goes back to the room), and proposals stay, because a proposal is the
 * proposer's own record in their own repo and this gathering has no authority over it.
 *
 * The last owner is not offered the door at all — a gathering with no owner cannot be
 * administered, and the fix is to hand it over first.
 */
function LeaveGatheringCard({ eventName }: { eventName: string }) {
  const { isMember, canLeave, leave, isLeaving, isOwner } = useEventRole()
  const [confirming, setConfirming] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  if (!isMember) return null

  const onLeave = async () => {
    setMessage(null)
    const result = await leave()
    setConfirming(false)
    if (!result.ok) setMessage(result.message)
  }

  return <Card>
    <CardContent className="flex items-start gap-4 p-4 sm:p-6">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive"><DoorOpen className="h-5 w-5" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">Leave this gathering</p>
        <p className="text-sm text-muted-foreground">
          You stop being a member of {eventName}: you leave the roster, your RSVPs are cancelled and the seats go back to the rooms, and any co-host invitations you sent that nobody has accepted are withdrawn. Sessions you proposed stay where they are — they are your records, written in your own repository, and this gathering cannot take them down. You can join again later if it is open to you.
        </p>
        {canLeave === false ? (
          <p className="text-sm text-muted-foreground">
            {isOwner
              ? 'You are the only owner of this gathering. Make someone else an owner from Members, then you can leave.'
              : 'You cannot leave this gathering right now.'}
          </p>
        ) : confirming ? (
          <ConfirmInline
            message={`Leave ${eventName}? Your RSVPs are cancelled. Your proposals stay.`}
            confirmLabel="Leave"
            destructive
            loading={isLeaving}
            onConfirm={() => void onLeave()}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <Button type="button" variant="outline" className="text-destructive" onClick={() => setConfirming(true)} disabled={canLeave === null}>
            Leave this gathering
          </Button>
        )}
        {message ? <p className="text-sm text-destructive" role="alert">{message}</p> : null}
      </div>
    </CardContent>
  </Card>
}

/** The gathering's own code of conduct, and when this member accepted it (MT §12.19). */
function CodeOfConductCard() {
  const { codeOfConductUrl, conductAcceptedAt } = useEventRole()
  if (!codeOfConductUrl) return null
  return <Card>
    <CardContent className="flex items-start gap-4 p-4 sm:p-6">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ScrollText className="h-5 w-5" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">Code of conduct</p>
        <p className="text-sm text-muted-foreground">
          <a href={codeOfConductUrl} target="_blank" rel="noopener noreferrer" className="underline">Read this gathering’s code of conduct</a>
          {conductAcceptedAt ? ` · you accepted it on ${new Date(conductAcceptedAt).toLocaleDateString()}.` : '.'}
        </p>
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
        <CodeOfConductCard />
        <LeaveGatheringCard eventName={event.name} />
      </div>
    </div>
  </DashboardLayout>
}
