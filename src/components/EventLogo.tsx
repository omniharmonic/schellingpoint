'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

export function EventLogo({ url, name, className }: { url: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  return url && failed !== url
    ? <img data-testid="event-brand-logo" src={url} alt="" onError={() => setFailed(url)} className={cn('h-8 w-8 shrink-0 rounded-lg object-contain', className)} />
    : <span aria-hidden className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-semibold text-primary', className)}>{name.charAt(0)}</span>
}
