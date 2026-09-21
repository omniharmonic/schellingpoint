/**
 * The state shown after a mutation that changes where the user should go next
 * (proposal submitted, gathering created, ticket confirmed). One primary and an optional
 * secondary action; nothing auto-navigates. Uses the `--success` token.
 *
 *   <SuccessPanel
 *     title="Your session is proposed"
 *     body="Organizers review proposals before voting opens."
 *     primary={<Button asChild><Link href={url}>View your session</Link></Button>}
 *     secondary={<Button asChild variant="outline"><Link href={list}>All sessions</Link></Button>}
 *   />
 */

import * as React from 'react'
import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SuccessPanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode
  body?: React.ReactNode
  /** Defaults to a check-circle icon. */
  icon?: React.ReactNode
  primary?: React.ReactNode
  secondary?: React.ReactNode
}

export function SuccessPanel({ title, body, icon, primary, secondary, className, ...props }: SuccessPanelProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center rounded-2xl border border-success/30 bg-success/5 px-6 py-10 text-center',
        className
      )}
      {...props}
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
        {icon ?? <CheckCircle2 className="h-7 w-7" aria-hidden="true" />}
      </div>
      <h2 className="font-display text-xl font-semibold tracking-tight text-balance">{title}</h2>
      {body && <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>}
      {(primary || secondary) && (
        <div className="mt-6 flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-center">
          {secondary}
          {primary}
        </div>
      )}
    </div>
  )
}
