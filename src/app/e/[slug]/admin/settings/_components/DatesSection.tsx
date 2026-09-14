'use client'

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { TimezonePicker } from '@/components/ui/timezone-picker'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, Field } from './SectionCard'
import { useSectionSave, toDateInput } from './shared'

export function DatesSection({ event }: { event: Event }) {
  const { state, save } = useSectionSave(event.id)
  const [startDate, setStartDate] = React.useState(toDateInput(event.startDate))
  const [endDate, setEndDate] = React.useState(toDateInput(event.endDate))
  const [timezone, setTimezone] = React.useState(event.timezone)
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)
  const datesChanged = startDate !== toDateInput(event.startDate) || endDate !== toDateInput(event.endDate)
  const ordered = !startDate || !endDate || endDate >= startDate

  return <SectionCard id="dates" title="Dates & timezone" description="When the gathering happens. Proposal and voting deadlines are shown in this timezone."
    onSubmit={() => save({ start_date: startDate, end_date: endDate, timezone }, 'Dates saved.')}
    footer={<SaveBar state={state} disabled={!startDate || !endDate || !ordered} />}>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Start date" htmlFor="event-start" error={fieldError('start_date')}>
        <Input id="event-start" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required error={!!fieldError('start_date')} />
      </Field>
      <Field label="End date" htmlFor="event-end" error={fieldError('end_date') || (!ordered ? 'End date must be on or after the start date.' : null)}>
        <Input id="event-end" type="date" value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} required error={!ordered || !!fieldError('end_date')} />
      </Field>
    </div>
    <Field label="Timezone" hint="Deadlines and the schedule are shown on this clock." error={fieldError('timezone')}>
      <TimezonePicker value={timezone} onChange={setTimezone} />
    </Field>
    {datesChanged ? <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
      <p>Changing the dates does not move existing time slots. Slots outside the new range stay in the schedule builder until you move or remove them.</p>
    </div> : null}
  </SectionCard>
}
