'use client'

import * as React from 'react'
import Link from 'next/link'
import { BarChart3, Calendar, FileText, Loader2, Lock, ThumbsUp, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { SESSION_STATUS } from '@/lib/labels'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

interface Analytics {
  proposals: {
    total: number
    byStatus: { pending: number; approved: number; rejected: number; scheduled: number }
    approvalRate: number
    byFormat: Array<{ format: string; count: number }>
    byTrack: Array<{ id: string | null; name: string; color: string | null; count: number }>
  }
  members: { total: number; byRole: Record<string, number> }
  schedule: {
    sessionSlots: number
    filledSlots: number
    utilization: number
    venues: Array<{ id: string; name: string; capacity: number | null; slots: number; sessions: number; utilization: number }>
  }
  voting:
    | { status: string; sealed: true; closesAt: string | null; message: string }
    | { status: string; sealed: false; results: Array<{ sessionId: string; title: string; voters: number; votes: number; credits: number }> }
}

// One status → color language, via the shared vocabulary's badge variant (tokens only).
const STATUS_BAR: Record<keyof Analytics['proposals']['byStatus'], string> = {
  scheduled: 'bg-primary',
  approved: 'bg-success',
  pending: 'bg-signal-amber',
  rejected: 'bg-muted-foreground/60',
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', moderator: 'Moderator', track_lead: 'Track lead', volunteer: 'Volunteer', attendee: 'Attendee',
}

export default function AdminAnalyticsPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const [data, setData] = React.useState<Analytics | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [showAllResults, setShowAllResults] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    apiFetch<Analytics>(`/api/v1/events/${event.slug}/admin/overview/analytics`)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'Analytics could not be loaded.') })
    return () => { cancelled = true }
  }, [event.slug, reloadKey])

  if (!can('viewAnalytics')) {
    return (
      <>
        <PageHeader title="Analytics" />
        <Card>
          <CardContent className="py-8 text-center space-y-4">
            <p className="text-muted-foreground">Your role does not include analytics. Ask an owner or admin to change your role.</p>
            <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin`}>Overview & sessions</Link></Button>
          </CardContent>
        </Card>
      </>
    )
  }
  if (error) {
    return (
      <>
        <PageHeader title="Analytics" />
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
        </div>
      </>
    )
  }
  if (!data) {
    return <div className="flex items-center justify-center py-12" role="status" aria-label="Loading analytics"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  const { proposals, members, schedule, voting } = data
  const results = voting.sealed ? [] : voting.results
  const totalBallotVotes = results.reduce((sum, r) => sum + r.votes, 0)
  const shownResults = showAllResults ? results : results.slice(0, 10)
  const nothingYet = proposals.total === 0 && members.total <= 1 && schedule.sessionSlots === 0
  const roleCount = Object.keys(members.byRole).length

  return (
    <div>
      <PageHeader title="Analytics" subtitle="How the program is shaping up. Visible to organizers only." />

      {nothingYet ? (
        <Card>
          <CardContent className="py-12 text-center space-y-4">
            <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground" aria-hidden="true" />
            <div>
              <h2 className="font-display text-lg font-semibold">Nothing to measure yet</h2>
              <p className="mt-1 text-sm text-muted-foreground">Numbers appear here once people join, propose sessions and vote.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild><Link href={`/e/${event.slug}/admin/members`}>Invite people</Link></Button>
              <Button asChild variant="outline"><Link href={`/e/${event.slug}/admin/setup`}>Add rooms and times</Link></Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Proposals" value={proposals.total} icon={<FileText className="h-4 w-4" aria-hidden="true" />} description={`${proposals.approvalRate}% approved or scheduled`} />
            <StatCard title="Members" value={members.total} icon={<Users className="h-4 w-4" aria-hidden="true" />} description={plural(roleCount, 'role')} />
            <StatCard title="Schedule" value={`${schedule.utilization}%`} icon={<Calendar className="h-4 w-4" aria-hidden="true" />} description={`${schedule.filledSlots} of ${plural(schedule.sessionSlots, 'slot')} filled`} />
            <StatCard
              title="Voting"
              value={voting.sealed ? 'Sealed' : voting.status === 'none' ? '—' : totalBallotVotes}
              icon={voting.sealed ? <Lock className="h-4 w-4" aria-hidden="true" /> : <ThumbsUp className="h-4 w-4" aria-hidden="true" />}
              description={voting.sealed ? 'Results open when the round closes' : voting.status === 'none' ? 'No voting round yet' : 'Votes in the closed round'}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ThumbsUp className="h-5 w-5" aria-hidden="true" />Voting results</CardTitle>
              <CardDescription>For organizers planning the program. Never shown to attendees as a ranking.</CardDescription>
            </CardHeader>
            <CardContent>
              {voting.sealed ? (
                <div role="status" className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
                  <Lock className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Voting in progress — results are sealed until the round closes.</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Nobody sees counts while voting is open, organizers included, so the result reflects what people actually care about.
                      {voting.closesAt ? ` Voting closes ${new Date(voting.closesAt).toLocaleString()}.` : ''}
                    </p>
                  </div>
                </div>
              ) : results.length === 0 ? (
                <p className="text-sm text-muted-foreground">{voting.status === 'none' ? 'There has been no voting round yet.' : 'No votes were cast in the closed round.'}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b">
                        <th scope="col" className="py-2 pr-4 font-medium">Session</th>
                        <th scope="col" className="py-2 pr-4 font-medium text-right">Voters</th>
                        <th scope="col" className="py-2 pr-4 font-medium text-right">Votes</th>
                        <th scope="col" className="py-2 font-medium text-right">Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownResults.map((r) => (
                        <tr key={r.sessionId} className="border-b last:border-0">
                          <td className="py-2 pr-4">{r.title}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{r.voters}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{r.votes}</td>
                          <td className="py-2 text-right tabular-nums">{r.credits}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {results.length > 10 && (
                    <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={() => setShowAllResults((v) => !v)} aria-expanded={showAllResults}>
                      {showAllResults ? 'Show fewer' : `Show all ${results.length}`}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" aria-hidden="true" />Proposal status</CardTitle>
                <CardDescription>Breakdown by status</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(['scheduled', 'approved', 'pending', 'rejected'] as const).map((status) => (
                  <StatusBar key={status} label={SESSION_STATUS[status].label} count={proposals.byStatus[status]} total={proposals.total} color={STATUS_BAR[status]} />
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" aria-hidden="true" />By track</CardTitle>
                <CardDescription>Proposals per track</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {proposals.byTrack.length === 0 ? <p className="text-sm text-muted-foreground">No tracks yet. <Link href={`/e/${event.slug}/admin/tracks`} className="text-primary hover:underline">Add tracks</Link></p> : proposals.byTrack.map((t) => (
                  <StatusBar key={t.id ?? 'none'} label={t.name} count={t.count} total={proposals.total} color="bg-primary" style={t.color ? { backgroundColor: t.color } : undefined} />
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" aria-hidden="true" />By format</CardTitle>
                <CardDescription>Session types</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {proposals.byFormat.length === 0 ? <p className="text-sm text-muted-foreground">No proposals yet.</p> : proposals.byFormat.map((f) => (
                  <StatusBar key={f.format} label={f.format} count={f.count} total={proposals.total} color="bg-primary" capitalize />
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Calendar className="h-5 w-5" aria-hidden="true" />Room use</CardTitle>
                <CardDescription>Scheduled sessions per room. Empty rooms are normal early on.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {schedule.venues.length === 0 ? <p className="text-sm text-muted-foreground">No rooms yet. <Link href={`/e/${event.slug}/admin/setup`} className="text-primary hover:underline">Add rooms and times</Link></p> : schedule.venues.map((v) => (
                  <div key={v.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{v.name}</span>
                      <span className="text-muted-foreground tabular-nums">{v.sessions} of {v.slots} ({v.utilization}%)</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden" role="progressbar" aria-label={`${v.name} use`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, v.utilization)}>
                      <div className={cn('h-full rounded-full transition-all', v.utilization > 100 ? 'bg-signal-amber' : 'bg-primary')} style={{ width: `${Math.min(100, v.utilization)}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" aria-hidden="true" />Members by role</CardTitle>
                <CardDescription>Who has joined this gathering</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="flex flex-wrap gap-3">
                  {Object.entries(members.byRole).map(([role, count]) => (
                    <div key={role} className="flex items-center gap-2 bg-muted rounded-xl px-4 py-2">
                      <dt className="font-medium">{ROLE_LABEL[role] ?? role.replace('_', ' ')}</dt>
                      <dd className="text-muted-foreground tabular-nums">{count}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ title, value, icon, description }: { title: string; value: string | number; icon: React.ReactNode; description: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          </div>
          <div className="p-3 bg-primary/10 text-primary rounded-full" aria-hidden="true">{icon}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBar({ label, count, total, color, style, capitalize }: { label: string; count: number; total: number; color: string; style?: React.CSSProperties; capitalize?: boolean }) {
  const percentage = total > 0 ? (count / total) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className={cn(capitalize && 'capitalize')}>{label}</span>
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={count}>
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${percentage}%`, ...style }} />
      </div>
    </div>
  )
}
