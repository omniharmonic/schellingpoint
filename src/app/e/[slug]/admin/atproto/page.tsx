'use client'

/**
 * Organizer view of the gathering on the network: its identity and credential health (the banner
 * a revoked credential raises), publishing, destructive-action approvals, sessions that need review
 * (cid drift, withdrawn proposals), peers and listings, and the audit trail.
 * Everything goes through `/api/v1/events/[slug]/admin/atproto` and `/approvals` with the session cookie.
 */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, AlertTriangle, ExternalLink, Loader2, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { WarningBox } from '@/components/WarningBox'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { PublishJobProgress } from '@/components/PublishJobProgress'

interface AuditRow {
  id: string
  action: string
  collection: string | null
  uri: string | null
  decision: 'allow' | 'deny'
  reason: string
  created_at: string
}

type HealthState = 'unlinked' | 'ok' | 'failing' | 'disabled'

interface Status {
  configured: boolean
  linked: boolean
  actorDid: string | null
  actorHandle: string | null
  credentialKind: 'oauth' | 'app-password' | null
  health: { state: HealthState; lastOkAt: string | null; lastErrorAt: string | null; banner: string | null }
  gatheringUri: string | null
  publishedAt: string | null
  tags: string[]
  policy: { destructiveActionStewards: number; feedbackK: number; publishRoles: boolean }
  counts: {
    venues: { total: number; published: number }
    tracks: { total: number; published: number }
    sessionsScheduled: number
    sessionsPublished: number
    sessionsCancelled: number
    approvalsPending: number
  }
  flagged: Array<{ id: string; title: string; kind: 'cid-drift' | 'withdrawn' | 'author-inactive' | 'location-changed'; since: string; proposalUri: string | null }>
  peers: Array<{ peer_did: string; label: string | null; cross_listing_enabled: boolean; created_at: string }>
  listings: Array<{ id: string; session_id: string | null; subject_uri: string; record_uri: string | null; origin: 'own' | 'peer'; status: 'listed' | 'removed'; tags: string[]; updated_at: string }>
  recentAudit: AuditRow[]
  links: { pdsls: string } | null
}

interface PublishResult {
  kind: string
  id: string
  uri?: string
  error?: string
  skipped?: string
}

interface ApprovalRequest {
  id: string
  action: 'move' | 'cancel' | 'remove-listing'
  status: string
  reason: string
  threshold: number
  sessionId: string | null
  sessionTitle: string | null
  target: { startsAt?: string | null }
  requestedBy: { accountId: string; handle: string | null } | null
  approvals: Array<{ accountId: string; handle: string | null; recordUri: string; createdAt: string }>
  error: string | null
  createdAt: string
}

type What = 'gathering' | 'venues' | 'tracks' | 'grids' | 'schedule' | 'all'

const PUBLISH_BUTTONS: Array<{ what: What; label: string; hint: string }> = [
  { what: 'gathering', label: 'Gathering', hint: 'Policy, calendar event, gathering record' },
  { what: 'venues', label: 'Venues', hint: 'One record per space' },
  { what: 'tracks', label: 'Tracks', hint: 'One record per track' },
  { what: 'grids', label: 'Slot grids', hint: 'The time slots per venue and day' },
  { what: 'schedule', label: 'Schedule', hint: 'Every scheduled session: event, config, slot' },
  { what: 'all', label: 'Everything', hint: 'All of the above, in order' },
]

