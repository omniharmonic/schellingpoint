/**
 * The one page header for workspace and admin pages (spec §2.1). Uses `.page-title`
 * (text-2xl md:text-3xl font-display font-semibold tracking-tight) so pages stop fighting
 * the old global h1 clamp. Server-safe (no client hooks).
 *
 *   <PageHeader
 *     eyebrow="Organizer workspace"
 *     title="Overview & sessions"
 *     subtitle={event.tagline}
 *     actions={<Button>Add a session</Button>}
 *   />
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  /** Small muted label above the title ("Organizer workspace", a gathering name, a date). */
  eyebrow?: React.ReactNode
  /** Heading level; defaults to h1. */
  as?: 'h1' | 'h2'
}

export function PageHeader({ title, subtitle, actions, eyebrow, as: Heading = 'h1', className, ...props }: PageHeaderProps) {
  return (
    <div
      className={cn('mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between', className)}
      {...props}
    >
      <div className="min-w-0 flex-1">
        {eyebrow && <p className="mb-1 text-sm font-medium text-muted-foreground">{eyebrow}</p>}
        <Heading className="page-title text-balance">{title}</Heading>
        {subtitle && <p className="mt-2 max-w-2xl text-base leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div>}
    </div>
  )
}
