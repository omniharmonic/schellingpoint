'use client'

/**
 * Toggleable filter pill (h-9, rounded-full, aria-pressed). Replaces the four filter-pill idioms.
 * Optional `count` renders a small trailing number.
 *
 *   <FilterChip pressed={f === 'mine'} onClick={() => setF('mine')} count={3}>Mine</FilterChip>
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface FilterChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  pressed: boolean
  count?: number
  icon?: React.ReactNode
}

const FilterChip = React.forwardRef<HTMLButtonElement, FilterChipProps>(
  ({ className, pressed, count, icon, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition-colors ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
        className
      )}
      {...props}
    >
      {icon}
      <span>{children}</span>
      {typeof count === 'number' && (
        <span
          className={cn(
            'rounded-full px-1.5 text-xs tabular-nums',
            pressed ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
)
FilterChip.displayName = 'FilterChip'

export { FilterChip }
