'use client'

/**
 * Session mergers (PRD §4.4) as the two proposers experience them.
 *
 * Two proposers who find they are running the same conversation can fold one into the other.
 * The offer comes from the session whose proposer is giving theirs up; the other proposer
 * answers. Nothing is done to anyone's record: the source proposal stays in its author's repo
 * exactly as written, and the schedule is only ever published for the target.
 *
 * The one sentence about votes is `MERGE_VOTE_COPY`, and it is the truth rather than the
 * PRD's: combining is all we can honestly do, because after a round closes the link between a
 * person and their votes is gone (spec §5.4a).
 */
import * as React from 'react'
import Link from 'next/link'
import { GitMerge, Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/toast'
import { apiFetch, ApiError } from '@/lib/api/client'
import { MERGE_REQUEST_STATUS, MERGE_VOTE_COPY, type MergeRequestStatus } from '@/lib/labels'

export interface MergeRequestView {
  id: string
  status: MergeRequestStatus
  message: string | null
  declineReason: string | null
  createdAt: string
  decidedAt: string | null
  source: { id: string; title: string }
  target: { id: string; title: string }
  viewer: { isRequester: boolean; canDecide: boolean }
}

interface MergeCandidate {
  id: string
  title: string
  unclaimed: boolean
  merged_into: { id: string; title: string } | null
}

interface Props {
  eventSlug: string
  sessionId: string
  sessionTitle: string
  /** The viewer proposed this session (only a proposer may offer a merger). */
  isHost: boolean
  /** Hosts, co-hosts and organizers may read the offers. */
  canRead: boolean
  /** This session was itself folded into another one. */
  mergedInto: { id: string; title: string } | null
}

export function SessionMerge({ eventSlug, sessionId, sessionTitle, isHost, canRead, mergedInto }: Props) {
  const { toast } = useToast()
  const base = `/api/v1/sessions/${sessionId}/merge`
  const [requests, setRequests] = React.useState<MergeRequestView[]>([])
  const [candidates, setCandidates] = React.useState<MergeCandidate[]>([])
  const [offering, setOffering] = React.useState(false)
  const [target, setTarget] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!canRead) return
    try {
      const res = await apiFetch<{ requests: MergeRequestView[] }>(base, { cache: 'no-store' })
      setRequests(res.requests)
    } catch {
      setRequests([])
    }
  }, [base, canRead])

  React.useEffect(() => { void load() }, [load])

  const loadCandidates = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ sessions: MergeCandidate[] }>(
        `/api/v1/events/${encodeURIComponent(eventSlug)}/sessions?status=pending,approved,scheduled`,
        { cache: 'no-store' },
      )
      setCandidates(res.sessions.filter((s) => s.id !== sessionId && !s.unclaimed && !s.merged_into))
    } catch {
      setCandidates([])
    }
  }, [eventSlug, sessionId])

  const pending = requests.filter((r) => r.status === 'pending')
  const mine = pending.find((r) => r.source.id === sessionId)
  const incoming = pending.filter((r) => r.target.id === sessionId)
  const history = requests.filter((r) => r.status !== 'pending')

  if (!canRead && !mergedInto) return null

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      toast({ title: done, variant: 'success' })
      setOffering(false)
      setMessage('')
      setTarget('')
      await load()
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'That did not work. Please try again.'
      setError(text)
    } finally {
      setBusy(null)
    }
  }

  /** The merger currently in force that folded THIS session into another. */
  const inForce = requests.find((r) => r.status === 'accepted' && r.source.id === sessionId)

  const decide = (request: MergeRequestView, action: 'accept' | 'decline' | 'withdraw' | 'unmerge') =>
    act(
      `${action}-${request.id}`,
      () => apiFetch(`/api/v1/sessions/${request.source.id}/merge`, { method: 'PATCH', json: { request_id: request.id, action } }),
      action === 'accept' ? 'Merged' : action === 'decline' ? 'Offer declined' : action === 'unmerge' ? 'Merger undone' : 'Offer withdrawn',
    )

  return (
    <Card data-testid="session-merge">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitMerge className="h-4 w-4" aria-hidden />
          Merging
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {mergedInto && (
          <div className="rounded-xl border bg-muted/40 p-3 text-sm">
            <Badge variant={MERGE_REQUEST_STATUS.accepted.badge} className="mb-1.5">{MERGE_REQUEST_STATUS.accepted.label}</Badge>
            <p>
              This proposal is now part of{' '}
              <Link href={`/e/${eventSlug}/sessions/${mergedInto.id}`} className="font-medium underline">{mergedInto.title}</Link>.
              It no longer appears in the session lists and takes no new votes. Your proposal record is untouched in your own
              repository — only you can withdraw it.
            </p>
            {inForce && (isHost || inForce.viewer.isRequester) && (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                loading={busy === `unmerge-${inForce.id}`}
                onClick={() => void decide(inForce, 'unmerge')}
              >
                Undo this merger
              </Button>
            )}
          </div>
        )}

        {incoming.map((r) => (
          <div key={r.id} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="merge-incoming">
            <p>
              The proposer of <span className="font-medium">“{r.source.title}”</span> offers to fold it into
              {' '}<span className="font-medium">“{r.target.title}”</span>.
            </p>
            {r.message && <p className="italic text-muted-foreground">“{r.message}”</p>}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {MERGE_VOTE_COPY} Their co-hosts do not come across; invite them yourself if you want them on stage.
            </p>
            {r.viewer.canDecide && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={busy === `accept-${r.id}`} onClick={() => void decide(r, 'accept')}>Accept</Button>
                <Button size="sm" variant="outline" loading={busy === `decline-${r.id}`} onClick={() => void decide(r, 'decline')}>Decline</Button>
              </div>
            )}
          </div>
        ))}

        {mine && (
          <div className="space-y-2 rounded-xl border p-3 text-sm" data-testid="merge-outgoing">
            <Badge variant={MERGE_REQUEST_STATUS.pending.badge}>{MERGE_REQUEST_STATUS.pending.label}</Badge>
            <p>
              You offered to fold this session into <span className="font-medium">“{mine.target.title}”</span>.
              Their proposer decides.
            </p>
            {mine.viewer.isRequester && (
              <Button size="sm" variant="outline" loading={busy === `withdraw-${mine.id}`} onClick={() => void decide(mine, 'withdraw')}>
                Withdraw the offer
              </Button>
            )}
          </div>
        )}

        {isHost && !mergedInto && !mine && (
          offering ? (
            <div className="space-y-3 rounded-xl border p-3">
              <div className="space-y-1.5">
                <Label htmlFor="merge-target">Fold “{sessionTitle}” into…</Label>
                <Select id="merge-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a session</option>
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="merge-message">Why merge? (the other proposer sees this)</Label>
                <Textarea id="merge-message" rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="We cover very similar ground…" />
              </div>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                If they accept, this session leaves the lists and stops taking votes. {MERGE_VOTE_COPY} The proposal
                stays yours, and only you can withdraw it.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!target}
                  loading={busy === 'offer'}
                  onClick={() => void act('offer', () => apiFetch(base, { method: 'POST', json: { target_session_id: target, message: message.trim() || null } }), 'Offer sent')}
                >
                  Send the offer
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOffering(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { setOffering(true); void loadCandidates() }}>
              Offer to merge into another session
            </Button>
          )
        )}

        {history.length > 0 && (
          <ul className="space-y-1 border-t pt-3">
            {history.map((r) => (
              <li key={r.id} className="text-xs text-muted-foreground">
                <Badge variant={MERGE_REQUEST_STATUS[r.status].badge} className="mr-1.5">{MERGE_REQUEST_STATUS[r.status].label}</Badge>
                “{r.source.title}” → “{r.target.title}”
                {r.declineReason ? ` · ${r.declineReason}` : ''}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  )
}
