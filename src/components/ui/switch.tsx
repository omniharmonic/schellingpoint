'use client'

/**
 * Accessible toggle switch (button role="switch"; @radix-ui/react-switch is not installed).
 * Controlled: `checked` + `onCheckedChange`. Pair with a visible <Label htmlFor={id}> or `aria-label`.
 *
 *   <Switch id="notify" checked={on} onCheckedChange={setOn} />
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'role'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  size?: 'default' | 'sm'
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, onCheckedChange, disabled, size = 'default', onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onCheckedChange(!checked)
      }}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'default' ? 'h-6 w-11' : 'h-5 w-9',
        checked ? 'bg-primary' : 'bg-input',
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-transform',
          size === 'default' ? 'h-5 w-5' : 'h-4 w-4',
          checked ? (size === 'default' ? 'translate-x-5' : 'translate-x-4') : 'translate-x-0'
        )}
      />
    </button>
  )
)
Switch.displayName = 'Switch'

export { Switch }
