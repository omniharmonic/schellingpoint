'use client'

import * as React from 'react'
import Link from 'next/link'
import { ExternalLink, Globe, Loader2, Megaphone } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getAccessToken } from '@/lib/supabase/client'

/**
 * "On the network" card for a session: what exists on ATProto for it, and the
 * participant-side actions the signed-in viewer may take. Every action writes
 * into the VIEWER's own repo (proposal for the author, cohost confirmation for
 * a co-host, endorsement for anyone else, opt-in RSVP for an attendee).
 */

const PERMANENCE =
  'This writes a public record to your ATProto repository. It can be deleted, but copies may persist on the network.'

const ENDORSEMENT_NOTE_MAX = 150

type RsvpStatus = 'going' | 'interested' | 'notgoing'

interface NetworkState {
  configured?: boolean
  proposal: { uri: string; cid: string | null; did: string | null; handle: string | null } | null
  calendarEvent: { uri: string; cid: string | null } | null
  endorsements: number
  viewer?: {
    linked: boolean
    handle: string | null
    isAuthor: boolean
    isCohost: boolean
    hasProposalRecord: boolean
    endorsed: boolean
    cohostPublished: boolean
    hasRsvp: boolean
    publicRsvp: RsvpStatus | null
    publicRsvpUri: string | null
  }
}

interface MeState {
  configured?: boolean
  linked: boolean
  did?: string | null
  handle?: string | null
  publishProposals?: boolean
}

interface AtprotoSessionActionsProps {
  sessionId: string
  eventSlug: string
  /** Whether a user is signed in (drives the sign-in hint). */
  signedIn: boolean
  /** The viewer's app-side RSVP status, if any (enables the public RSVP action). */
  userRsvpStatus?: string | null
}

type Action =
  | 'publish-proposal'
  | 'withdraw-proposal'
  | 'publish-cohost'
  | 'withdraw-cohost'
  | 'endorse'
  | 'unendorse'
  | 'rsvp-public'
  | 'rsvp-retract'

function recordLink(uri: string): string {
  return `https://pdsls.dev/${uri}`
}

function shortUri(uri: string): string {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) return uri
  const did = m[1].length > 24 ? `${m[1].slice(0, 12)}…${m[1].slice(-6)}` : m[1]
  return `${did}/${m[2].split('.').pop()}/${m[3]}`
}

