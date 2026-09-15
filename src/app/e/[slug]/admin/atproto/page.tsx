'use client'

/**
 * Organiser view of the gathering on the network: its identity and credential health (the banner
 * a revoked credential raises), publishing, destructive-action approvals, sessions that need review
 * (cid drift, withdrawn proposals), peers and listings, and the audit trail.
 * Everything goes through `/api/v1/events/[slug]/admin/atproto` and `/approvals` with the session cookie.
 */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, AlertTriangle, CheckCircle2, ExternalLink, Globe, Loader2, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'

interface AuditRow {
  id: string
  action: string
  collection: string | null
  uri: string | null
  decision: 'allow' | 'deny'
  reason: string
  created_at: string
}

interface Status {
  configured: boolean
  linked: boolean
  actorDid: string | null
  actorHandle: string | null
  credentialKind: 'oauth' | 'app-password' | null
  health: { state: 'unlinked' | 'ok' | 'failing' | 'disabled'; lastOkAt: string | null; lastErrorAt: string | null; banner: string | null }
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
  flagged: Array<{ id: string; title: string; kind: 'cid-drift' | 'withdrawn'; since: string; proposalUri: string | null }>
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
  { record: 'Tracks', what: 'Name, description, colour, order and shared-taxonomy skills. Track leads are never published.' },
  { record: 'Scheduled sessions', what: 'A calendar event per session plus a slot record pointing at the proposal it came from.' },
  { record: 'Stub proposals', what: 'Only for sessions whose author has no proposal of their own: content only, marked imported, naming no one.' },
  { record: 'Listings', what: 'Sessions whose tags match the gathering’s routing tags, and events of peers you enabled.' },
  { record: 'Tally', what: 'After voting closes: counts per session, with sessions under the privacy threshold suppressed. Never who voted.' },
]

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function short(value: string | null | undefined, keep = 14): string {
  if (!value) return ''
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value
}

