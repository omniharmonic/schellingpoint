'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, CheckCircle2, ExternalLink, Globe, Loader2, Unplug, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { getAccessToken } from '@/lib/supabase/client'

interface AuditRow {
  id: string
  action: string
  collection: string | null
  rkey: string | null
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
  credentialHealth: { lastOkAt: string | null; lastErrorAt: string | null; lastError: string | null } | null
  gatheringUri: string | null
  publishedAt: string | null
  counts: {
    venues: { total: number; published: number }
    tracks: { total: number; published: number }
    sessionsScheduled: number
    sessionsPublished: number
  }
  recentAudit: AuditRow[]
  links: { pdsls: string; bsky: string } | null
}

interface PublishResult {
  kind: string
  id: string
  uri?: string
  cid?: string
  error?: string
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
  { record: 'Gathering', what: 'Name, description, dates, region, phase, website, tags, and a link to the policy.' },
  { record: 'Calendar event + config', what: 'The gathering as a calendar entry any ATProto calendar can read: dates, address (if set), event page URL, timezone, capacity.' },
  { record: 'Policy', what: 'The voting method, credits per voter, proposal rules and deadlines, in plain text.' },
  { record: 'Venues', what: 'Name, capacity, features, style, address and notes of each space.' },
  { record: 'Tracks', what: 'Name, description, color and order. Track leads are never published.' },
  { record: 'Slot grids', what: 'The time slots offered per venue and day, including breaks.' },
  { record: 'Scheduled sessions', what: 'Title, public description, start/end, venue address and the session page URL for each session on the schedule, plus a slot record pointing at the proposal it came from.' },
  { record: 'Stub proposals', what: 'For sessions whose proposer has not published their own proposal: title, description, format, duration and topics — marked as imported and naming no host.' },
  { record: 'Tally', what: 'After voting closes: per-session voter, vote and credit counts, with every session under the k threshold suppressed. Never who voted.' },
]

