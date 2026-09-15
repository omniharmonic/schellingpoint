'use client'

import * as React from 'react'
import { ExternalLink, Globe, Loader2, Megaphone } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api/client'

/**
 * "On the network" card for a session: what exists on ATProto for it, and the participant-side
 * actions the signed-in viewer may take. Every action writes into the VIEWER's own repo (proposal
 * for the author, co-host confirmation for a co-host, endorsement for anyone else, opt-in RSVP for
 * an attendee). Talks only to `/api/v1/events/[slug]/sessions/[id]/atproto` with the session cookie.
 *
 * Props (stable for package B): `sessionId`, `eventSlug`, `signedIn`, `userRsvpStatus?`.
 */

const PERMANENCE = 'This writes a public record to your own ATProto repository. You can delete it, but copies may persist on the network.'
const LINKAGE =
  'You signed in with an existing ATProto account. Publishing links that account to this gathering, permanently and in public. Confirm once to continue.'
const ENDORSEMENT_NOTE_MAX = 150

type RsvpStatus = 'going' | 'interested' | 'notgoing'

interface NetworkState {
  configured?: boolean
  proposal: { uri: string; cid: string | null; did: string | null; handle: string | null } | null
  calendarEvent: { uri: string; cid: string | null } | null
  endorsements: number
  publicRsvpNotice?: string
  viewer?: {
    did: string | null
    handle: string | null
    door: 'custodial' | 'oauth' | null
    canPublish: boolean
    needsLinkageConfirmation: boolean
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

export interface AtprotoSessionActionsProps {
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
  const did = m[1]!.length > 24 ? `${m[1]!.slice(0, 12)}…${m[1]!.slice(-6)}` : m[1]!
  return `${did}/${m[2]!.split('.').pop()}/${m[3]}`
}

export function AtprotoSessionActions({ sessionId, eventSlug, signedIn, userRsvpStatus }: AtprotoSessionActionsProps) {
  const [state, setState] = React.useState<NetworkState | null>(null)
  const [busy, setBusy] = React.useState<Action | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState('')
  const [showNote, setShowNote] = React.useState(false)
  const [rsvpChoice, setRsvpChoice] = React.useState<RsvpStatus>('going')
  const [pending, setPending] = React.useState<{ action: Action; extra: Record<string, unknown> } | null>(null)

  const endpoint = `/api/v1/events/${encodeURIComponent(eventSlug)}/sessions/${encodeURIComponent(sessionId)}/atproto`

  const load = React.useCallback(async () => {
    try {
      setState(await apiFetch<NetworkState>(endpoint))
    } catch {
      setState(null)
    }
  }, [endpoint])

  React.useEffect(() => {
    void load()
  }, [load, signedIn])

  const run = async (action: Action, extra: Record<string, unknown> = {}, confirmPublicLinkage = false) => {
    setBusy(action)
    setError(null)
    try {
      await apiFetch(endpoint, { method: 'POST', json: { action, ...extra, ...(confirmPublicLinkage ? { confirmPublicLinkage: true } : {}) } })
      setPending(null)
      if (action === 'endorse') {
        setShowNote(false)
        setNote('')
      }
      await load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_public_linkage') {
        setPending({ action, extra })
      } else {
        setError(e instanceof Error ? e.message : 'Something went wrong')
      }
    } finally {
      setBusy(null)
    }
  }

  if (!state || state.configured === false) return null
  const viewer = state.viewer
  const hasRsvp = viewer?.hasRsvp ?? (!!userRsvpStatus && userRsvpStatus !== 'cancelled')

  const button = (action: Action, label: string, extra: Record<string, unknown> = {}, variant: 'default' | 'outline' | 'ghost' = 'outline') => (
    <Button size="sm" variant={variant} disabled={busy !== null} onClick={() => run(action, extra)}>
      {busy === action ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {label}
    </Button>
  )

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">On the network</h3>
      </div>

      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Proposal</dt>
          <dd>
            {state.proposal ? (
              <a href={recordLink(state.proposal.uri)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline">
                {state.proposal.handle ? `@${state.proposal.handle}` : shortUri(state.proposal.uri)}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : (
              <span className="text-muted-foreground">Not published by its author</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Schedule</dt>
          <dd>
            {state.calendarEvent ? (
              <a href={recordLink(state.calendarEvent.uri)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline">
                {shortUri(state.calendarEvent.uri)}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : (
              <span className="text-muted-foreground">Not on the published schedule</span>
            )}
          </dd>
        </div>
        {state.proposal ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Public endorsements</dt>
            <dd>{state.endorsements}</dd>
          </div>
        ) : null}
      </dl>

      {!signedIn ? <p className="text-xs text-muted-foreground">Sign in to publish or endorse.</p> : null}

      {viewer && !viewer.canPublish && !viewer.needsLinkageConfirmation ? (
        <p className="text-xs text-muted-foreground">You took ownership of your identity. Sign in with ATProto to publish from here.</p>
      ) : null}

      {viewer && (viewer.canPublish || viewer.needsLinkageConfirmation) ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{PERMANENCE}</p>
          <div className="flex flex-wrap gap-2">
            {viewer.isAuthor
              ? viewer.hasProposalRecord
                ? <>{button('publish-proposal', 'Update my proposal')}{button('withdraw-proposal', 'Withdraw my proposal', {}, 'ghost')}</>
                : button('publish-proposal', 'Publish my proposal', {}, 'default')
              : null}

            {viewer.isCohost && state.proposal
              ? viewer.cohostPublished
                ? button('withdraw-cohost', 'Stop co-hosting publicly', {}, 'ghost')
                : button('publish-cohost', 'Confirm I co-host this', {}, 'default')
              : null}

            {!viewer.isAuthor && state.proposal
              ? viewer.endorsed
                ? button('unendorse', 'Remove my endorsement', {}, 'ghost')
                : (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setShowNote((v) => !v)}>
                    <Megaphone className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Endorse publicly
                  </Button>
                )
              : null}
          </div>

          {showNote && !viewer.endorsed ? (
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground" htmlFor={`endorse-note-${sessionId}`}>
                An optional note, shown with your endorsement. Endorsing is not voting and is never counted.
              </label>
              <Input
                id={`endorse-note-${sessionId}`}
                value={note}
                maxLength={ENDORSEMENT_NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why this session matters (optional)"
              />
              {button('endorse', 'Publish endorsement', { note: note.trim() || null }, 'default')}
            </div>
          ) : null}

          {hasRsvp && state.calendarEvent ? (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">{state.publicRsvpNotice ?? PERMANENCE}</p>
              {viewer.publicRsvp ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Your RSVP is public ({viewer.publicRsvp}).</span>
                  {button('rsvp-retract', 'Make it private again', {}, 'ghost')}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={rsvpChoice}
                    onChange={(e) => setRsvpChoice(e.target.value as RsvpStatus)}
                    aria-label="Public RSVP status"
                  >
                    <option value="going">Going</option>
                    <option value="interested">Interested</option>
                    <option value="notgoing">Not going</option>
                  </select>
                  {button('rsvp-public', 'Share my RSVP publicly', { status: rsvpChoice })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
          <p>{LINKAGE}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={() => run(pending.action, pending.extra, true)}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              I understand, publish
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Not now
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Card>
  )
}
