/**
 * The one sticky group heading for the schedule (mobile shell design §4): a time band, a venue,
 * or the "Not yet scheduled" tail. Replaces the two near-identical copies the Schedule and My
 * schedule pages each carried.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface GroupHeadingProps {
  icon?: React.ReactNode
  children: React.ReactNode
  /** A count or a range, at the end of the rule. */
  trailing?: React.ReactNode
  className?: string
}

export function GroupHeading({ icon, children, trailing, className }: GroupHeadingProps) {
  return (
    <div
      className={cn(
        'sticky-under-header z-10 -mx-4 mb-2 bg-background/95 px-4 py-1.5 backdrop-blur-sm sm:mx-0 sm:px-0',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          {icon}
          <span>{children}</span>
        </h2>
        <div className="h-px flex-1 bg-border" aria-hidden />
        {trailing}
      </div>
    </div>
  )
}