export function AtprotoSessionActions({ sessionId, eventSlug, signedIn, userRsvpStatus }: AtprotoSessionActionsProps) {
  const [me, setMe] = React.useState<MeState | null | undefined>(undefined)
  const [state, setState] = React.useState<NetworkState | null>(null)
  const [busy, setBusy] = React.useState<Action | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState('')
  const [showNote, setShowNote] = React.useState(false)
  const [rsvpChoice, setRsvpChoice] = React.useState<RsvpStatus>('going')

  const endpoint = `/api/v1/events/${eventSlug}/sessions/${sessionId}/atproto`

  const load = React.useCallback(async () => {
    const token = getAccessToken()
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    try {
      const [meRes, stateRes] = await Promise.all([
        signedIn && token ? fetch('/api/atproto/me', { headers }) : Promise.resolve(null),
        fetch(endpoint, { headers }),
      ])
      if (meRes) setMe(meRes.ok ? ((await meRes.json()) as MeState) : null)
      else setMe(null)
      if (stateRes.ok) setState((await stateRes.json()) as NetworkState)
    } catch (err) {
      console.error('Failed to load ATProto state:', err)
    }
  }, [endpoint, signedIn])

  React.useEffect(() => {
    load()
  }, [load])

  const run = async (action: Action, extra: Record<string, unknown> = {}) => {
    const token = getAccessToken()
    if (!token) return
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (data.error === 'link_atproto_first') setError('Link a Bluesky account in your settings first.')
        else setError(data.message || data.error || 'The network write failed')
      } else {
        setShowNote(false)
        setNote('')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The network write failed')
    } finally {
      setBusy(null)
    }
  }

  // Hide entirely when ATProto is not configured for this deployment.
  const configured = me?.configured ?? state?.configured
  if (configured === false) return null
  if (!state) return null
  const hasAnything = !!state.proposal || !!state.calendarEvent
  const viewer = state.viewer
  const linked = !!(me?.linked ?? viewer?.linked)
  // Nothing on the network and nobody who could put something there: stay quiet.
  if (!hasAnything && !viewer) return null

  const authorLabel = state.proposal?.handle ? `@${state.proposal.handle}` : state.proposal?.did ?? null
  const canEndorse = linked && viewer && !viewer.isAuthor && !!state.proposal
  const canCohost = linked && viewer && viewer.isCohost && !viewer.isAuthor && !!state.proposal
  const canRsvp = linked && viewer && !!state.calendarEvent && (viewer.hasRsvp || !!userRsvpStatus)

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" />
          On the network
        </h3>
        {state.endorsements > 0 && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Megaphone className="h-3 w-3" />
            {state.endorsements} public {state.endorsements === 1 ? 'endorsement' : 'endorsements'}
          </span>
        )}
      </div>

      <div className="space-y-2 text-sm">
        {state.proposal ? (
          <div>
            <a
              href={recordLink(state.proposal.uri)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline break-all"
            >
              Proposal record <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <p className="text-xs text-muted-foreground break-all">
              {authorLabel ? `by ${authorLabel} · ` : ''}
              {shortUri(state.proposal.uri)}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">The author has not published this proposal to ATProto.</p>
        )}
        {state.calendarEvent && (
          <div>
            <a
              href={recordLink(state.calendarEvent.uri)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline break-all"
            >
              Calendar event (published by the gathering) <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <p className="text-xs text-muted-foreground break-all">{shortUri(state.calendarEvent.uri)}</p>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-destructive/10 border border-destructive/20 p-2 text-xs text-destructive">{error}</div>
      )}

      {viewer && !linked && (
        <p className="mt-4 text-xs text-muted-foreground">
          <Link href="?settings=1" className="text-primary hover:underline">
            Link a Bluesky account
          </Link>{' '}
          to publish.
        </p>
      )}

      {viewer && linked && (
        <div className="mt-4 space-y-4">
          {viewer.isAuthor && (
            <section className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={viewer.hasProposalRecord ? 'outline' : 'default'}
                  disabled={busy !== null}
                  onClick={() => run('publish-proposal')}
                >
                  {busy === 'publish-proposal' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                  {viewer.hasProposalRecord ? 'Update record' : 'Publish to my repo'}
                </Button>
                {viewer.hasProposalRecord && (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run('withdraw-proposal')}>
                    {busy === 'withdraw-proposal' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                    Withdraw
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{PERMANENCE}</p>
            </section>
          )}

          {canCohost && (
            <section className="space-y-2">
              {viewer.cohostPublished ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('withdraw-cohost')}>
                  {busy === 'withdraw-cohost' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                  Withdraw public co-hosting
                </Button>
              ) : (
                <Button size="sm" disabled={busy !== null} onClick={() => run('publish-cohost')}>
                  {busy === 'publish-cohost' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                  Confirm co-hosting publicly
                </Button>
              )}
              <p className="text-xs text-muted-foreground">{PERMANENCE}</p>
            </section>
          )}

          {canEndorse && (
            <section className="space-y-2">
              {viewer.endorsed ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('unendorse')}>
                  {busy === 'unendorse' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                  Remove endorsement
                </Button>
              ) : showNote ? (
                <div className="space-y-2">
                  <Input
                    value={note}
                    maxLength={ENDORSEMENT_NOTE_MAX}
                    placeholder="Optional short note (public)"
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {note.length}/{ENDORSEMENT_NOTE_MAX}
                    </span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setShowNote(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" disabled={busy !== null} onClick={() => run('endorse', { note: note.trim() || null })}>
                        {busy === 'endorse' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                        Endorse publicly
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setShowNote(true)}>
                  Endorse publicly
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                A public endorsement is a signal to other people. It does not affect voting or spend any credits. {PERMANENCE}
              </p>
            </section>
          )}

          {canRsvp && (
            <section className="space-y-2">
              {viewer.publicRsvp ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">Public RSVP: {viewer.publicRsvp}</span>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('rsvp-retract')}>
                    {busy === 'rsvp-retract' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                    Retract public RSVP
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={rsvpChoice}
                    onChange={(e) => setRsvpChoice(e.target.value as RsvpStatus)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    aria-label="Public RSVP status"
                  >
                    <option value="going">Going</option>
                    <option value="interested">Interested</option>
                    <option value="notgoing">Not going</option>
                  </select>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('rsvp-public', { status: rsvpChoice })}>
                    {busy === 'rsvp-public' && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                    Share my RSVP publicly
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Your RSVP stays private unless you share it. {PERMANENCE}
              </p>
            </section>
          )}
        </div>
      )}
    </Card>
  )
}
