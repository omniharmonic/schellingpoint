'use client'

import * as React from 'react'
import { Check, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { SaveState } from './shared'

interface SectionCardProps {
  id: string
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void
  className?: string
}

/** A stacked settings section. Wrapping in a form makes Enter submit the section. */
export function SectionCard({ id, title, description, children, footer, onSubmit, className }: SectionCardProps) {
  const body = <>
    <CardHeader>
      <CardTitle id={`${id}-title`} className="text-lg">{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
    <CardContent className="space-y-5">{children}</CardContent>
    {footer ? <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-secondary/40 p-4 sm:px-6 sm:py-4">{footer}</CardFooter> : null}
  </>
  return <Card id={id} className={cn('scroll-mt-24 overflow-hidden', className)} aria-labelledby={`${id}-title`}>
    {onSubmit ? <form onSubmit={e => { e.preventDefault(); onSubmit(e) }} noValidate>{body}</form> : body}
  </Card>
}

interface SaveFeedbackProps {
  state: SaveState
  /** Shown while idle; pass nothing to keep the line empty until something happens. */
  idleHint?: string
  className?: string
}

/** The live feedback line of a section footer (error, saved, or an idle hint). */
export function SaveFeedback({ state, idleHint, className }: SaveFeedbackProps) {
  return <div className={cn('min-w-0 text-sm', className)} aria-live="polite">
    {state.status === 'error' ? <p role="alert" className="flex items-start gap-2 text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{state.message}</p>
      : state.status === 'saved' ? <p className="flex items-center gap-2 text-success"><Check className="h-4 w-4" aria-hidden="true" />{state.message}</p>
      : idleHint ? <p className="text-muted-foreground">{idleHint}</p> : null}
  </div>
}

interface SaveBarProps {
  state: SaveState
  label?: string
  disabled?: boolean
  /** True once the section differs from what is saved; the idle hint shows only then. */
  dirty?: boolean
  idleHint?: string
}

/** Feedback line + submit button for a section footer. Never uses alert(). */
export function SaveBar({ state, label = 'Save changes', disabled, dirty = false, idleHint = 'Changes apply when you save.' }: SaveBarProps) {
  const saving = state.status === 'saving'
  // After a save, editing again turns the "Saved." line back into the hint.
  const feedbackState: SaveState = state.status === 'saved' && dirty ? { status: 'idle' } : state
  return <>
    <SaveFeedback state={feedbackState} idleHint={dirty ? idleHint : undefined} />
    <Button type="submit" loading={saving} disabled={disabled}>{saving ? 'Saving…' : label}</Button>
  </>
}

interface FieldProps {
  label: string
  htmlFor?: string
  hint?: string
  error?: string | null
  children: React.ReactNode
  className?: string
}

export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return <div className={cn('space-y-2', className)}>
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
  </div>
}

interface ToggleProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
}

/** Labelled switch row. Indent dependent fields with `ml-14` (switch width + gap). */
export function Toggle({ id, checked, onChange, label, description }: ToggleProps) {
  return <div className="flex items-start gap-3">
    <Switch id={id} checked={checked} onCheckedChange={onChange} aria-labelledby={`${id}-label`} className="mt-0.5" />
    <div className="space-y-1">
      <label id={`${id}-label`} htmlFor={id} className="cursor-pointer text-sm font-medium">{label}</label>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  </div>
}

interface ChoiceCardProps {
  selected: boolean
  onSelect: () => void
  label: string
  description: string
}

/** Radio-style option card (matches the creation wizard). */
export function ChoiceCard({ selected, onSelect, label, description }: ChoiceCardProps) {
  return <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
    className={cn('flex w-full items-start rounded-lg border-2 p-4 text-left transition-all hover:border-primary/50 hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2', selected ? 'border-primary bg-primary/5' : 'border-border')}>
    <span className={cn('mr-4 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary' : 'border-muted-foreground')}>
      {selected ? <span className="h-2 w-2 rounded-full bg-primary-foreground" /> : null}
    </span>
    <span><span className="font-medium">{label}</span><span className="mt-1 block text-sm text-muted-foreground">{description}</span></span>
  </button>
}
