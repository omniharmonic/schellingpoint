'use client'

import * as React from 'react'
import { Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, Field, Toggle } from './SectionCard'
import { useSectionSave, toEventLocal } from './shared'
import { SESSION_FORMATS, SESSION_DURATIONS } from './constants'

export function ParticipationSection({ event }: { event: Event }) {
  const { state, save } = useSectionSave(event.id)
  const [opensAt, setOpensAt] = React.useState(() => toEventLocal(event.proposalsOpenAt, event.timezone))
  const [closesAt, setClosesAt] = React.useState(() => toEventLocal(event.proposalsClosesAt, event.timezone))
  const [formats, setFormats] = React.useState<string[]>(event.allowedFormats)
  const [durations, setDurations] = React.useState<number[]>(event.allowedDurations)
  const [customDuration, setCustomDuration] = React.useState('')
  const [maxProposals, setMaxProposals] = React.useState(event.maxProposalsPerUser)
  const [requireApproval, setRequireApproval] = React.useState(event.requireProposalApproval)
  const [topics, setTopics] = React.useState<string[]>(event.suggestedTopics)
  const [topicInput, setTopicInput] = React.useState('')
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)

  // Deadlines are wall-clock strings in the event timezone; re-render them if the timezone changes.
  React.useEffect(() => {
    setOpensAt(toEventLocal(event.proposalsOpenAt, event.timezone))
    setClosesAt(toEventLocal(event.proposalsClosesAt, event.timezone))
  }, [event.timezone, event.proposalsOpenAt, event.proposalsClosesAt])

  const toggleFormat = (value: string) => setFormats(prev => prev.includes(value) ? prev.filter(f => f !== value) : [...prev, value])
  const toggleDuration = (value: number) => setDurations(prev => prev.includes(value) ? prev.filter(d => d !== value) : [...prev, value].sort((a, b) => a - b))
  const addDuration = () => {
    const value = parseInt(customDuration, 10)
    if (Number.isInteger(value) && value > 0 && !durations.includes(value)) setDurations(prev => [...prev, value].sort((a, b) => a - b))
    setCustomDuration('')
  }
  const addTopic = () => {
    const values = topicInput.split(',').map(t => t.trim()).filter(Boolean)
    if (values.length) setTopics(prev => Array.from(new Set([...prev, ...values])))
    setTopicInput('')
  }
  const customDurations = durations.filter(d => !SESSION_DURATIONS.includes(d))
  const unlimited = maxProposals === 0

  return <SectionCard id="participation" title="Participation" description="How people propose sessions: when, in which formats, and how many."
    onSubmit={() => save({
      proposals_open_at: opensAt || null, proposals_close_at: closesAt || null,
      allowed_formats: formats, allowed_durations: durations,
      max_proposals_per_user: maxProposals, require_proposal_approval: requireApproval,
      suggested_topics: topics,
    }, 'Participation settings saved.')}
    footer={<SaveBar state={state} disabled={!formats.length || !durations.length} />}>
    <div>
      <p className="text-sm font-medium mb-1">Proposal window</p>
      <p className="text-xs text-muted-foreground mb-3">Times are in {event.timezone}. Leave blank to rely on the event phase alone.</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Opens" htmlFor="proposals-open" error={fieldError('proposals_open_at')}>
          <Input id="proposals-open" type="datetime-local" value={opensAt} onChange={e => setOpensAt(e.target.value)} error={!!fieldError('proposals_open_at')} />
        </Field>
        <Field label="Closes" htmlFor="proposals-close" error={fieldError('proposals_close_at')}>
          <Input id="proposals-close" type="datetime-local" value={closesAt} onChange={e => setClosesAt(e.target.value)} error={!!fieldError('proposals_close_at')} />
        </Field>
      </div>
    </div>

    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Session formats</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SESSION_FORMATS.map(format => <label key={format.value} className="flex items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <Checkbox checked={formats.includes(format.value)} onCheckedChange={() => toggleFormat(format.value)} aria-label={format.label} />{format.label}
        </label>)}
      </div>
      {fieldError('allowed_formats') ? <p className="text-xs text-destructive" role="alert">{fieldError('allowed_formats')}</p> : !formats.length ? <p className="text-xs text-destructive">Choose at least one format.</p> : null}
    </fieldset>

    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Session lengths</legend>
      <div className="flex flex-wrap gap-2">
        {SESSION_DURATIONS.map(duration => <label key={duration} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <Checkbox checked={durations.includes(duration)} onCheckedChange={() => toggleDuration(duration)} aria-label={`${duration} minutes`} />{duration} min
        </label>)}
        {customDurations.map(duration => <span key={duration} className="flex items-center gap-1 rounded-lg border border-primary bg-primary/5 px-3 py-2 text-sm">{duration} min
          <button type="button" onClick={() => toggleDuration(duration)} aria-label={`Remove ${duration} minute option`} className="ml-1 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button></span>)}
      </div>
      <div className="flex items-center gap-2">
        <Input type="number" min={1} max={1440} value={customDuration} onChange={e => setCustomDuration(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDuration() } }} placeholder="Custom minutes" className="max-w-[180px]" aria-label="Custom session length in minutes" />
        <Button type="button" variant="outline" size="sm" onClick={addDuration} disabled={!customDuration}><Plus className="h-4 w-4 mr-1" />Add</Button>
      </div>
      {fieldError('allowed_durations') ? <p className="text-xs text-destructive" role="alert">{fieldError('allowed_durations')}</p> : !durations.length ? <p className="text-xs text-destructive">Choose at least one length.</p> : null}
    </fieldset>

    <div className="space-y-4">
      <Toggle id="unlimited-proposals" checked={unlimited} onChange={next => setMaxProposals(next ? 0 : 3)} label="No per-person proposal limit" description="When on, anyone can propose as many sessions as they like." />
      {!unlimited ? <Field label="Proposals per person" htmlFor="max-proposals" className="pl-14" error={fieldError('max_proposals_per_user')}>
        <Input id="max-proposals" type="number" min={1} max={1000} value={maxProposals} onChange={e => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v) && v >= 0) setMaxProposals(v) }} className="max-w-[160px]" />
      </Field> : null}
      <Toggle id="require-approval" checked={requireApproval} onChange={setRequireApproval} label="Require organizer approval" description="Off by default: proposals are listed as soon as they are written, and organizers decline by not scheduling. Turn on to review each one before it appears." />
    </div>

    <Field label="Suggested topics" htmlFor="topic-input" hint="Shown to proposers as prompts. Press Enter or use commas to add several." error={fieldError('suggested_topics')}>
      {topics.length ? <div className="flex flex-wrap gap-2 mb-2">
        {topics.map(topic => <span key={topic} className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-sm">{topic}
          <button type="button" onClick={() => setTopics(prev => prev.filter(t => t !== topic))} aria-label={`Remove topic ${topic}`} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button></span>)}
      </div> : null}
      <div className="flex items-center gap-2">
        <Input id="topic-input" value={topicInput} onChange={e => setTopicInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTopic() } }} placeholder="e.g. Governance, Local food systems" maxLength={80} />
        <Button type="button" variant="outline" size="sm" onClick={addTopic} disabled={!topicInput.trim()}><Plus className="h-4 w-4 mr-1" />Add</Button>
      </div>
    </Field>
  </SectionCard>
}