export default function AdminAtprotoPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { role, isAdmin, isOwner, isLoading: roleLoading } = useEventRole()
  const allowed = isAdmin || role === 'moderator'
  const canManage = isAdmin

  const [status, setStatus] = React.useState<Status | null>(null)
  const [approvals, setApprovals] = React.useState<{ threshold: number; viewerAccountId: string; requests: ApprovalRequest[] } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [results, setResults] = React.useState<{ what: What; published: number; skipped: number; failed: number; results: PublishResult[] } | null>(null)
  const [confirmLinkage, setConfirmLinkage] = React.useState<null | (() => Promise<void>)>(null)

  const [oauthHandle, setOauthHandle] = React.useState('')
  const [handle, setHandle] = React.useState('')
  const [appPassword, setAppPassword] = React.useState('')
  const [peerDid, setPeerDid] = React.useState('')
  const [peerLabel, setPeerLabel] = React.useState('')
  const [unlinkConfirm, setUnlinkConfirm] = React.useState(false)

  const apiBase = `/api/v1/events/${encodeURIComponent(event.slug)}/admin/atproto`
  const approvalsBase = `/api/v1/events/${encodeURIComponent(event.slug)}/approvals`

  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !allowed)) router.push(`/e/${event.slug}/sessions`)
  }, [user, allowed, authLoading, roleLoading, router, event.slug])

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await apiFetch<Status>(apiBase))
      if (canManage) setApprovals(await apiFetch(approvalsBase))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load network status')
    }
  }, [apiBase, approvalsBase, canManage])

  React.useEffect(() => {
    if (authLoading || roleLoading || !user || !allowed) return
    void refresh()
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('linked') === '1') {
      setNotice('Gathering account connected.')
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [authLoading, roleLoading, user, allowed, refresh])

  /** Run an action; a `confirm_public_linkage` answer asks once and retries with the confirmation. */
  const act = async (key: string, fn: (confirm: boolean) => Promise<unknown>, success?: string) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await fn(false)
      if (success) setNotice(success)
      await refresh()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_public_linkage') {
        setConfirmLinkage(() => async () => {
          setConfirmLinkage(null)
          await act(key, () => fn(true), success)
        })
      } else {
        setError(e instanceof Error ? e.message : 'Something went wrong')
      }
    } finally {
      setBusy(null)
    }
  }

  const post = (json: Record<string, unknown>) => apiFetch<Status>(apiBase, { method: 'POST', json })

  const publish = (what: What) =>
    act(`publish:${what}`, async () => {
      const out = await apiFetch<{ what: What; published: number; skipped: number; failed: number; results: PublishResult[] }>(`${apiBase}/publish`, { method: 'POST', json: { what } })
      setResults(out)
    })

  const startOAuth = async () => {
    const h = oauthHandle.trim().replace(/^@/, '')
    if (!h) return setError('Enter the handle of the gathering account.')
    const next = `/e/${event.slug}/admin/atproto?linked=1`
    window.location.assign(`/api/atproto/auth/start?handle=${encodeURIComponent(h)}&purpose=gathering&event=${encodeURIComponent(event.id)}&next=${encodeURIComponent(next)}`)
  }

  const askReason = (prompt: string): string | null => {
    const reason = typeof window !== 'undefined' ? window.prompt(prompt) : null
    return reason && reason.trim() ? reason.trim() : null
  }

  if (authLoading || roleLoading || !status) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        {error ? <AlertCircle className="h-4 w-4" aria-hidden /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {error ?? 'Loading network status…'}
      </div>
    )
  }

  const pendingRequests = approvals?.requests.filter((r) => r.status === 'pending' || r.status === 'applying') ?? []
  const recentRequests = approvals?.requests.filter((r) => r.status !== 'pending' && r.status !== 'applying').slice(0, 10) ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Globe className="h-6 w-6" aria-hidden /> On the network
        </h1>
        <p className="text-sm text-muted-foreground">
          What this gathering publishes to ATProto, and the changes that need more than one organiser.
        </p>
      </header>

      {status.health.banner ? (
        <div role="alert" className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${status.health.state === 'disabled' ? 'border-destructive/50 bg-destructive/10' : 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-2">
            <p>{status.health.banner}</p>
            {status.health.state === 'disabled' && canManage ? (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('reset', () => post({ action: 'reset-credential' }), 'Credential re-enabled. The next publish will try again.')}>
                I reconnected it — try again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
        </p>
      ) : null}
      {confirmLinkage ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
          <p>Approving writes a public record in your own ATProto repository that permanently links your account to organising this gathering.</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void confirmLinkage()}>I understand, continue</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmLinkage(null)}>Cancel</Button>
          </div>
        </div>
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
              <div><dt className="text-xs uppercase text-muted-foreground">Credential</dt><dd>{status.credentialKind === 'app-password' ? 'Custodied by this app' : 'OAuth session'} · <Badge variant={status.health.state === 'ok' ? 'secondary' : 'destructive'}>{status.health.state}</Badge></dd></div>
              <div><dt className="text-xs uppercase text-muted-foreground">Gathering record</dt><dd>{status.gatheringUri ? `published ${when(status.publishedAt)}` : 'not yet published'}</dd></div>
              {status.links ? (
                <div className="sm:col-span-2">
                  <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={status.links.pdsls} target="_blank" rel="noreferrer">
                    Browse the repository <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </div>
              ) : null}
            </dl>
          ) : canManage ? (
            <div className="space-y-4">
              <Button disabled={busy !== null || !status.configured} onClick={() => act('mint', () => post({ action: 'mint' }), 'Gathering identity created.')}>
                {busy === 'mint' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
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
                    <Button type="submit" variant="outline" disabled={busy !== null}>Connect with an app password</Button>
                  </form>
                </details>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground">No network identity yet. An owner or admin can create one.</p>
          )}
          {status.linked && isOwner ? (
            unlinkConfirm ? (
              <div className="flex flex-wrap items-center gap-2">
                <span>Disconnect? Records already published stay on the network.</span>
                <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => act('unlink', async () => { await apiFetch(apiBase, { method: 'DELETE' }); setUnlinkConfirm(false) }, 'Disconnected.')}>Disconnect</Button>
                <Button size="sm" variant="ghost" onClick={() => setUnlinkConfirm(false)}>Keep</Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setUnlinkConfirm(true)}><Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Disconnect</Button>
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
              Venues {status.counts.venues.published}/{status.counts.venues.total} · tracks {status.counts.tracks.published}/{status.counts.tracks.total} · sessions {status.counts.sessionsPublished}/{status.counts.sessionsScheduled}
              {status.counts.sessionsCancelled ? ` · ${status.counts.sessionsCancelled} cancelled` : ''}. Re-publishing is safe: records are rewritten in place.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {PUBLISH_BUTTONS.map((b) => (
                <Button key={b.what} variant={b.what === 'all' ? 'default' : 'outline'} className="h-auto flex-col items-start py-2 text-left" disabled={busy !== null} onClick={() => publish(b.what)}>
                  <span className="flex items-center gap-2 font-medium">{busy === `publish:${b.what}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}{b.label}</span>
                  <span className="text-xs font-normal opacity-80">{b.hint}</span>
                </Button>
              ))}
            </div>
            {results ? (
              <div className="space-y-2 text-sm">
                <p>{results.published} written · {results.skipped} skipped · {results.failed} failed</p>
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
              Moving or cancelling a published session needs {approvals.threshold} organiser approval{approvals.threshold === 1 ? '' : 's'}. Each approval is a record in the approving organiser’s own repository.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!pendingRequests.length ? <p className="text-muted-foreground">Nothing is waiting.</p> : null}
            {pendingRequests.map((r) => {
              const mine = r.approvals.some((a) => a.accountId === approvals.viewerAccountId)
              return (
                <div key={r.id} className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{r.action === 'move' ? 'Move' : r.action === 'cancel' ? 'Cancel' : 'Remove listing'}</Badge>
                    <span className="font-medium">{r.sessionTitle ?? 'Listing'}</span>
                    {r.action === 'move' && r.target.startsAt ? <span className="text-muted-foreground">to {when(r.target.startsAt)}</span> : null}
                    <span className="ml-auto text-muted-foreground">{r.approvals.length}/{r.threshold}</span>
                  </div>
                  <p className="text-muted-foreground">“{r.reason}” — {r.requestedBy?.handle ? `@${r.requestedBy.handle}` : 'an organiser'}, {when(r.createdAt)}</p>
                  {r.approvals.length ? <p className="text-xs text-muted-foreground">Approved by {r.approvals.map((a) => (a.handle ? `@${a.handle}` : 'an organiser')).join(', ')}</p> : null}
                  {r.error ? <p className="text-xs text-destructive">Last attempt to apply failed: {r.error}</p> : null}
                  <div className="flex gap-2">
                    {!mine || r.error ? (
                      <Button size="sm" disabled={busy !== null} onClick={() => act(`approve:${r.id}`, (confirm) => apiFetch(approvalsBase, { method: 'POST', json: { action: 'approve', requestId: r.id, ...(confirm ? { confirmPublicLinkage: true } : {}) } }), 'Approval recorded.')}>
                        {busy === `approve:${r.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
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
                    <li key={r.id}>{r.status} · {r.action} · {r.sessionTitle ?? 'listing'} · {when(r.createdAt)}</li>
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
              <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                <Badge variant={f.kind === 'withdrawn' ? 'destructive' : 'secondary'}>{f.kind === 'withdrawn' ? 'Withdrawn' : 'Edited'}</Badge>
                <Link className="font-medium underline-offset-2 hover:underline" href={`/e/${event.slug}/sessions/${f.id}`}>{f.title}</Link>
                <span className="text-muted-foreground">{when(f.since)}</span>
                {canManage ? (
                  <span className="ml-auto flex gap-2">
                    {f.kind === 'cid-drift' ? (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(`republish:${f.id}`, () => apiFetch(`${apiBase}/sessions/${f.id}`, { method: 'POST', json: { action: 'republish' } }), 'Re-published with the proposer’s current version.')}>
                        Adopt and re-publish
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        const reason = askReason('Why is this session being cancelled? (recorded with every approval)')
                        if (reason) void act(`cancel:${f.id}`, (confirm) => apiFetch(approvalsBase, { method: 'POST', json: { action: 'request-cancel', sessionId: f.id, reason, ...(confirm ? { confirmPublicLinkage: true } : {}) } }), 'Cancellation requested.')
                      }}
                    >
                      Cancel session
                    </Button>
                  </span>
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
              Routing tags: {status.tags.length ? status.tags.join(', ') : 'none (set them in event settings)'}. Peers appear publicly in the gathering record; their events are listed here only after you enable cross-listing.
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
              <Input className="max-w-[12rem]" placeholder="label (optional)" value={peerLabel} onChange={(e) => setPeerLabel(e.target.value)} aria-label="Peer label" />
              <Button type="submit" variant="outline" disabled={busy !== null || !peerDid.trim()}>Add peer</Button>
            </form>
            {status.peers.length ? (
              <ul className="space-y-2">
                {status.peers.map((p) => (
                  <li key={p.peer_did} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs" title={p.peer_did}>{p.label ?? short(p.peer_did)}</span>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={p.cross_listing_enabled}
                        disabled={busy !== null}
                        onChange={(e) => void act(`peer:${p.peer_did}`, () => post({ action: 'upsert-peer', peerDid: p.peer_did, crossListingEnabled: e.target.checked }))}
                      />
                      list their events here
                    </label>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`peer:rm:${p.peer_did}`, () => post({ action: 'remove-peer', peerDid: p.peer_did }), 'Peer removed.')}>Remove</Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {status.listings.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead><tr className="text-muted-foreground"><th className="py-1">Listed event</th><th>From</th><th>Tags</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {status.listings.map((l) => (
                      <tr key={l.id} className="border-t">
                        <td className="py-1 font-mono" title={l.subject_uri}>{short(l.subject_uri, 18)}</td>
                        <td>{l.origin === 'own' ? 'this gathering' : 'peer'}</td>
                        <td>{l.tags.join(', ')}</td>
                        <td>{l.status}</td>
                        <td className="text-right">
                          {l.status === 'removed' ? (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`restore:${l.id}`, () => post({ action: 'restore-listing', listingId: l.id }), 'Listing restored.')}>Restore</Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => {
                                const reason = askReason('Why remove this listing? (recorded with every approval)')
                                if (reason) void act(`unlist:${l.id}`, (confirm) => apiFetch(approvalsBase, { method: 'POST', json: { action: 'request-listing-removal', listingId: l.id, reason, ...(confirm ? { confirmPublicLinkage: true } : {}) } }), 'Removal requested.')
                              }}
                            >
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

      {/* ───────────── what is public, audit ───────────── */}
      <Card>
        <CardHeader>
          <CardTitle>What becomes public</CardTitle>
          <CardDescription>
            Policy: {status.policy.destructiveActionStewards} approvals for destructive changes · counts hidden below {status.policy.feedbackK} voters · role claims {status.policy.publishRoles ? 'allowed (members opt in)' : 'off'}. Change these in <Link className="underline" href={`/e/${event.slug}/admin/settings`}>settings</Link>.
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
                <li key={a.id} className="flex flex-wrap gap-2">
                  <Badge variant={a.decision === 'allow' ? 'secondary' : 'destructive'}>{a.decision}</Badge>
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
  )
}
