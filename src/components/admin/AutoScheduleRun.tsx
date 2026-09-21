'use client'

/**
 * The run view of the auto-schedule dialog (PRD §4.7 steps 5–6): the five stages as a
 * checklist, the quality score with its checks and warnings, and the local-search summary.
 * The server computes everything in one request, so while it runs the stages show as
 * pending and the first spins; when the result arrives every stage is done with its detail.
 */
import * as React from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { QualityScore, type QualityReport } from '@/components/admin/ScheduleQuality'

export interface SchedulerStage {
  key: 'clusters' | 'venues' | 'slots' | 'conflicts' | 'validation'
  name: string
  status: 'done'
  detail: string
}

export interface HillClimbStats {
  passes: number
  evaluations: number
  moves: number
  swaps: number
  elapsedMs: number
  stoppedBy: 'converged' | 'budget' | 'maxPasses' | 'nothingToMove'
  seedCost: { total: number }
  finalCost: { total: number }
}

/** The stage names the PRD shows; mirrors SCHEDULER_STAGE_NAMES in the server library. */
export const STAGE_NAMES: ReadonlyArray<{ key: SchedulerStage['key']; name: string }> = [
  { key: 'clusters', name: 'Analyzing voter clusters' },
  { key: 'venues', name: 'Calculating venue requirements' },
  { key: 'slots', name: 'Optimizing time slot assignments' },
  { key: 'conflicts', name: 'Resolving conflicts' },
  { key: 'validation', name: 'Final validation' },
]

export function improvementSummary(stats: HillClimbStats): string {
  if (stats.stoppedBy === 'nothingToMove') return 'Nothing to improve: every session was already placed by hand.'
  const seconds = stats.elapsedMs >= 1000 ? `${(stats.elapsedMs / 1000).toFixed(1)} s` : `${Math.max(1, Math.round(stats.elapsedMs))} ms`
  const effort = `${plural(stats.passes, 'pass', 'passes')}, ${seconds}`
  if (stats.moves + stats.swaps === 0) return `Hill-climb found nothing better than the first draft (${effort}).`
  const ended =
    stats.stoppedBy === 'converged' ? 'until nothing improved'
      : stats.stoppedBy === 'budget' ? 'until the time budget ran out'
        : 'until the pass limit'
  return `Hill-climb moved ${plural(stats.moves, 'session')} and swapped ${plural(stats.swaps, 'pair')} ${ended} (${effort}).`
}

export function StageChecklist({ stages, running }: { stages: SchedulerStage[] | null; running: boolean }) {
  const byKey = new Map((stages ?? []).map((s) => [s.key, s]))
  return (
    <ol className="space-y-1.5" aria-label="Scheduling stages" data-testid="scheduler-stages">
      {STAGE_NAMES.map((stage, i) => {
        const done = byKey.get(stage.key)
        const active = running && !done && i === 0
        return (
          <li key={stage.key} className="flex items-start gap-2 text-sm">
            <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full', done ? 'bg-success text-success-foreground' : 'text-muted-foreground')} aria-hidden="true">
              {done ? <Check className="h-3 w-3" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Circle className="h-3 w-3" />}
            </span>
            <span className="min-w-0">
              <span className={cn('font-medium', !done && 'text-muted-foreground')}>{stage.name}</span>
              {done?.detail && <span className="block text-xs text-muted-foreground">{done.detail}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

interface Props {
  running: boolean
  stages: SchedulerStage[] | null
  quality: QualityReport | null
  improvement: HillClimbStats | null
  usedBallots: boolean
}

export function AutoScheduleRun({ running, stages, quality, improvement, usedBallots }: Props) {
  return (
    <div className="space-y-4">
      <StageChecklist stages={stages} running={running} />
      {quality && <QualityScore quality={quality} usedBallots={usedBallots} />}
      {improvement && <p className="text-xs text-muted-foreground" data-testid="improvement-summary">{improvementSummary(improvement)}</p>}
    </div>
  )
}