const PUBLIC_RECORDS: Array<{ record: string; what: string }> = [
  { record: 'Gathering', what: 'Name, description, dates, region, phase, website, routing tags, peer gatherings, and a link to the policy.' },
  { record: 'Policy', what: 'Voting method, credits, proposal rules and the approval and privacy thresholds, in plain text.' },
  { record: 'Venues', what: 'Name, capacity, features and address. A private residence shows only its locality.' },
  { record: 'Tracks', what: 'Name, description, color, order and shared-taxonomy skills. Track leads are never published.' },
  { record: 'Scheduled sessions', what: 'A calendar event per session plus a slot record pointing at the proposal it came from.' },
  { record: 'Stub proposals', what: 'Only for sessions whose author has no proposal of their own: content only, marked imported, naming no one.' },
  { record: 'Listings', what: 'Sessions whose tags match the gathering’s routing tags, and events of peers you enabled.' },
  { record: 'Tally', what: 'After voting closes: counts per session, with sessions under the privacy threshold suppressed. Never who voted.' },
  { record: 'Feed posts', what: 'Only when the feed is on: short posts about the gathering being published, proposals and voting opening, the schedule, and sessions scheduled, moved or cancelled — title, day, time, room, a link. A host is named by handle only after they opt in themselves; otherwise “the host”.' },
]

interface FeedPostRow {
  id: string
  kind: string
  label: string
  status: 'queued' | 'posted' | 'failed' | 'digested' | 'deleted'
  text: string
  bskyUrl: string | null
  mentions: Array<{ did: string; handle: string }>
  error: string | null
  createdAt: string
  postedAt: string | null
}

interface FeedStatus {
  enabled: boolean
  digestThreshold: number
  blocked: string | null
  actorHandle: string | null
  counts: { queued: number; posted: number; failed: number }
  posts: FeedPostRow[]
}

const FEED_STATUS_LABEL: Record<FeedPostRow['status'], { label: string; badge: 'success' | 'amber' | 'destructive' | 'muted' | 'secondary' }> = {
  posted: { label: 'Posted', badge: 'success' },
  queued: { label: 'Queued', badge: 'amber' },
  failed: { label: 'Failed', badge: 'destructive' },
  digested: { label: 'In a digest', badge: 'muted' },
  deleted: { label: 'Deleted', badge: 'secondary' },
}

// Machine values → organizer words (audit §3: never show "ok" / "allow" raw).
const HEALTH_LABEL: Record<HealthState, { label: string; badge: 'success' | 'amber' | 'destructive' | 'muted' }> = {
  ok: { label: 'Healthy', badge: 'success' },
  failing: { label: 'Failing', badge: 'amber' },
  disabled: { label: 'Disabled', badge: 'destructive' },
  unlinked: { label: 'Not connected', badge: 'muted' },
}
const DECISION_LABEL: Record<AuditRow['decision'], { label: string; badge: 'secondary' | 'destructive' }> = {
  allow: { label: 'Allowed', badge: 'secondary' },
  deny: { label: 'Denied', badge: 'destructive' },
}
const REQUEST_ACTION: Record<ApprovalRequest['action'], string> = { move: 'Move', cancel: 'Cancel', 'remove-listing': 'Remove listing' }
const REQUEST_STATUS: Record<string, string> = { pending: 'Pending', applying: 'Applying', applied: 'Applied', withdrawn: 'Withdrawn', failed: 'Failed' }
const FLAG_LABEL: Record<Status['flagged'][number]['kind'], { label: string; badge: 'amber' | 'destructive' | 'muted' }> = {
  'cid-drift': { label: 'Edited', badge: 'amber' },
  withdrawn: { label: 'Withdrawn', badge: 'destructive' },
  'author-inactive': { label: 'Proposer inactive', badge: 'muted' },
  'location-changed': { label: 'Location changed — re-publish', badge: 'amber' },
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function short(value: string | null | undefined, keep = 14): string {
  if (!value) return ''
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value
}

/** Inline "give a reason" form for requests that other organizers must approve (replaces window.prompt). */
function ReasonForm({ id, prompt, confirmLabel, busy, onSubmit, onCancel }: { id: string; prompt: string; confirmLabel: string; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = React.useState('')
  const ref = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => { ref.current?.focus() }, [])
  return (
    <form
      className="w-full space-y-2 rounded-xl border bg-muted p-3"
      onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSubmit(reason.trim()) }}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
    >
      <Label htmlFor={id}>{prompt}</Label>
      <Textarea ref={ref} id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
      <p className="text-xs text-muted-foreground">Recorded with every approval.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" variant="destructive" loading={busy} disabled={!reason.trim()}>{confirmLabel}</Button>
      </div>
    </form>
  )
}

