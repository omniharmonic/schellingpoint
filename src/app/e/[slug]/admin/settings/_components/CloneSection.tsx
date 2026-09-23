'use client'

/**
 * "Copy this gathering" (MT §11.3).
 *
 * The next edition of a recurring gathering is almost always the last one's shape with new
 * dates, and rebuilding four venues, six tracks and a two-day grid by hand is the reason
 * people give up and use a spreadsheet. The copy carries all of that and **nothing about
 * people** — no members, no proposals, no votes, no tickets — which is stated on the card,
 * because it is the question every organizer asks before they press it.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CopyPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Event } from '@/types/event'
import { SectionCard, Field } from './SectionCard'
import { apiFetch, ApiError } from '@/lib/api/client'

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

function nextYear(date: Date): string {
  const d = new Date(date)
  d.setUTCFullYear(d.getUTCFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

export function CloneSection({ event }: { event: Event }) {
  const router = useRouter()
  const defaultName = `${event.name} (copy)`
  const [name, setName] = React.useState(defaultName)
  const [slug, setSlug] = React.useState(() => slugify(`${event.slug}-2`))
  const [startDate, setStartDate] = React.useState(() => nextYear(event.startDate))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; field?: string | null } | null>(null)
  const [done, setDone] = React.useState<{ slug: string; venues: number; tracks: number; timeSlots: number } | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await apiFetch<{ event: { slug: string }; copied: { venues: number; tracks: number; timeSlots: number } }>(
        `/api/v1/events/${encodeURIComponent(event.slug)}/admin/clone`,
        { method: 'POST', json: { name: name.trim(), slug: slug.trim(), startDate } },
      )
      setDone({ slug: result.event.slug, ...result.copied })
      router.refresh()
    } catch (e) {
      setError({ message: e instanceof ApiError ? e.message : 'The copy could not be made.', field: e instanceof ApiError ? e.field : null })
    } finally {
      setBusy(false)
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null)

  return <SectionCard id="clone" title="Copy this gathering"
    description="Start the next edition from this one’s shape: its settings, venues, tracks and slot grid, moved onto new dates.">
    <p className="text-sm text-muted-foreground">
      Nothing about people comes across — no members, no proposals, no votes, no tickets, no check-ins. The copy
      is a draft that only you can see until you publish it, and it gets its own identity on the network when you
      mint one.
    </p>

    {done ? (
      <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
        <p className="text-sm">
          Copied: {done.venues} venues, {done.tracks} tracks and {done.timeSlots} time slots.
        </p>
        <Button asChild><a href={`/e/${done.slug}/admin/settings`}>Open the new draft</a></Button>
      </div>
    ) : <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="clone-name" error={fieldError('name')}>
          <Input id="clone-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Web address" htmlFor="clone-slug" hint="unconference.events/e/…" error={fieldError('slug')}>
          <Input id="clone-slug" value={slug} onChange={(e) => setSlug(slugify(e.target.value))} maxLength={32} />
        </Field>
        <Field label="First day" htmlFor="clone-start" hint="The grid keeps its shape and its length, shifted onto these dates." error={fieldError('startDate')}>
          <Input id="clone-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
      </div>
      {error && !error.field ? <p className="text-sm text-destructive" role="alert">{error.message}</p> : null}
      <Button type="button" onClick={() => void submit()} loading={busy} disabled={!name.trim() || !slug.trim() || !startDate}>
        <CopyPlus className="mr-2 h-4 w-4" aria-hidden="true" />
        Make a copy
      </Button>
    </>}
  </SectionCard>
}