function short(value: string | null | undefined, keep = 14): string {
  if (!value) return ''
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export default function AdminAtprotoPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { role, isAdmin, isOwner, isLoading: roleLoading } = useEventRole()
  const allowed = isAdmin || role === 'moderator'

  const [status, setStatus] = React.useState<Status | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const [oauthHandle, setOauthHandle] = React.useState('')
  const [oauthBusy, setOauthBusy] = React.useState(false)
  const [handle, setHandle] = React.useState('')
  const [appPassword, setAppPassword] = React.useState('')
  const [linking, setLinking] = React.useState(false)
  const [unlinkConfirm, setUnlinkConfirm] = React.useState(false)
  const [unlinking, setUnlinking] = React.useState(false)

  const [publishing, setPublishing] = React.useState<What | null>(null)
  const [results, setResults] = React.useState<{ what: What; published: number; failed: number; results: PublishResult[] } | null>(null)

  const authHeaders = React.useCallback((): Record<string, string> => {
    const token = getAccessToken()
    return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
  }, [])
  const apiBase = `/api/v1/events/${event.slug}/admin/atproto`

  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !allowed)) router.push(`/e/${event.slug}/sessions`)
  }, [user, allowed, authLoading, roleLoading, router, event.slug])

  const fetchStatus = React.useCallback(async () => {
    try {
      const res = await fetch(apiBase, { headers: authHeaders() })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Could not load network status')
      setStatus(await res.json())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load network status')
    } finally {
      setLoading(false)
    }
  }, [apiBase, authHeaders])

  React.useEffect(() => {
    if (authLoading || roleLoading || !user || !allowed) return
    fetchStatus()
    // Returning from the OAuth consent screen: ?linked=1
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('linked') === '1') {
      setNotice('Gathering account connected.')
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [authLoading, roleLoading, user, allowed, fetchStatus])

  const startOAuth = async () => {
    const h = oauthHandle.trim().replace(/^@/, '')
    if (!h) { setError('Enter the handle of the gathering account.'); return }
    setOauthBusy(true)
    setError(null)
    try {
      const next = `/e/${event.slug}/admin/atproto?linked=1`
      const url = `/api/atproto/auth/start?handle=${encodeURIComponent(h)}&purpose=gathering&event=${encodeURIComponent(event.id)}&next=${encodeURIComponent(next)}`
      const res = await fetch(url, { headers: authHeaders() })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.url) throw new Error(body?.error || 'Could not start the sign-in flow')
      window.location.assign(body.url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the sign-in flow')
      setOauthBusy(false)
    }
  }

  const linkWithAppPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setLinking(true)
    setError(null)
    try {
      const res = await fetch(apiBase, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ handle, appPassword }) })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || 'Could not connect the account')
      setStatus(body)
      setAppPassword('')
      setHandle('')
      setNotice('Gathering account connected.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect the account')
    } finally {
      setLinking(false)
    }
  }

  const unlink = async () => {
    setUnlinking(true)
    setError(null)
    try {
      const res = await fetch(apiBase, { method: 'DELETE', headers: authHeaders() })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || 'Could not disconnect the account')
      setStatus(body)
      setResults(null)
      setNotice('Gathering account disconnected. Records already on the network stay where they are.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect the account')
    } finally {
      setUnlinking(false)
      setUnlinkConfirm(false)
    }
  }

  const publish = async (what: What) => {
    setPublishing(what)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`${apiBase}/publish`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ what }) })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || 'Publish failed')
      setResults(body)
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed')
    } finally {
      setPublishing(null)
    }
  }

  if (authLoading || roleLoading || loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }
  if (!allowed) return null

  const linked = !!status?.linked

  return (
    <div className="max-w-4xl space-y-6">
      <div className="page-heading">
        <div>
          <h1 className="text-2xl font-display font-bold">Network</h1>
          <p className="text-muted-foreground">Publish this gathering to the ATProto network so other calendars and apps can read it.</p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
          <p className="text-sm text-destructive flex-1 break-words">{error}</p>
          <Button variant="ghost" size="sm" onClick={() => setError(null)} aria-label="Dismiss"><X className="h-4 w-4" /></Button>
        </div>
      )}
      {notice && (
        <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
          <p className="text-sm flex-1">{notice}</p>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)} aria-label="Dismiss"><X className="h-4 w-4" /></Button>
        </div>
      )}

      {/* Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Globe className="h-5 w-5 text-primary" />Gathering account</CardTitle>
          <CardDescription>
            {!status?.configured
              ? 'ATProto is not configured on this deployment.'
              : linked
                ? 'This gathering writes its public records as the account below.'
                : 'Not connected. Connect an ATProto account that will act as this gathering.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {linked && status && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{status.actorHandle ? `@${status.actorHandle}` : 'linked'}</Badge>
                <Badge variant="outline">{status.credentialKind === 'oauth' ? 'OAuth' : 'App password'}</Badge>
                {status.credentialHealth?.lastError && <Badge variant="destructive">Last write failed</Badge>}
              </div>
              <p className="text-xs text-muted-foreground font-mono break-all">{status.actorDid}</p>
              {status.links && (
                <div className="flex flex-wrap gap-3 text-sm">
                  <a className="inline-flex items-center gap-1 underline underline-offset-4" href={status.links.pdsls} target="_blank" rel="noreferrer">Records on pdsls.dev <ExternalLink className="h-3.5 w-3.5" /></a>
                  <a className="inline-flex items-center gap-1 underline underline-offset-4" href={status.links.bsky} target="_blank" rel="noreferrer">Profile on Bluesky <ExternalLink className="h-3.5 w-3.5" /></a>
                </div>
              )}
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><dt className="text-muted-foreground">Last published</dt><dd>{when(status.publishedAt)}</dd></div>
                <div><dt className="text-muted-foreground">Venues</dt><dd>{status.counts.venues.published} / {status.counts.venues.total}</dd></div>
                <div><dt className="text-muted-foreground">Tracks</dt><dd>{status.counts.tracks.published} / {status.counts.tracks.total}</dd></div>
                <div><dt className="text-muted-foreground">Sessions</dt><dd>{status.counts.sessionsPublished} / {status.counts.sessionsScheduled} scheduled</dd></div>
              </dl>
              {status.credentialHealth?.lastError && (
                <p className="text-xs text-destructive break-words">{status.credentialHealth.lastError}</p>
              )}
              {isOwner && (
                unlinkConfirm ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>Disconnect this account? Published records stay on the network.</span>
                    <Button size="sm" variant="destructive" onClick={unlink} disabled={unlinking}>{unlinking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Disconnect</Button>
                    <Button size="sm" variant="outline" onClick={() => setUnlinkConfirm(false)} disabled={unlinking}>Cancel</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setUnlinkConfirm(true)}><Unplug className="h-4 w-4 mr-2" />Disconnect</Button>
                )
              )}
            </div>
          )}
          {!linked && status?.configured && !isOwner && (
            <p className="text-sm text-muted-foreground">Only the event owner can connect a gathering account.</p>
          )}
        </CardContent>
      </Card>

      {/* Connect */}
      {!linked && status?.configured && isOwner && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Connect with sign-in</CardTitle>
              <CardDescription>You will be sent to the account&apos;s own server to approve Schelling Point. Recommended.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="text-sm font-medium" htmlFor="oauth-handle">Account handle</label>
              <Input id="oauth-handle" value={oauthHandle} onChange={(e) => setOauthHandle(e.target.value)} placeholder="gathering.bsky.social" autoComplete="off" />
              <Button onClick={startOAuth} disabled={oauthBusy || !oauthHandle.trim()} className="w-full sm:w-auto">
                {oauthBusy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Connect with Bluesky
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Connect with an app password</CardTitle>
              <CardDescription>Create an app password in your account settings; never your main password.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={linkWithAppPassword}>
                <div className="space-y-1">
                  <label className="text-sm font-medium" htmlFor="ap-handle">Account handle</label>
                  <Input id="ap-handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="gathering.bsky.social" autoComplete="off" required />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium" htmlFor="ap-password">App password</label>
                  <Input id="ap-password" type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off" required />
                </div>
                <p className="text-xs text-muted-foreground">Stored encrypted on the server and used only to write this gathering&apos;s records. Revoke it from the account at any time.</p>
                <Button type="submit" disabled={linking || !handle.trim() || !appPassword} className="w-full sm:w-auto">
                  {linking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Connect
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Publish */}
      {linked && isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Publish</CardTitle>
            <CardDescription>Publishing is idempotent: running it again rewrites the same records. Every write is logged below.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {PUBLISH_BUTTONS.map((b) => (
                <Button
                  key={b.what}
                  variant={b.what === 'all' ? 'default' : 'outline'}
                  onClick={() => publish(b.what)}
                  disabled={publishing !== null}
                  className="h-auto min-h-11 flex-col items-start gap-0.5 py-2 text-left whitespace-normal"
                >
                  <span className="flex items-center gap-2 font-medium">{publishing === b.what && <Loader2 className="h-4 w-4 animate-spin" />}{b.label}</span>
                  <span className="text-xs font-normal opacity-80">{b.hint}</span>
                </Button>
              ))}
            </div>
            {results && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary">{results.published} written</Badge>
                  {results.failed > 0 && <Badge variant="destructive">{results.failed} failed</Badge>}
                  {results.results.length === 0 && <span className="text-muted-foreground">Nothing to publish yet.</span>}
                </div>
                {results.results.length > 0 && (
                  <ul className="max-h-72 overflow-y-auto rounded-lg border divide-y text-sm">
                    {results.results.map((r, i) => (
                      <li key={`${r.kind}-${r.id}-${i}`} className="p-2 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                        <Badge variant={r.error ? 'destructive' : 'outline'} className="w-fit shrink-0">{r.kind}</Badge>
                        <span className="font-mono text-xs text-muted-foreground break-all">{r.error ? r.error : short(r.uri, 22)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Audit */}
      {linked && status && (
        <Card>
          <CardHeader>
            <CardTitle>Recent writes</CardTitle>
            <CardDescription>The last 20 actions taken as the gathering, allowed or denied.</CardDescription>
          </CardHeader>
          <CardContent>
            {status.recentAudit.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing written yet.</p>
            ) : (
              <div className="overflow-x-auto -mx-2 sm:mx-0">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-2 py-1 font-medium">When</th>
                      <th className="px-2 py-1 font-medium">Action</th>
                      <th className="px-2 py-1 font-medium">Record</th>
                      <th className="px-2 py-1 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {status.recentAudit.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap">{when(row.created_at)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{row.action}</td>
                        <td className="px-2 py-1.5 font-mono text-xs break-all">{row.collection ? `${row.collection.split('.').pop()}/${row.rkey ?? ''}` : ''}</td>
                        <td className="px-2 py-1.5">
                          <Badge variant={row.decision === 'allow' ? 'outline' : 'destructive'}>{row.decision}</Badge>
                          <p className="text-xs text-muted-foreground mt-1 break-words max-w-[320px]">{row.reason}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Explainer */}
      <Card>
        <CardHeader>
          <CardTitle>What becomes public</CardTitle>
          <CardDescription>
            Records are written into the gathering account&apos;s own repository, readable by anyone on the network.
            Votes, tickets, RSVPs, members, emails and host names are never published. Proposals are only ever
            published by the people who wrote them, into their own accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            {PUBLIC_RECORDS.map((r) => (
              <div key={r.record} className="grid gap-0.5 sm:grid-cols-[160px_1fr] sm:gap-3">
                <dt className="font-medium">{r.record}</dt>
                <dd className="text-muted-foreground">{r.what}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}
