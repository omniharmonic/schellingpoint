'use client'

/**
 * Progress of a queued network publish (`publish_jobs`). Polls `statusUrl` (an endpoint answering
 * `{ job }`) every two seconds until the job succeeds, fails or is cancelled, then calls `onDone`.
 * A rate-limited job is shown as waiting, not failed: it resumes on its own.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { apiFetch } from '@/lib/api/client'

export interface PublishJobView {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  total: number
  position: number
  published: number
  skipped: number
  failed: number
  lastError: string | null
  runAfter: string
  results: Array<{ kind: string; id: string; uri?: string; error?: string; skipped?: string }>
}

const POLL_MS = 2000

export function PublishJobProgress({ statusUrl, onDone }: { statusUrl: string; onDone?: (job: PublishJobView) => void }) {
  const [job, setJob] = React.useState<PublishJobView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const doneRef = React.useRef(onDone)
  doneRef.current = onDone

  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const { job: next } = await apiFetch<{ job: PublishJobView }>(statusUrl, { cache: 'no-store' })
        if (stopped) return
        setJob(next)
        setError(null)
        if (next.status === 'succeeded' || next.status === 'failed' || next.status === 'cancelled') {
          doneRef.current?.(next)
          return
        }
      } catch {
        if (!stopped) setError('Could not read the publish progress; retrying.')
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [statusUrl])

  const total = job?.total ?? 0
  const pct = total ? Math.round(((job?.position ?? 0) / total) * 100) : 0
  const waiting = job?.status === 'queued' && job.lastError?.startsWith('rate limited')
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm">
        {job?.status === 'queued' || job?.status === 'running' || !job ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        <span>
          {!job ? 'Starting the network publish…'
            : job.status === 'succeeded' ? `Network publish finished: ${job.published} written, ${job.failed} failed${job.skipped ? `, ${job.skipped} skipped` : ''}.`
            : job.status === 'failed' ? `Network publish stopped: ${job.lastError ?? 'unknown error'}`
            : job.status === 'cancelled' ? 'Network publish cancelled.'
            : waiting ? `The network is pacing this gathering’s writes; resuming at ${new Date(job.runAfter).toLocaleTimeString()}.`
            : `Writing to the network: ${job.position} of ${total} sessions…`}
        </span>
      </div>
      {job && total > 0 ? <Progress value={pct} aria-label={`${pct}% published`} /> : null}
      {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
    </div>
  )
}