export default function AdminAtprotoPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { role, isAdmin, isOwner, isLoading: roleLoading } = useEventRole()
  const { toast } = useToast()
  const allowed = isAdmin || role === 'moderator'
  const canManage = isAdmin

  const [status, setStatus] = React.useState<Status | null>(null)
  const [approvals, setApprovals] = React.useState<{ threshold: number; viewerAccountId: string; requests: ApprovalRequest[] } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [results, setResults] = React.useState<{ what: What; published: number; skipped: number; failed: number; results: PublishResult[]; jobId?: string } | null>(null)
  const [confirmLinkage, setConfirmLinkage] = React.useState<null | (() => Promise<void>)>(null)
  const [reasonFor, setReasonFor] = React.useState<{ kind: 'cancel' | 'unlist'; id: string } | null>(null)

  const [oauthHandle, setOauthHandle] = React.useState('')
  const [handle, setHandle] = React.useState('')
  const [appPassword, setAppPassword] = React.useState('')
  const [peerDid, setPeerDid] = React.useState('')
  const [peerLabel, setPeerLabel] = React.useState('')
  const [unlinkConfirm, setUnlinkConfirm] = React.useState(false)
  const [feed, setFeed] = React.useState<FeedStatus | null>(null)

  const apiBase = `/api/v1/events/${encodeURIComponent(event.slug)}/admin/atproto`
  const approvalsBase = `/api/v1/events/${encodeURIComponent(event.slug)}/approvals`
  const feedBase = `/api/v1/events/${encodeURIComponent(event.slug)}/feed`

  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !allowed)) router.push(`/e/${event.slug}/sessions`)
  }, [user, allowed, authLoading, roleLoading, router, event.slug])

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await apiFetch<Status>(apiBase))
      if (canManage) setApprovals(await apiFetch(approvalsBase))
      if (canManage) setFeed(await apiFetch<FeedStatus>(feedBase).catch(() => null))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network status could not be loaded.')
    }
  }, [apiBase, approvalsBase, feedBase, canManage])

  React.useEffect(() => {
    if (authLoading || roleLoading || !user || !allowed) return
    void refresh()
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('linked') === '1') {
      toast({ title: 'Gathering account connected', variant: 'success' })
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [authLoading, roleLoading, user, allowed, refresh, toast])

  /** Run an action; a `confirm_public_linkage` answer asks once and retries with the confirmation. */
  const act = async (key: string, fn: (confirm: boolean) => Promise<unknown>, success?: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn(false)
      if (success) toast({ title: success, variant: 'success' })
      await refresh()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_public_linkage') {
        setConfirmLinkage(() => async () => {
          setConfirmLinkage(null)
          await act(key, () => fn(true), success)
        })
      } else {
        setError(e instanceof Error ? e.message : 'Something went wrong.')
      }
    } finally {
      setBusy(null)
    }
  }

  const post = (json: Record<string, unknown>) => apiFetch<Status>(apiBase, { method: 'POST', json })

  const publish = (what: What) =>
    act(`publish:${what}`, async () => {
      const out = await apiFetch<{ what: What; published: number; skipped: number; failed: number; results: PublishResult[]; jobId?: string }>(`${apiBase}/publish`, { method: 'POST', json: { what } })
      setResults(out)
    })

  const startOAuth = async () => {
    const h = oauthHandle.trim().replace(/^@/, '')
    if (!h) return setError('Enter the handle of the gathering account.')
    const next = `/e/${event.slug}/admin/atproto?linked=1`
    window.location.assign(`/api/atproto/auth/start?handle=${encodeURIComponent(h)}&purpose=gathering&event=${encodeURIComponent(event.id)}&next=${encodeURIComponent(next)}`)
  }

  const requestCancel = (sessionId: string, reason: string) => {
    setReasonFor(null)
    void act(`cancel:${sessionId}`, (confirm) => apiFetch(approvalsBase, { method: 'POST', json: { action: 'request-cancel', sessionId, reason, ...(confirm ? { confirmPublicLinkage: true } : {}) } }), 'Cancellation requested.')
  }
  const requestUnlist = (listingId: string, reason: string) => {
    setReasonFor(null)
    void act(`unlist:${listingId}`, (confirm) => apiFetch(approvalsBase, { method: 'POST', json: { action: 'request-listing-removal', listingId, reason, ...(confirm ? { confirmPublicLinkage: true } : {}) } }), 'Removal requested.')
  }

  if (authLoading || roleLoading || !status) {
    return (
      <>
        <PageHeader title="Network" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          {error ? <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {error ?? 'Loading network status…'}
        </div>
      </>
    )
  }

  const pendingRequests = approvals?.requests.filter((r) => r.status === 'pending' || r.status === 'applying') ?? []
  const recentRequests = approvals?.requests.filter((r) => r.status !== 'pending' && r.status !== 'applying').slice(0, 10) ?? []
  const health = HEALTH_LABEL[status.health.state]

  return (
    <div>
      <PageHeader
        title="Network"
        subtitle="What this gathering publishes to ATProto, and the changes that need more than one organizer."
      />

      <div className="space-y-6">
        {status.health.banner ? (
          status.health.state === 'disabled' ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription className="space-y-2">
                <p>{status.health.banner}</p>
                {canManage ? (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('reset', () => post({ action: 'reset-credential' }), 'Credential re-enabled. The next publish will try again.')}>
                    I reconnected it — try again
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : (
            <WarningBox role="alert">{status.health.banner}</WarningBox>
          )
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {confirmLinkage ? (
          <WarningBox title="This links your account to the gathering">
            <p>Approving writes a public record in your own ATProto repository that permanently links your account to organizing this gathering.</p>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmLinkage(null)}>Cancel</Button>
              <Button size="sm" onClick={() => void confirmLinkage()}>I understand, continue</Button>
            </div>
          </WarningBox>
        ) : null}

        {/* ───────────── identity ───────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Gathering identity</CardTitle>
            <CardDescription>A DID of its own on a neutral PDS. Every record the gathering writes is audited below.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!status.configured ? <p className="text-muted-foreground">ATProto is not configured on this deployment.</p> : null}
            {status.linked ? (
              <dl className="grid gap-2 sm:grid-cols-2">
                <div><dt className="text-xs uppercase text-muted-foreground">Handle</dt><dd className="font-mono">{status.actorHandle ? `@${status.actorHandle}` : '—'}</dd></div>
                <div><dt className="text-xs uppercase text-muted-foreground">DID</dt><dd className="font-mono" title={status.actorDid ?? ''}>{short(status.actorDid)}</dd></div>
                <div><dt className="text-xs uppercase text-muted-foreground">Credential</dt><dd className="flex flex-wrap items-center gap-2">{status.credentialKind === 'app-password' ? 'Custodied by this app' : 'OAuth session'} <Badge variant={health.badge}>{health.label}</Badge></dd></div>
                <div><dt className="text-xs uppercase text-muted-foreground">Gathering record</dt><dd>{status.gatheringUri ? `Published ${when(status.publishedAt)}` : 'Not yet published'}</dd></div>
                {status.links ? (
                  <div className="sm:col-span-2">
                    <a className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={status.links.pdsls} target="_blank" rel="noreferrer">
                      Browse the repository <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                ) : null}
              </dl>
            ) : canManage ? (
              <div className="space-y-4">
                <Button disabled={!status.configured} loading={busy === 'mint'} onClick={() => act('mint', () => post({ action: 'mint' }), 'Gathering identity created.')}>
                  Create the gathering’s identity
                </Button>
                {isOwner ? (
                  <details className="space-y-3">
                    <summary className="cursor-pointer text-muted-foreground">Or act as an account the gathering already has</summary>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Input className="max-w-xs" placeholder="gathering.bsky.social" value={oauthHandle} onChange={(e) => setOauthHandle(e.target.value)} aria-label="Handle to connect with ATProto sign-in" />
                      <Button variant="outline" onClick={startOAuth}>Connect with ATProto sign-in</Button>
                    </div>
                    <form
                      className="flex flex-wrap gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void act('link', async () => {
                          await post({ action: 'link', handle, appPassword })
                          setAppPassword('')
                        }, 'Gathering account connected.')
                      }}
                    >
                      <Input className="max-w-xs" placeholder="handle" value={handle} onChange={(e) => setHandle(e.target.value)} aria-label="Handle" />
                      <Input className="max-w-xs" type="password" placeholder="app password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} aria-label="App password" autoComplete="off" />
                      <Button type="submit" variant="outline" loading={busy === 'link'} disabled={busy !== null && busy !== 'link'}>Connect with an app password</Button>
                    </form>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">No network identity yet. An owner or admin can create one.</p>
            )}
            {status.linked && isOwner ? (
              unlinkConfirm ? (
                <ConfirmInline
                  layout="inline"
                  destructive
                  message="Disconnect the gathering account? Records already published stay on the network."
                  confirmLabel="Disconnect"
                  loading={busy === 'unlink'}
                  onConfirm={() => void act('unlink', async () => { await apiFetch(apiBase, { method: 'DELETE' }); setUnlinkConfirm(false) }, 'Disconnected.')}
                  onCancel={() => setUnlinkConfirm(false)}
                />
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setUnlinkConfirm(true)}><Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Disconnect</Button>
              )
            ) : null}
          </CardContent>
        </Card>

        {/* ───────────── publish ───────────── */}
        {status.linked && canManage ? (
          <Card>
            <CardHeader>
              <CardTitle>Publish</CardTitle>
              <CardDescription>
                Venues {status.counts.venues.published} of {status.counts.venues.total} · tracks {status.counts.tracks.published} of {status.counts.tracks.total} · sessions {status.counts.sessionsPublished} of {status.counts.sessionsScheduled}
                {status.counts.sessionsCancelled ? ` · ${status.counts.sessionsCancelled} cancelled` : ''}. Re-publishing is safe: records are rewritten in place.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-3">
                {PUBLISH_BUTTONS.map((b) => (
                  <Button key={b.what} variant={b.what === 'all' ? 'default' : 'outline'} className="h-auto flex-col items-start py-2 text-left" disabled={busy !== null} onClick={() => publish(b.what)}>
                    <span className="flex items-center gap-2 font-medium">{busy === `publish:${b.what}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{b.label}</span>
                    <span className="text-xs font-normal opacity-80">{b.hint}</span>
                  </Button>
                ))}
              </div>
              {results ? (
                <div className="space-y-2 text-sm" role="status">
                  <p>{results.published} written · {results.skipped} skipped · {results.failed} failed</p>
                  {results.jobId ? (
                    <PublishJobProgress statusUrl={`${apiBase}/publish?jobId=${encodeURIComponent(results.jobId)}`} onDone={() => void refresh()} />
                  ) : null}
                  <ul className="max-h-64 space-y-1 overflow-auto font-mono text-xs">
                    {results.results.filter((r) => r.error || r.skipped).map((r, i) => (
                      <li key={`${r.kind}-${r.id}-${i}`} className={r.error ? 'text-destructive' : 'text-muted-foreground'}>
                        {r.kind} {short(r.id, 8)}: {r.error ?? (r.skipped === 'requires-approval' ? 'moved after publishing — request the move below' : r.skipped)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* ───────────── approvals ───────────── */}
        {canManage && approvals ? (
          <Card id="approvals">
            <CardHeader>
              <CardTitle>Changes awaiting approval</CardTitle>
              <CardDescription>
                Moving or cancelling a published session needs {plural(approvals.threshold, 'organizer approval')}. Each approval is a record in the approving organizer’s own repository.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!pendingRequests.length ? <p className="text-muted-foreground">Nothing is waiting.</p> : null}
              {pendingRequests.map((r) => {
                const mine = r.approvals.some((a) => a.accountId === approvals.viewerAccountId)
                return (
                  <div key={r.id} className="space-y-2 rounded-xl border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{REQUEST_ACTION[r.action]}</Badge>
                      <span className="font-medium">{r.sessionTitle ?? 'Listing'}</span>
                      {r.action === 'move' && r.target.startsAt ? <span className="text-muted-foreground">to {when(r.target.startsAt)}</span> : null}
                      <span className="ml-auto text-muted-foreground tabular-nums">{r.approvals.length} of {r.threshold}</span>
                    </div>
                    <p className="text-muted-foreground">“{r.reason}” — {r.requestedBy?.handle ? `@${r.requestedBy.handle}` : 'an organizer'}, {when(r.createdAt)}</p>
                    {r.approvals.length ? <p className="text-xs text-muted-foreground">Approved by {r.approvals.map((a) => (a.handle ? `@${a.handle}` : 'an organizer')).join(', ')}</p> : null}
                    {r.error ? <p className="text-xs text-destructive">Last attempt to apply failed: {r.error}</p> : null}
                    <div className="flex gap-2">
                      {!mine || r.error ? (
                        <Button size="sm" loading={busy === `approve:${r.id}`} disabled={busy !== null && busy !== `approve:${r.id}`} onClick={() => act(`approve:${r.id}`, (confirm) => apiFetch(approvalsBase, { method: 'POST', json: { action: 'approve', requestId: r.id, ...(confirm ? { confirmPublicLinkage: true } : {}) } }), 'Approval recorded.')}>
                          {mine ? 'Retry applying' : 'Approve'}
                        </Button>
                      ) : null}
                      {mine ? (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`withdraw:${r.id}`, () => apiFetch(approvalsBase, { method: 'POST', json: { action: 'withdraw', requestId: r.id } }), 'Your approval was withdrawn.')}>
                          Withdraw my approval
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
              {recentRequests.length ? (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">Recent</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {recentRequests.map((r) => (
                      <li key={r.id}>{REQUEST_STATUS[r.status] ?? r.status} · {REQUEST_ACTION[r.action]} · {r.sessionTitle ?? 'listing'} · {when(r.createdAt)}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* ───────────── needs review ───────────── */}
        {status.flagged.length ? (
          <Card id="drift">
            <CardHeader>
              <CardTitle>Sessions that need review</CardTitle>
              <CardDescription>Proposers own their proposals. When one changes or disappears, the published schedule is left alone until you decide.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {status.flagged.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-xl border p-3">
                  <Badge variant={FLAG_LABEL[f.kind].badge}>{FLAG_LABEL[f.kind].label}</Badge>
                  <Link className="font-medium underline-offset-2 hover:underline" href={`/e/${event.slug}/sessions/${f.id}`}>{f.title}</Link>
                  <span className="text-muted-foreground">{when(f.since)}</span>
                  {canManage && reasonFor?.kind !== 'cancel' ? (
                    <span className="ml-auto flex gap-2">
                      {f.kind === 'cid-drift' ? (
                        <Button size="sm" variant="outline" loading={busy === `republish:${f.id}`} disabled={busy !== null && busy !== `republish:${f.id}`} onClick={() => act(`republish:${f.id}`, () => apiFetch(`${apiBase}/sessions/${f.id}`, { method: 'POST', json: { action: 'republish' } }), 'Re-published with the proposer’s current version.')}>
                          Adopt and re-publish
                        </Button>
                      ) : f.kind === 'location-changed' ? (
                        <Button size="sm" variant="outline" loading={busy === `republish:${f.id}`} disabled={busy !== null && busy !== `republish:${f.id}`} onClick={() => act(`republish:${f.id}`, () => apiFetch(`${apiBase}/sessions/${f.id}`, { method: 'POST', json: { action: 'republish' } }), 'Re-published with the current location.')}>
                          Re-publish
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy !== null} onClick={() => setReasonFor({ kind: 'cancel', id: f.id })}>
                        Cancel session
                      </Button>
                    </span>
                  ) : null}
                  {canManage && reasonFor?.kind === 'cancel' && reasonFor.id === f.id ? (
                    <ReasonForm
                      id={`cancel-reason-${f.id}`}
                      prompt="Why is this session being cancelled?"
                      confirmLabel="Request cancellation"
                      busy={busy === `cancel:${f.id}`}
                      onSubmit={(reason) => requestCancel(f.id, reason)}
                      onCancel={() => setReasonFor(null)}
                    />
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {/* ───────────── peers and listings ───────────── */}
        {canManage && status.linked ? (
          <Card>
            <CardHeader>
              <CardTitle>Peers and listings</CardTitle>
              <CardDescription>
                Routing tags: {status.tags.length ? status.tags.join(', ') : 'none (set them in settings)'}. Peers appear publicly in the gathering record; their events are listed here only after you enable cross-listing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act('peer:add', async () => {
                    await post({ action: 'upsert-peer', peerDid, label: peerLabel || null })
                    setPeerDid('')
                    setPeerLabel('')
                  }, 'Peer added.')
                }}
              >
                <Input className="max-w-xs font-mono" placeholder="did:plc:…" value={peerDid} onChange={(e) => setPeerDid(e.target.value)} aria-label="Peer DID" />
                <Input className="max-w-[12rem]" placeholder="Label (optional)" value={peerLabel} onChange={(e) => setPeerLabel(e.target.value)} aria-label="Peer label (optional)" />
                <Button type="submit" variant="outline" loading={busy === 'peer:add'} disabled={(busy !== null && busy !== 'peer:add') || !peerDid.trim()}>Add peer</Button>
              </form>
              {status.peers.length ? (
                <ul className="space-y-2">
                  {status.peers.map((p) => (
                    <li key={p.peer_did} className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-xs" title={p.peer_did}>{p.label ?? short(p.peer_did)}</span>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`peer-${p.peer_did}`}
                          checked={p.cross_listing_enabled}
                          disabled={busy !== null}
                          onCheckedChange={(checked) => void act(`peer:${p.peer_did}`, () => post({ action: 'upsert-peer', peerDid: p.peer_did, crossListingEnabled: checked === true }))}
                        />
                        <Label htmlFor={`peer-${p.peer_did}`} className="text-xs font-normal">List their events here</Label>
                      </div>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`peer:rm:${p.peer_did}`, () => post({ action: 'remove-peer', peerDid: p.peer_did }), 'Peer removed.')}>Remove</Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {status.listings.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead><tr className="text-muted-foreground"><th scope="col" className="py-1">Listed event</th><th scope="col">From</th><th scope="col">Tags</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {status.listings.map((l) => (
                        <tr key={l.id} className="border-t">
                          <td className="py-1 font-mono" title={l.subject_uri}>{short(l.subject_uri, 18)}</td>
                          <td>{l.origin === 'own' ? 'This gathering' : 'Peer'}</td>
                          <td>{l.tags.join(', ')}</td>
                          <td>{l.status === 'listed' ? 'Listed' : 'Removed'}</td>
                          <td className="text-right">
                            {l.status === 'removed' ? (
                              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`restore:${l.id}`, () => post({ action: 'restore-listing', listingId: l.id }), 'Listing restored.')}>Restore</Button>
                            ) : reasonFor?.kind === 'unlist' && reasonFor.id === l.id ? (
                              <ReasonForm
                                id={`unlist-reason-${l.id}`}
                                prompt="Why remove this listing?"
                                confirmLabel="Request removal"
                                busy={busy === `unlist:${l.id}`}
                                onSubmit={(reason) => requestUnlist(l.id, reason)}
                                onCancel={() => setReasonFor(null)}
                              />
                            ) : (
                              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy !== null} onClick={() => setReasonFor({ kind: 'unlist', id: l.id })}>
                                Remove
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* ───────────── feed (design §7) ───────────── */}
        {canManage && feed ? (
          <Card id="feed">
            <CardHeader>
              <CardTitle>Feed</CardTitle>
              <CardDescription>
                {feed.enabled
                  ? feed.blocked ? `Switched on, but nothing is posted right now: ${feed.blocked}.` : `On. Posts go out from @${feed.actorHandle ?? '…'}; more than ${feed.digestThreshold} sessions in one publish become a single digest post.`
                  : 'Off. The gathering posts nothing until you switch it on.'}
                {' '}Change this in <Link className="underline" href={`/e/${event.slug}/admin/settings#feed-network`}>settings</Link>.
                {' '}{feed.counts.posted} posted · {feed.counts.queued} queued · {feed.counts.failed} failed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {feed.counts.queued > 0 ? (
                <Button size="sm" variant="outline" loading={busy === 'feed-deliver'} disabled={busy !== null && busy !== 'feed-deliver'} onClick={() => act('feed-deliver', () => apiFetch(feedBase, { method: 'POST', json: { action: 'deliver' } }), 'Queued posts delivered.')}>
                  Post queued now
                </Button>
              ) : null}
              {feed.posts.length ? (
                <ul className="space-y-2 text-sm">
                  {feed.posts.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-start gap-2 rounded-lg border p-3">
                      <Badge variant={FEED_STATUS_LABEL[p.status].badge}>{FEED_STATUS_LABEL[p.status].label}</Badge>
                      <span className="text-muted-foreground">{p.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{when(p.postedAt ?? p.createdAt)}</span>
                      <p className="basis-full break-words">{p.text || <span className="text-muted-foreground">Text is written when the post goes out.</span>}</p>
                      {p.mentions.length ? <p className="basis-full text-xs text-muted-foreground">Mentions (with consent): {p.mentions.map((m) => `@${m.handle}`).join(', ')}</p> : null}
                      {p.error ? <p className="basis-full text-xs text-destructive">{p.error}</p> : null}
                      <span className="flex basis-full gap-3">
                        {p.bskyUrl ? <a className="inline-flex items-center gap-1 text-xs underline" href={p.bskyUrl} target="_blank" rel="noopener noreferrer">View on Bluesky<ExternalLink className="h-3 w-3" aria-hidden="true" /></a> : null}
                        {p.status === 'failed' ? (
                          <Button size="sm" variant="ghost" loading={busy === `feed-retry:${p.id}`} disabled={busy !== null && busy !== `feed-retry:${p.id}`} onClick={() => act(`feed-retry:${p.id}`, () => apiFetch(feedBase, { method: 'POST', json: { action: 'retry', postId: p.id } }), 'Queued again.')}>
                            Retry
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">No posts yet.</p>}
            </CardContent>
          </Card>
        ) : null}

        {/* ───────────── what is public, audit ───────────── */}
        <Card>
          <CardHeader>
            <CardTitle>What becomes public</CardTitle>
            <CardDescription>
              Policy: {plural(status.policy.destructiveActionStewards, 'approval')} for destructive changes · counts hidden below {plural(status.policy.feedbackK, 'voter')} · role claims {status.policy.publishRoles ? 'allowed (members opt in)' : 'off'}. Change these in <Link className="underline" href={`/e/${event.slug}/admin/settings`}>settings</Link>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {PUBLIC_RECORDS.map((r) => (
                <div key={r.record}><dt className="font-medium">{r.record}</dt><dd className="text-muted-foreground">{r.what}</dd></div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">Never published: votes, ballots, tickets, RSVPs (unless an attendee shares their own), rosters, track leads, listed speaker names, moderation reasons.</p>
          </CardContent>
        </Card>

        {status.recentAudit.length ? (
          <Card>
            <CardHeader><CardTitle>Audit trail</CardTitle><CardDescription>Every write as the gathering, allowed or denied.</CardDescription></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs">
                {status.recentAudit.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <Badge variant={DECISION_LABEL[a.decision].badge}>{DECISION_LABEL[a.decision].label}</Badge>
                    <span className="font-mono">{a.action}</span>
                    <span className="text-muted-foreground">{a.reason}</span>
                    <span className="ml-auto text-muted-foreground">{when(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
