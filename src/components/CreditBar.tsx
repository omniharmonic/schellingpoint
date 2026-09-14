'use client'

import { Progress } from '@/components/ui/progress'

interface CreditBarProps {
  total: number
  spent: number
}

export function CreditBar({ total, spent }: CreditBarProps) {
  const remaining = total - spent
  const percentUsed = total > 0 ? (spent / total) * 100 : 0

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs tracking-wider">
        <span className="text-muted-foreground">Your voting credits</span>
        <span className="tabular-nums">
          <span className="font-bold text-primary">{remaining}</span>
          <span className="text-muted-foreground"> / {total} remaining</span>
        </span>
      </div>
      <Progress value={100 - percentUsed} />
      <p className="text-[11px] text-muted-foreground">
        {spent} credits used. Your votes help shape the program.
      </p>
    </div>
  )
}
