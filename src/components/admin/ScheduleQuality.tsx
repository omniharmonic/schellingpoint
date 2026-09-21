'use client'

/**
 * Schedule quality (release design §9.3, PRD §4.7 steps 6–7): the 0–100 score with its two
 * checks and warnings, a toolbar chip, and the debounced live check the builder runs after
 * every draft change. Everything here renders counts and percentages only — the server never
 * sends voters.
 */
import * as React from 'react'
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface QualityConflict {
  a: string
  b: string
  overlapPercent: number
  kind: 'keepApart' | 'nearMiss'
}

/** Mirrors `QualityReport` in src/lib/scheduling/quality.ts (server-only). */
export interface QualityReport {
  score: number
  conflictPeople: number
  totalVoterSessionPairs: number
  overCapacityPeople: number
  totalDemand: number
  violations: string[]
  warnings: string[]
  keepApartConflicts: number
  conflicts: QualityConflict[]
  checks: { noKeepApartConflicts: boolean; constraintsMet: boolean }
  placed: number
}

export interface DraftAssignment {
  sessionId: string
  slotId: string
  venueId?: string | null
}

export type ScoreTone = 'success' | 'amber' | 'destructive'

export function scoreTone(score: number): ScoreTone {
  return score >= 80 ? 'success' : score >= 50 ? 'amber' : 'destructive'
}

const TONE_TEXT: Record<ScoreTone, string> = { success: 'text-success', amber: 'text-signal-amber', destructive: 'text-destructive' }

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-success" aria-hidden="true" /> : <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" aria-hidden="true" />}
      <span>
        <span className={cn('font-medium', ok ? '' : 'text-destructive')}>{label}</span>
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
      </span>
    </li>
  )
}

/** The review block: big score, the two PRD checks, then warnings. */
export function QualityScore({ quality, className, usedBallots = true }: { quality: QualityReport; className?: string; usedBallots?: boolean }) {
  const [showAll, setShowAll] = React.useState(false)
  const tone = scoreTone(quality.score)
  const issues = [...quality.violations, ...quality.warnings]
  const shown = showAll ? issues : issues.slice(0, 5)
  return (
    <div className={cn('rounded-xl border bg-card p-4', className)} data-testid="schedule-quality">
      <div className="flex flex-wrap items-start gap-4">
        <div className="shrink-0 text-center min-w-[5.5rem]">
          <div className={cn('stat-value text-4xl font-semibold tabular-nums leading-none', TONE_TEXT[tone])} aria-label={`Quality score ${quality.score} out of 100`}>
            {quality.score}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">Quality · out of 100</div>
        </div>
        <ul className="flex-1 min-w-[12rem] space-y-1.5">
          <Check
            ok={quality.checks.noKeepApartConflicts}
            label={quality.checks.noKeepApartConflicts ? 'No keep-apart conflicts' : plural(quality.keepApartConflicts, 'keep-apart conflict')}
            detail={usedBallots ? (quality.conflictPeople > 0 ? `${plural(quality.conflictPeople, 'voter')} wanted two sessions that overlap` : undefined) : 'no ballots to compare yet'}
          />
          <Check
            ok={quality.checks.constraintsMet}
            label={quality.checks.constraintsMet ? 'All constraints met' : plural(quality.violations.length, 'constraint violation')}
            detail={quality.overCapacityPeople > 0 ? `${plural(quality.overCapacityPeople, 'person')} over room capacity` : undefined}
          />
        </ul>
      </div>
      {issues.length > 0 ? (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-1.5">{plural(issues.length, 'warning')}</p>
          <ul className="space-y-1">
            {shown.map((w, i) => (
              <li key={`${i}-${w}`} className={cn('flex gap-1.5 text-xs', w.startsWith('Keep apart') || quality.violations.includes(w) ? 'text-destructive' : 'text-signal-amber')}>
                <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden="true" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
          {issues.length > 5 && (
            <Button variant="ghost" size="sm" className="mt-1 -ml-2 text-xs" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${issues.length}`}
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">No warnings.</p>
      )}
    </div>
  )
}

/** Toolbar chip: the live score of the draft on the grid. */
export function QualityChip({ quality, loading, onClick }: { quality: QualityReport | null; loading: boolean; onClick?: () => void }) {
  if (!quality && !loading) return null
  const tone = quality ? scoreTone(quality.score) : 'success'
  const issues = quality ? quality.keepApartConflicts + quality.violations.length : 0
  const label = quality
    ? `Draft quality ${quality.score} of 100${issues ? `, ${plural(issues, 'issue')}` : ''}`
    : 'Checking draft quality'
  const content = (
    <Badge
      variant={quality ? (tone === 'success' ? 'success' : tone === 'amber' ? 'amber' : 'destructive') : 'muted'}
      className="gap-1 tabular-nums whitespace-nowrap"
      data-testid="quality-chip"
      aria-label={label}
      title={label}
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : issues > 0 ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
      <span className="hidden sm:inline">Quality</span> {quality ? quality.score : '…'}
    </Badge>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {content}
    </button>
  ) : content
}

export interface DraftQualityState {
  quality: QualityReport | null
  loading: boolean
  /** The round is open (409) or the viewer cannot score: the chip stays hidden. */
  unavailable: boolean
  error: string | null
  /** Session ids in a concurrent keep-apart pair → the partner titles are looked up by the caller. */
  keepApartBySession: Map<string, QualityConflict[]>
}

/**
 * Debounced live check: after every draft change, wait 400 ms, then score the draft on the
 * server. Callers pass `enabled=false` while a round is open (the endpoint answers 409 anyway;
 * we degrade quietly either way).
 */
export function useDraftQuality(base: string, assignments: DraftAssignment[], enabled: boolean, debounceMs = 400, revision = 0): DraftQualityState {
  const [quality, setQuality] = React.useState<QualityReport | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [unavailable, setUnavailable] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const key = React.useMemo(
    () => assignments.map((a) => `${a.sessionId}:${a.slotId}:${a.venueId ?? ''}`).sort().join(','),
    [assignments],
  )
  const latest = React.useRef(0)

  React.useEffect(() => {
    if (!enabled) {
      setQuality(null)
      setLoading(false)
      return
    }
    const seq = ++latest.current
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const body = key ? key.split(',').map((k) => { const [sessionId, slotId, venueId] = k.split(':'); return { sessionId, slotId, ...(venueId ? { venueId } : {}) } }) : []
        const res = await apiFetch<{ quality: QualityReport }>(`${base}/admin/schedule-quality`, { method: 'POST', json: { assignments: body } })
        if (seq !== latest.current) return
        setQuality(res.quality)
        setUnavailable(false)
        setError(null)
      } catch (e) {
        if (seq !== latest.current) return
        if (e instanceof ApiError && (e.code === 'RoundOpen' || e.status === 409 || e.status === 403)) {
          setUnavailable(true)
          setQuality(null)
        } else {
          setError(e instanceof ApiError ? e.message : 'The draft could not be scored.')
        }
      } finally {
        if (seq === latest.current) setLoading(false)
      }
    }, debounceMs)
    return () => window.clearTimeout(timer)
  }, [base, key, enabled, debounceMs, revision])

  const keepApartBySession = React.useMemo(() => {
    const map = new Map<string, QualityConflict[]>()
    for (const c of quality?.conflicts ?? []) {
      if (c.kind !== 'keepApart') continue
      map.set(c.a, [...(map.get(c.a) ?? []), c])
      map.set(c.b, [...(map.get(c.b) ?? []), c])
    }
    return map
  }, [quality])

  return { quality, loading, unavailable, error, keepApartBySession }
}
