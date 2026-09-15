'use client'

import * as React from 'react'
import { BarChart3, Calendar, FileText, Loader2, Lock, ThumbsUp, Users } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
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

export default function AdminAnalyticsPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const [data, setData] = React.useState<Analytics | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [showAllResults, setShowAllResults] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    apiFetch<Analytics>(`/api/v1/events/${event.slug}/admin/overview/analytics`)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'Analytics could not be loaded.') })
    return () => { cancelled = true }
  }, [event.slug])

  if (!can('viewAnalytics')) {
    return <Card><CardContent className="py-8 text-center text-muted-foreground">Your role does not include analytics.</CardContent></Card>
  }
  if (error) return <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>
  if (!data) {
    return <div className="flex items-center justify-center py-12" role="status" aria-label="Loading analytics"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  const { proposals, members, schedule, voting } = data
  const results = voting.sealed ? [] : voting.results
  const totalBallotVotes = results.reduce((sum, r) => sum + r.votes, 0)
  const shownResults = showAllResults ? results : results.slice(0, 10)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Analytics</h1>
        <p className="text-sm text-muted-foreground">How the program is shaping up. Visible to organizers only.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Proposals" value={proposals.total} icon={<FileText className="h-4 w-4" />} description={`${proposals.approvalRate}% approved or scheduled`} />
        <StatCard title="Members" value={members.total} icon={<Users className="h-4 w-4" />} description={`${Object.keys(members.byRole).length} role${Object.keys(members.byRole).length === 1 ? '' : 's'}`} />
        <StatCard title="Schedule" value={`${schedule.utilization}%`} icon={<Calendar className="h-4 w-4" />} description={`${schedule.filledSlots}/${schedule.sessionSlots} slots filled`} />
        <StatCard
          title="Voting"
          value={voting.sealed ? 'Sealed' : voting.status === 'none' ? '—' : totalBallotVotes}
          icon={voting.sealed ? <Lock className="h-4 w-4" /> : <ThumbsUp className="h-4 w-4" />}
          description={voting.sealed ? 'Results open when the round closes' : voting.status === 'none' ? 'No voting round yet' : 'Votes in the closed round'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ThumbsUp className="h-5 w-5" />Voting results</CardTitle>
          <CardDescription>For organizers planning the program. Never shown to attendees as a ranking.</CardDescription>
        </CardHeader>
        <CardContent>
          {voting.sealed ? (
            <div role="status" className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
              <Lock className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" aria-hidden />
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
                <button type="button" onClick={() => setShowAllResults((v) => !v)} className="mt-3 text-sm text-primary hover:underline">
                  {showAllResults ? 'Show fewer' : `Show all ${results.length}`}
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />Proposal status</CardTitle>
            <CardDescription>Breakdown by status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <StatusBar label="Scheduled" count={proposals.byStatus.scheduled} total={proposals.total} color="bg-green-500" />
            <StatusBar label="Approved" count={proposals.byStatus.approved} total={proposals.total} color="bg-blue-500" />
            <StatusBar label="Pending" count={proposals.byStatus.pending} total={proposals.total} color="bg-amber-500" />
            <StatusBar label="Rejected" count={proposals.byStatus.rejected} total={proposals.total} color="bg-red-500" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" />By track</CardTitle>
            <CardDescription>Proposals per track</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {proposals.byTrack.length === 0 ? <p className="text-sm text-muted-foreground">No tracks yet.</p> : proposals.byTrack.map((t) => (
              <StatusBar key={t.id ?? 'none'} label={t.name} count={t.count} total={proposals.total} color="bg-primary" style={t.color ? { backgroundColor: t.color } : undefined} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />By format</CardTitle>
            <CardDescription>Session types</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {proposals.byFormat.length === 0 ? <p className="text-sm text-muted-foreground">No proposals yet.</p> : proposals.byFormat.map((f) => (
              <StatusBar key={f.format} label={f.format} count={f.count} total={proposals.total} color="bg-primary" />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Calendar className="h-5 w-5" />Room use</CardTitle>
            <CardDescription>Scheduled sessions per room</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {schedule.venues.length === 0 ? <p className="text-sm text-muted-foreground">No rooms yet.</p> : schedule.venues.map((v) => (
              <div key={v.id} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{v.name}</span>
                  <span className="text-muted-foreground">{v.sessions}/{v.slots} ({v.utilization}%)</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden" role="progressbar" aria-label={`${v.name} utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.utilization}>
                  <div className={cn('h-full rounded-full transition-all', v.utilization >= 80 ? 'bg-green-500' : v.utilization >= 50 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${v.utilization}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" />Members by role</CardTitle>
            <CardDescription>Who has joined this gathering</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              {Object.entries(members.byRole).map(([role, count]) => (
                <div key={role} className="flex items-center gap-2 bg-muted rounded-lg px-4 py-2">
                  <span className="capitalize font-medium">{role.replace('_', ' ')}</span>
                  <span className="text-muted-foreground">{count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
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
            <p className="text-2xl font-bold mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          </div>
          <div className="p-3 bg-primary/10 rounded-full" aria-hidden>{icon}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBar({ label, count, total, color, style }: { label: string; count: number; total: number; color: string; style?: React.CSSProperties }) {
  const percentage = total > 0 ? (count / total) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="capitalize">{label}</span>
        <span className="text-muted-foreground">{count}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${percentage}%`, ...style }} />
      </div>
    </div>
  )
}
