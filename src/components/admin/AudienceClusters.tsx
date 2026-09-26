'use client'

/**
 * Audience clusters (release design §9.3, PRD §4.7 step 3): the organizer's pre-run view of
 * which sessions share an audience. "Keep apart" pairs at or above 60% shared voters, "fine
 * together" sets under 20%, and how many pairs were not shown because a side had fewer than k
 * voters. Percentages and counts only, never people: the server suppresses anything under k.
 */
import * as React from 'react'
import { AlertTriangle, ChevronDown, Lock, Loader2, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { RoundStatus } from '@/components/admin/types'

interface ClusterSession {
  id: string
  title: string
}

export interface AudienceClustersResponse {
  roundId: string | null
  k: number
  thresholds: { keepApartPercent: number; fineTogetherPercent: number }
  keepApart: Array<{ a: ClusterSession; b: ClusterSession; overlapPercent: number; sharedVoters: number | null }>
  fineTogether: Array<{ sessions: ClusterSession[]; maxOverlapPercent: number }>
  comparableSessions: number
  suppressed: { pairs: number; sessions: number }
}

type State =
  | { kind: 'loading' }
  | { kind: 'round-open' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AudienceClustersResponse }

interface Props {
  /** `/api/v1/events/[slug]` */
  base: string
  votingStatus: RoundStatus
  /** Bump to reload (after a round closes, or sessions change). */
  refreshKey?: number
  className?: string
}

export function AudienceClusters({ base, votingStatus, refreshKey = 0, className }: Props) {
  const [open, setOpen] = React.useState(false)
  const [retry, setRetry] = React.useState(0)
  const [state, setState] = React.useState<State>(votingStatus === 'open' ? { kind: 'round-open' } : { kind: 'loading' })

  React.useEffect(() => {
    if (votingStatus === 'open') {
      setState({ kind: 'round-open' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    apiFetch<AudienceClustersResponse>(`${base}/admin/audience-clusters`)
      .then((data) => { if (!cancelled) setState({ kind: 'ready', data }) })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && (e.code === 'RoundOpen' || e.status === 409)) setState({ kind: 'round-open' })
        else setState({ kind: 'error', message: e instanceof ApiError ? e.message : 'Audience clusters could not be loaded.' })
      })
    return () => { cancelled = true }
  }, [base, votingStatus, refreshKey, retry])

  const data = state.kind === 'ready' ? state.data : null
  const noBallots = data !== null && data.roundId === null
  const summary = (() => {
    if (state.kind === 'loading') return 'Loading…'
    if (state.kind === 'round-open') return 'Available after voting closes'
    if (state.kind === 'error') return 'Could not load'
    if (!data) return ''
    if (noBallots) return 'No ballots yet'
    if (data.comparableSessions === 0) return 'Not enough voters to compare any pair'
    const parts = [plural(data.keepApart.length, 'keep-apart pair'), plural(data.fineTogether.length, 'fine-together set')]
    if (data.suppressed.pairs > 0) parts.push(`${plural(data.suppressed.pairs, 'pair')} not shown`)
    return parts.join(' · ')
  })()
  const attention = data !== null && data.keepApart.length > 0
  const panelId = 'audience-clusters-panel'

  return (
    <section aria-labelledby="audience-clusters-heading" className={cn('rounded-xl border bg-card', className)} data-testid="audience-clusters">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 p-3 sm:p-4 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Users className={cn('h-4 w-4 shrink-0', attention ? 'text-signal-amber' : 'text-muted-foreground')} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span id="audience-clusters-heading" className="block font-semibold text-sm">Audience clusters</span>
          <span className="block text-xs text-muted-foreground truncate">{summary}</span>
        </span>
        {attention && <Badge variant="amber" className="hidden sm:inline-flex shrink-0">{plural(data!.keepApart.length, 'pair')} to keep apart</Badge>}
        {state.kind === 'loading' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />}
      </button>

      <div id={panelId} hidden={!open} className="border-t px-3 py-3 sm:px-4 sm:py-4 text-sm">
        {state.kind === 'round-open' && (
          <div className="flex items-start gap-3 text-muted-foreground">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium text-foreground">Voting is still open</p>
              <p className="mt-0.5">Audience overlap is computed from ballots, which stay sealed until the round closes. Until then you can place sessions by hand, and auto-schedule uses durations, rooms, preferences and tracks only.</p>
            </div>
          </div>
        )}
        {state.kind === 'error' && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-destructive">
            <p>{state.message}</p>
            <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>
          </div>
        )}
        {state.kind === 'loading' && <p className="text-muted-foreground">Comparing ballots…</p>}
        {data && noBallots && (
          <div className="text-muted-foreground">
            <p className="font-medium text-foreground">No ballots yet</p>
            <p className="mt-0.5">Nobody has voted in a closed round, so there is nothing to compare. Auto-schedule still works: it uses durations, host availability, rooms and tracks. Once a voting round closes it also keeps sessions with a shared audience apart, orders by demand and sizes rooms to it.</p>
          </div>
        )}
        {data && !noBallots && data.comparableSessions === 0 && (
          <p className="text-muted-foreground">
            Every voted-for session has fewer than {plural(data.k, 'voter')}, so no pair can be compared without risking someone’s privacy. Auto-schedule still runs on durations, rooms, preferences and tracks.
          </p>
        )}
        {data && !noBallots && data.comparableSessions > 0 && (
          <div className="space-y-4">
            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-signal-amber">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />Keep apart · {data.thresholds.keepApartPercent}% or more shared voters
              </h3>
              {data.keepApart.length === 0 ? (
                <p className="mt-1.5 text-muted-foreground">No two sessions share that much of an audience. Anything can run at the same time as far as ballots are concerned.</p>
              ) : (
                <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {data.keepApart.map((p) => (
                    <li key={`${p.a.id}|${p.b.id}`} className="min-w-0 overflow-hidden rounded-lg border border-signal-amber/40 bg-signal-amber/5 p-3">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium truncate flex-1 min-w-0" title={p.a.title}>{p.a.title}</span>
                        <Badge variant="amber" className="shrink-0 tabular-nums">{p.overlapPercent}%</Badge>
                        <span className="font-medium truncate flex-1 min-w-0 text-right" title={p.b.title}>{p.b.title}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Put these in different time slots.{p.sharedVoters !== null ? ` ${plural(p.sharedVoters, 'voter')} chose both.` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-success">Fine together · under {data.thresholds.fineTogetherPercent}% shared</h3>
              {data.fineTogether.length === 0 ? (
                <p className="mt-1.5 text-muted-foreground">No set of sessions is clearly safe to run side by side yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {data.fineTogether.map((g, i) => (
                    <li key={i} className="rounded-lg border border-success/30 bg-success/5 p-3">
                      <div className="flex flex-wrap gap-1.5">
                        {g.sessions.map((s) => <Badge key={s.id} variant="outline" className="max-w-full"><span className="truncate">{s.title}</span></Badge>)}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">Can run at the same time · at most {g.maxOverlapPercent}% shared between any two.</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {plural(data.comparableSessions, 'session')} compared.
              {data.suppressed.pairs > 0 && ` ${plural(data.suppressed.pairs, 'pair')} not shown — fewer than ${data.k} voters on one side.`}
              {' '}Percentages compare anonymous ballots, never people.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
