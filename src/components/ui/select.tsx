'use client'

/**
 * Native <select> styled to match <Input> (h-11, rounded-xl, border-input) with a chevron.
 * Replaces the six hand-written select class strings. Use with <Label htmlFor>.
 *
 *   <Select value={v} onChange={(e) => setV(e.target.value)} error={!!err}>
 *     <option value="a">A</option>
 *   </Select>
 */

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean
  /** Class for the outer wrapper (width, margins). `className` goes on the <select> itself. */
  wrapperClassName?: string
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, error, children, ...props }, ref) => (
    <div className={cn('relative w-full', wrapperClassName)}>
      <select
        ref={ref}
        className={cn(
          'flex h-11 w-full appearance-none rounded-xl border border-input bg-background pl-3 pr-10 py-2 text-sm ring-offset-background transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-destructive focus-visible:ring-destructive',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
)
Select.displayName = 'Select'

export { Select }
