'use client'

import {
  FileText,
  CheckCircle2,
  Calendar,
  XCircle,
  MapPin,
  Clock,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface AdminStatsProps {
  pending: number
  approved: number
  scheduled: number
  rejected: number
  venues: number
  timeSlots: number
}

type Tone = 'neutral' | 'amber' | 'success' | 'primary' | 'muted'

interface Stat {
  label: string
  value: number
  icon: React.ReactNode
  tone: Tone
  hint?: string
}

// Tokens only (spec §2.3): amber = --signal-amber, success = --success.
const TONE: Record<Tone, { text: string; bg: string }> = {
  neutral: { text: 'text-foreground', bg: 'bg-muted/30' },
  amber: { text: 'text-signal-amber', bg: 'bg-signal-amber/10' },
  success: { text: 'text-success', bg: 'bg-success/10' },
  primary: { text: 'text-primary', bg: 'bg-primary/10' },
  muted: { text: 'text-muted-foreground', bg: 'bg-transparent' },
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
      label: 'Awaiting review',
      value: pending,
      icon: <FileText className="h-4 w-4" aria-hidden="true" />,
      tone: pending > 0 ? 'amber' : 'muted',
      hint: pending > 0 ? 'Needs review' : undefined,
    },
    {
      label: 'Approved',
      value: approved,
      icon: <CheckCircle2 className="h-4 w-4" aria-hidden="true" />,
      tone: approved > 0 ? 'success' : 'muted',
    },
    {
      label: 'Scheduled',
      value: scheduled,
      icon: <Calendar className="h-4 w-4" aria-hidden="true" />,
      tone: 'primary',
    },
    {
      label: 'Not selected',
      value: rejected,
      icon: <XCircle className="h-4 w-4" aria-hidden="true" />,
      tone: 'muted',
    },
  ]

  // Supporting stats — infrastructure metadata
  const secondary: Stat[] = [
    {
      label: 'Rooms',
      value: venues,
      icon: <MapPin className="h-4 w-4" aria-hidden="true" />,
      tone: 'neutral',
    },
    {
      label: 'Time slots',
      value: timeSlots,
      icon: <Clock className="h-4 w-4" aria-hidden="true" />,
      tone: 'neutral',
    },
  ]

  return (
    <section aria-label="Program at a glance" className="rounded-2xl border border-foreground/20 bg-card stats-card">
      <div className="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-border">
        {primary.map((stat) => (
          <StatCell key={stat.label} {...stat} />
        ))}
      </div>
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
  const styles = TONE[tone]

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
          <span className={cn('font-semibold tabular-nums', compact ? 'text-2xl' : 'stat-value')}>
            {value}
          </span>
          {hint && <Badge variant="amber">{hint}</Badge>}
        </div>
        <p className={cn('text-xs text-muted-foreground truncate', compact ? 'mt-0' : 'mt-0.5')}>{label}</p>
      </div>
    </div>
  )
}
