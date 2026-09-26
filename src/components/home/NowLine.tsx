'use client'

/**
 * The Now line (mobile shell design §1, §3.1): the one bold element on Home. One sentence in the
 * display weight saying where the gathering is right now and what the person can do about it, a
 * quieter second line with the two counts that used to be stat tiles, and nothing else.
 *
 * It is also the only motion on the page: while a round is open the countdown ticks. Under
 * `prefers-reduced-motion: reduce` it drops to minute precision and stops animating (the label
 * still refreshes, once a minute, because a stale countdown is worse than a still one).
 *
 * The copy itself is `describeNow` in `./now-line`, which is pure and has no React in it.
 */

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeNow, type NowLineInput } from './now-line'

export type { NowLineCopy, NowLineInput, NowState } from './now-line'
export { describeNow, formatCountdown } from './now-line'

/** True while the viewer asked for less motion. Re-reads on change. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function NowLine({ input, className }: { input: NowLineInput; className?: string }) {
  const reduced = useReducedMotion()
  const precision = reduced ? 'minute' : 'second'
  const [now, setNow] = React.useState(() => Date.now())
  const copy = describeNow(input, now, precision)

  React.useEffect(() => {
    if (!copy.ticking) return
    const every = reduced ? 30_000 : 1_000
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [copy.ticking, reduced])

  return (
    <section
      aria-label="Right now"
      data-testid="now-line"
      data-now-state={copy.state}
      className={cn('border-b pb-5', className)}
    >
      <p
        className="font-display text-2xl font-bold leading-tight tracking-tight text-balance sm:text-3xl"
        aria-live={copy.ticking ? 'off' : undefined}
      >
        {copy.headline}
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {copy.second && <p className="text-sm text-muted-foreground">{copy.second}</p>}
        {copy.action && (
          <Link
            href={copy.action.href}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {copy.action.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </section>
  )
}
