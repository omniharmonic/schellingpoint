'use client'

import * as React from 'react'
import { ExternalLink, Globe, Megaphone } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button, type ButtonProps } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { WarningBox } from '@/components/WarningBox'
import { useToast } from '@/components/ui/toast'
import { apiFetch, ApiError } from '@/lib/api/client'

/**
 * "On the network" card for a session: what exists on ATProto for it, and the participant-side
 * actions the signed-in viewer may take. Every action writes into the VIEWER's own repo (proposal
 * for the author, co-host confirmation for a co-host, endorsement for anyone else, opt-in RSVP for
 * an attendee). Talks only to `/api/v1/events/[slug]/sessions/[id]/atproto` with the session cookie.
 *
 * Props (stable for package B): `sessionId`, `eventSlug`, `signedIn`, `userRsvpStatus?`.
 */

const PERMANENCE = 'This publishes under your own name on the open network. You can delete it later, but copies may already exist elsewhere.'
const LINKAGE =
  'Publishing links your existing account to this gathering, in public and for good. Confirm once to continue.'
const ENDORSEMENT_NOTE_MAX = 150

type RsvpStatus = 'going' | 'interested' | 'notgoing'

const RSVP_LABEL: Record<RsvpStatus, string> = {
  going: 'Going',
  interested: 'Interested',
  notgoing: 'Not going',
}

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

const SUCCESS: Record<Action, string> = {
  'publish-proposal': 'Proposal published to your repository',
  'withdraw-proposal': 'Proposal record withdrawn',
  'publish-cohost': 'Co-host confirmation published',
  'withdraw-cohost': 'Co-host confirmation withdrawn',
  endorse: 'Endorsement published',
  unendorse: 'Endorsement removed',
  'rsvp-public': 'Your RSVP is now public',
  'rsvp-retract': 'Your RSVP is private again',
}

function recordLink(uri: string): string {
  return `https://pdsls.dev/${uri}`
}

function shortUri(uri: string): string {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) return uri
  const did = m[1]!.length > 24 ? `${m[1]!.slice(0, 12)}…${m[1]!.slice(-6)}` : m[1]!
  return `${did}/${m[2]!.split('.').pop()}/${m[3]}`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

export function AtprotoSessionActions({ sessionId, eventSlug, signedIn, userRsvpStatus }: AtprotoSessionActionsProps) {
  const { toast } = useToast()
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
      toast({ title: SUCCESS[action], variant: 'success' })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_public_linkage') {
        setPending({ action, extra })
      } else {
        setError(e instanceof Error ? e.message : 'That did not work. Please try again.')
      }
    } finally {
      setBusy(null)
    }
  }

  // Without a configured PDS there is nothing to publish to; the page then never mentions the network.
  if (!state || state.configured === false) return null
  const viewer = state.viewer
  const hasRsvp = viewer?.hasRsvp ?? (!!userRsvpStatus && userRsvpStatus !== 'cancelled')

  const button = (
    action: Action,
    label: string,
    extra: Record<string, unknown> = {},
    variant: ButtonProps['variant'] = 'outline',
    className?: string
  ) => (
    <Button size="sm" variant={variant} className={className} disabled={busy !== null && busy !== action} loading={busy === action} onClick={() => run(action, extra)}>
      {label}
    </Button>
  )
  const withdrawClass = 'text-destructive hover:bg-destructive/10 hover:text-destructive'

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
          On the network
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="space-y-2">
          <Row label="Proposal">
            {state.proposal ? (
              <a href={recordLink(state.proposal.uri)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline">
                {state.proposal.handle ? `@${state.proposal.handle}` : shortUri(state.proposal.uri)}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : (
              <span className="text-muted-foreground">Not published by its author</span>
            )}
          </Row>
          <Row label="Schedule">
            {state.calendarEvent ? (
              <a href={recordLink(state.calendarEvent.uri)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs underline-offset-2 hover:underline">
                {shortUri(state.calendarEvent.uri)}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : (
              <span className="text-muted-foreground">Not on the published schedule</span>
            )}
          </Row>
          {state.proposal ? <Row label="Public endorsements">{state.endorsements}</Row> : null}
        </dl>

        {!signedIn ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Sign in to publish or endorse.</p>
        ) : null}

        {viewer && !viewer.canPublish && !viewer.needsLinkageConfirmation ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            You took ownership of your identity. Sign in with ATProto to publish from here.
          </p>
        ) : null}

        {viewer && (viewer.canPublish || viewer.needsLinkageConfirmation) ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{PERMANENCE}</p>
            <div className="flex flex-wrap gap-2">
              {viewer.isAuthor
                ? viewer.hasProposalRecord
                  ? <>{button('publish-proposal', 'Update my proposal', {}, 'default')}{button('withdraw-proposal', 'Withdraw my proposal', {}, 'outline', withdrawClass)}</>
                  : button('publish-proposal', 'Publish my proposal', {}, 'default')
                : null}

              {viewer.isCohost && state.proposal
                ? viewer.cohostPublished
                  ? button('withdraw-cohost', 'Stop co-hosting publicly', {}, 'outline', withdrawClass)
                  : button('publish-cohost', 'Confirm I co-host this', {}, 'default')
                : null}

              {!viewer.isAuthor && state.proposal
                ? viewer.endorsed
                  ? button('unendorse', 'Remove my endorsement', {}, 'outline')
                  : (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setShowNote((v) => !v)} aria-expanded={showNote}>
                      <Megaphone className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      Endorse publicly
                    </Button>
                  )
                : null}
            </div>

            {showNote && !viewer.endorsed ? (
              <div className="space-y-2 rounded-lg border p-3">
                <Label htmlFor={`endorse-note-${sessionId}`}>Note (optional)</Label>
                <Input
                  id={`endorse-note-${sessionId}`}
                  value={note}
                  maxLength={ENDORSEMENT_NOTE_MAX}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Why this session matters"
                  aria-describedby={`endorse-note-hint-${sessionId}`}
                />
                <p id={`endorse-note-hint-${sessionId}`} className="text-xs text-muted-foreground">
                  Shown with your endorsement. Endorsing is not voting and is never counted.
                </p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setShowNote(false); setNote('') }} disabled={busy !== null}>Cancel</Button>
                  {button('endorse', 'Publish endorsement', { note: note.trim() || null }, 'default')}
                </div>
              </div>
            ) : null}

            {hasRsvp && state.calendarEvent ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">{state.publicRsvpNotice ?? PERMANENCE}</p>
                {viewer.publicRsvp ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>Your RSVP is public: {RSVP_LABEL[viewer.publicRsvp] ?? viewer.publicRsvp}.</span>
                    {button('rsvp-retract', 'Make it private again', {}, 'outline')}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      wrapperClassName="w-auto min-w-[9rem] flex-1"
                      className="h-10"
                      value={rsvpChoice}
                      onChange={(e) => setRsvpChoice(e.target.value as RsvpStatus)}
                      aria-label="Public RSVP status"
                    >
                      {(Object.keys(RSVP_LABEL) as RsvpStatus[]).map((value) => (
                        <option key={value} value={value}>{RSVP_LABEL[value]}</option>
                      ))}
                    </Select>
                    {button('rsvp-public', 'Share my RSVP publicly', { status: rsvpChoice })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {pending ? (
          <WarningBox title="Confirm public linkage">
            <p>{LINKAGE}</p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPending(null)} disabled={busy !== null}>
                Not now
              </Button>
              <Button size="sm" loading={busy !== null} onClick={() => run(pending.action, pending.extra, true)}>
                I understand, publish
              </Button>
            </div>
          </WarningBox>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
