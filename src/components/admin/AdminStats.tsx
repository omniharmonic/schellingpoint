'use client'

import {
  FileText,
  CheckCircle2,
  Calendar,
  XCircle,
  MapPin,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface AdminStatsProps {
  pending: number
  approved: number
  scheduled: number
  rejected: number
  venues: number
  timeSlots: number
}

type Tone = 'neutral' | 'amber' | 'emerald' | 'primary' | 'muted'

interface Stat {
  label: string
  value: number
  icon: React.ReactNode
  tone: Tone
  hint?: string
}

export function AdminStats({
  pending,
  approved,
  scheduled,
  rejected,
  venues,
  timeSlots,
}: AdminStatsProps) {
  // Primary KPIs — most operationally relevant
  const primary: Stat[] = [
    {
      label: 'Pending review',
      value: pending,
      icon: <FileText className="h-4 w-4" />,
      tone: pending > 0 ? 'amber' : 'muted',
      hint: pending > 0 ? 'Needs review' : undefined,
    },
    {
      label: 'Approved',
      value: approved,
      icon: <CheckCircle2 className="h-4 w-4" />,
      tone: approved > 0 ? 'emerald' : 'muted',
    },
    {
      label: 'Scheduled',
      value: scheduled,
      icon: <Calendar className="h-4 w-4" />,
      tone: 'primary',
    },
    {
      label: 'Rejected',
      value: rejected,
      icon: <XCircle className="h-4 w-4" />,
      tone: 'muted',
    },
  ]

  // Supporting stats — infrastructure metadata
  const secondary: Stat[] = [
    {
      label: 'Venues',
      value: venues,
      icon: <MapPin className="h-4 w-4" />,
      tone: 'neutral',
    },
    {
      label: 'Time slots',
      value: timeSlots,
      icon: <Clock className="h-4 w-4" />,
      tone: 'neutral',
    },
  ]

  return (
    <section className="rounded-2xl border border-foreground/20 bg-card stats-card">
      {/* Primary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-border">
        {primary.map((stat) => (
          <StatCell key={stat.label} {...stat} />
        ))}
      </div>
      {/* Secondary row with venues / slots */}
      <div className="border-t grid grid-cols-2 divide-x divide-border">
        {secondary.map((stat) => (
          <StatCell key={stat.label} {...stat} compact />
        ))}
      </div>
    </section>
  )
}

function StatCell({
  label,
  value,
  icon,
  tone,
  hint,
  compact = false,
}: Stat & { compact?: boolean }) {
  const toneStyles: Record<Tone, { text: string; bg: string; dot: string }> = {
    neutral: {
      text: 'text-foreground',
      bg: 'bg-muted/30',
      dot: 'bg-muted-foreground/40',
    },
    amber: {
      text: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-500/5',
      dot: 'bg-amber-500',
    },
    emerald: {
      text: 'text-emerald-600 dark:text-emerald-400',
      bg: 'bg-emerald-500/5',
      dot: 'bg-emerald-500',
    },
    primary: {
      text: 'text-primary',
      bg: 'bg-primary/5',
      dot: 'bg-primary',
    },
    muted: {
      text: 'text-muted-foreground',
      bg: 'bg-transparent',
      dot: 'bg-muted-foreground/30',
    },
  }
  const styles = toneStyles[tone]

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 transition-colors',
        compact ? 'md:py-2.5' : 'md:py-4'
      )}
    >
      <span
        className={cn(
          'flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg',
          styles.bg,
          styles.text
        )}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'font-semibold tabular-nums',
              compact ? 'text-2xl' : 'text-4xl tracking-tight'
            )}
          >
            {value}
          </span>
          {hint && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium tracking-wide text-amber-600 dark:text-amber-400">
              <span className={cn('h-1.5 w-1.5 rounded-full', styles.dot)} />
              {hint}
            </span>
          )}
        </div>
        <p
          className={cn(
            'text-xs text-muted-foreground truncate',
            compact ? 'mt-0' : 'mt-0.5'
          )}
        >
          {label}
        </p>
      </div>
    </div>
  )
}
