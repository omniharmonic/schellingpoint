/**
 * Bordered warning block (amber via --signal-amber) for irreversible or attention-worthy
 * settings: "Take ownership", "Publishing makes this visible to everyone", quota warnings.
 * Not for errors (use the inline error box) and not for success (use Alert success).
 *
 *   <WarningBox title="This cannot be undone">
 *     Taking ownership moves the gathering to your account.
 *     <Button variant="destructive" className="mt-3">Take ownership</Button>
 *   </WarningBox>
 */

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface WarningBoxProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode
  icon?: React.ReactNode
}

export function WarningBox({ title, icon, children, className, ...props }: WarningBoxProps) {
  return (
    <div
      className={cn('flex gap-3 rounded-xl border border-signal-amber/30 bg-signal-amber/10 p-4 text-sm', className)}
      {...props}
    >
      <div className="mt-0.5 shrink-0 text-signal-amber">
        {icon ?? <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 leading-relaxed">
        {title && <p className="mb-1 font-semibold text-foreground">{title}</p>}
        <div className="text-foreground/90">{children}</div>
      </div>
    </div>
  )
}
