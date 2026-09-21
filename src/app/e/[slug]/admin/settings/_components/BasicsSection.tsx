'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import type { Event, EventVisibility } from '@/types/event'
import { SectionCard, SaveBar, Field } from './SectionCard'
import { useSectionSave, sameValue } from './shared'

export function BasicsSection({ event }: { event: Event }) {
  const { state, save } = useSectionSave(event.id)
  const [name, setName] = React.useState(event.name)
  const [tagline, setTagline] = React.useState(event.tagline || '')
  const [description, setDescription] = React.useState(event.description || '')
  const [visibility, setVisibility] = React.useState<EventVisibility>(event.visibility)
  const [locationName, setLocationName] = React.useState(event.locationName || '')
  const [locationAddress, setLocationAddress] = React.useState(event.locationAddress || '')
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)

  const patch = { name, tagline, description, visibility, location_name: locationName, location_address: locationAddress }
  const saved = { name: event.name, tagline: event.tagline || '', description: event.description || '', visibility: event.visibility, location_name: event.locationName || '', location_address: event.locationAddress || '' }
  const dirty = !sameValue(patch, saved)

  return <SectionCard id="basics" title="Basics" description="The invitation: what this gathering is called, what it is about, and where it happens."
    onSubmit={() => save(patch, 'Basics saved.')}
    footer={<SaveBar state={state} dirty={dirty} disabled={!name.trim()} />}>
    <Field label="Event name" htmlFor="event-name" error={fieldError('name')}>
      <Input id="event-name" value={name} onChange={e => setName(e.target.value)} required maxLength={160} error={!!fieldError('name')} />
    </Field>
    <Field label="Tagline (optional)" htmlFor="event-tagline" hint="One line under the name." error={fieldError('tagline')}>
      <Input id="event-tagline" value={tagline} onChange={e => setTagline(e.target.value)} maxLength={240} />
    </Field>
    <Field label="About the gathering (optional)" htmlFor="event-description" error={fieldError('description')}>
      <Textarea id="event-description" value={description} onChange={e => setDescription(e.target.value)} rows={5} />
    </Field>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Location name (optional)" htmlFor="event-location-name" hint="Venue, city, or “Online”." error={fieldError('location_name')}>
        <Input id="event-location-name" value={locationName} onChange={e => setLocationName(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Address (optional)" htmlFor="event-location-address" hint="Shown to members only; never published." error={fieldError('location_address')}>
        <Input id="event-location-address" value={locationAddress} onChange={e => setLocationAddress(e.target.value)} maxLength={500} />
      </Field>
    </div>
    <Field label="Who can discover this event?" htmlFor="event-visibility" hint="Drafts stay out of discovery until published." error={fieldError('visibility')}>
      <Select id="event-visibility" value={visibility} onChange={e => setVisibility(e.target.value as EventVisibility)} error={!!fieldError('visibility')}>
        <option value="public">Public — listed in discovery</option>
        <option value="unlisted">Unlisted — share the direct link</option>
        <option value="private">Private — invited members only</option>
      </Select>
    </Field>
  </SectionCard>
}
