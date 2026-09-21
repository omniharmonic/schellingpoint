'use client'

/**
 * Minimal toast system, no dependencies. Mount <Toaster/> once (root layout or the shell that
 * owns the page) and call `useToast()` anywhere below it.
 *
 *   const { toast } = useToast()
 *   toast({ title: 'Saved', description: 'Your changes are live.' })
 *   toast({ title: 'Could not save', variant: 'destructive' })
 *   toast({ title: 'Added to your schedule', action: { label: 'Undo', onClick: undo } })
 *
 * Success/neutral toasts announce via role="status" (polite); destructive ones via
 * role="alert". Toasts auto-dismiss after `duration` ms (default 5000) — do not rely
 * on them for errors that need a decision; use an inline error box for that.
 *
 * `toast()` is also exported for use outside React (e.g. after a router push).
 */

import * as React from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToastVariant = 'default' | 'success' | 'destructive'

export interface ToastOptions {
  title: React.ReactNode
  description?: React.ReactNode
  variant?: ToastVariant
  /** Milliseconds before auto-dismiss; 0 keeps it until closed. */
  duration?: number
  action?: { label: string; onClick: () => void }
}

export interface ToastRecord extends ToastOptions {
  id: string
}

type Listener = (toasts: ToastRecord[]) => void

let toasts: ToastRecord[] = []
const listeners = new Set<Listener>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let counter = 0

function emit() {
  for (const l of listeners) l(toasts)
}

function dismiss(id: string) {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  toasts = toasts.filter((x) => x.id !== id)
  emit()
}

function toast(options: ToastOptions): string {
  const id = `toast-${++counter}`
  const duration = options.duration ?? 5000
  toasts = [...toasts, { ...options, id }].slice(-4)
  emit()
  if (duration > 0) timers.set(id, setTimeout(() => dismiss(id), duration))
  return id
}

function useToast() {
  return React.useMemo(() => ({ toast, dismiss }), [])
}

const ICON: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: CheckCircle2,
  destructive: AlertCircle,
}

function ToastItem({ t }: { t: ToastRecord }) {
  const variant = t.variant ?? 'default'
  const Icon = ICON[variant]
  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-card p-4 text-sm text-card-foreground shadow-lg animate-slide-up',
        variant === 'success' && 'border-success/30',
        variant === 'destructive' && 'border-destructive/30'
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          variant === 'success' && 'text-success',
          variant === 'destructive' && 'text-destructive',
          variant === 'default' && 'text-muted-foreground'
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-snug">{t.title}</p>
        {t.description && <p className="mt-0.5 leading-relaxed text-muted-foreground">{t.description}</p>}
        {t.action && (
          <button
            type="button"
            onClick={() => {
              t.action?.onClick()
              dismiss(t.id)
            }}
            className="mt-2 inline-flex min-h-8 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(t.id)}
        className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}

/** Render once per page shell. Positioned bottom-right on desktop, bottom-center on phones. */
function Toaster({ className }: { className?: string }) {
  const [items, setItems] = React.useState<ToastRecord[]>(toasts)
  React.useEffect(() => {
    listeners.add(setItems)
    setItems(toasts)
    return () => {
      listeners.delete(setItems)
    }
  }, [])

  return (
    <div
      aria-label="Notifications"
      className={cn(
        'pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96',
        className
      )}
    >
      {items.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  )
}

export { Toaster, useToast, toast, dismiss as dismissToast }
