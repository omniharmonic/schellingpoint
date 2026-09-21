'use client'

/**
 * A Badge with a real remove <button aria-label="Remove {label}"> (≥24px hit area).
 * Use for tags, selected tracks, invited emails. Replaces the seven ad-hoc chip styles.
 *
 *   <RemovableChip label="Governance" onRemove={() => drop('Governance')} />
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface RemovableChipProps extends Omit<BadgeProps, 'children'> {
  label: string
  onRemove: () => void
  disabled?: boolean
  /** Accessible name for the button; defaults to "Remove {label}". */
  removeLabel?: string
}

const RemovableChip = React.forwardRef<HTMLDivElement, RemovableChipProps>(
  ({ label, onRemove, disabled, removeLabel, className, variant = 'secondary', ...props }, ref) => (
    <Badge ref={ref} variant={variant} className={cn('gap-1 py-0.5 pl-2.5 pr-0.5', className)} {...props}>
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={removeLabel ?? `Remove ${label}`}
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full opacity-70 transition-colors hover:bg-foreground/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Badge>
  )
)
RemovableChip.displayName = 'RemovableChip'

export { RemovableChip }
