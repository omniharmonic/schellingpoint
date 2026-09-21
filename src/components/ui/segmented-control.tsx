'use client'

/**
 * Segmented control: a radiogroup of 2–5 mutually exclusive options with roving focus
 * (Left/Right/Home/End). Replaces the two hand-rolled segmented controls.
 *
 *   <SegmentedControl
 *     aria-label="View"
 *     value={view}
 *     onValueChange={setView}
 *     options={[{ value: 'list', label: 'List' }, { value: 'grid', label: 'Grid', icon: <Grid/> }]}
 *   />
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'role'> {
  value: T
  onValueChange: (value: T) => void
  options: ReadonlyArray<SegmentedOption<T>>
  size?: 'default' | 'sm'
  /** Stretch segments to fill the container. */
  fullWidth?: boolean
}

function SegmentedControlInner<T extends string>(
  { value, onValueChange, options, size = 'default', fullWidth, className, ...props }: SegmentedControlProps<T>,
  ref: React.ForwardedRef<HTMLDivElement>
) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)
    if (enabled.length === 0) return
    const pos = enabled.indexOf(index)
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(pos + 1) % enabled.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(pos - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (next === null) return
    e.preventDefault()
    refs.current[next]?.focus()
    onValueChange(options[next].value)
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-xl bg-muted p-1',
        fullWidth && 'flex w-full',
        className
      )}
      {...props}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={opt.disabled}
            onClick={() => onValueChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
              size === 'default' ? 'h-9 px-3 text-sm' : 'h-8 px-2.5 text-xs',
              fullWidth && 'flex-1',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

const SegmentedControl = React.forwardRef(SegmentedControlInner) as <T extends string>(
  props: SegmentedControlProps<T> & { ref?: React.ForwardedRef<HTMLDivElement> }
) => React.ReactElement
;(SegmentedControl as unknown as { displayName: string }).displayName = 'SegmentedControl'

export { SegmentedControl }
