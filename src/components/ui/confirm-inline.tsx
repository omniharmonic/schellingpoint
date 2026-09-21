'use client'

/**
 * Inline confirmation for destructive or irreversible actions — the one vocabulary for
 * "are you sure?" (replaces native confirm() and the four ad-hoc patterns).
 * Always renders Cancel (outline) on the left and a verb button on the right.
 *
 *   {confirming ? (
 *     <ConfirmInline
 *       message="Withdraw this proposal? Votes on it are discarded."
 *       confirmLabel="Withdraw"
 *       destructive
 *       loading={busy}
 *       onConfirm={withdraw}
 *       onCancel={() => setConfirming(false)}
 *     />
 *   ) : (…)}
 *
 * Focus moves to Cancel on mount; Escape cancels.
 */

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ConfirmInlineProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  message: React.ReactNode
  /** A verb: "Delete", "Withdraw", "Clear day". */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  destructive?: boolean
  loading?: boolean
  cancelLabel?: string
  /** Stack buttons under the message (default) or lay everything out in one row. */
  layout?: 'stacked' | 'inline'
}

const ConfirmInline = React.forwardRef<HTMLDivElement, ConfirmInlineProps>(
  (
    {
      message,
      confirmLabel,
      onConfirm,
      onCancel,
      destructive,
      loading,
      cancelLabel = 'Cancel',
      layout = 'stacked',
      className,
      onKeyDown,
      ...props
    },
    ref
  ) => {
    const cancelRef = React.useRef<HTMLButtonElement>(null)
    React.useEffect(() => {
      cancelRef.current?.focus()
    }, [])

    return (
      <div
        ref={ref}
        role="alertdialog"
        aria-live="assertive"
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.key === 'Escape' && !loading) {
            e.stopPropagation()
            onCancel()
          }
        }}
        className={cn(
          'rounded-xl border p-3 text-sm',
          destructive ? 'border-destructive/20 bg-destructive/10' : 'border-border bg-muted',
          layout === 'inline' ? 'flex flex-wrap items-center gap-3' : 'flex flex-col gap-3',
          className
        )}
        {...props}
      >
        <p className={cn('leading-relaxed', layout === 'inline' && 'flex-1 min-w-[12rem]')}>{message}</p>
        <div className="flex items-center justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    )
  }
)
ConfirmInline.displayName = 'ConfirmInline'

export { ConfirmInline }
