'use client'

/**
 * "What the room needs" (PRD §4.2 step 4, inventory 3.3 / P2-11).
 *
 * The column, the validator, the proposal record field and the scheduler's feature constraint
 * all existed; this is the field that writes them. The vocabulary is the union of the
 * gathering's own rooms' features (`GET /api/v1/events/[slug]/room-features`) so a choice here
 * is something the scheduler can actually match — plus a free-text add, because a proposer
 * knows things the venue list does not.
 *
 * Nothing here is private: `required_features` rides along on the proposer's own public
 * proposal record (validate.ts `RECORD_FIELDS`), and the endpoint returns feature words only,
 * never a room.
 */
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FilterChip } from '@/components/ui/filter-chip'
import { RemovableChip } from '@/components/ui/removable-chip'
import { apiFetch } from '@/lib/api/client'
import { MAX_REQUIRED_FEATURES } from '@/lib/sessions/constants'

interface RoomFeatures {
  features: string[]
  suggested: string[]
}

/** The gathering's feature vocabulary; falls back to the neutral suggestions on any error. */
export function useRoomFeatures(eventSlug: string | null | undefined): { vocabulary: string[]; isLoading: boolean } {
  const [vocabulary, setVocabulary] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(!!eventSlug)

  React.useEffect(() => {
    if (!eventSlug) {
      setVocabulary([])
      setIsLoading(false)
      return
    }
    let mounted = true
    setIsLoading(true)
    apiFetch<RoomFeatures>(`/api/v1/events/${encodeURIComponent(eventSlug)}/room-features`)
      .then((data) => {
        if (!mounted) return
        const list = data.features.length > 0 ? data.features : data.suggested
        setVocabulary(list.map((f) => f.toLowerCase()))
      })
      .catch(() => {
        if (mounted) setVocabulary([])
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [eventSlug])

  return { vocabulary, isLoading }
}

export interface RequiredFeaturesFieldProps {
  value: string[]
  onChange: (next: string[]) => void
  /** The gathering's vocabulary, from `useRoomFeatures`. */
  vocabulary: string[]
  idPrefix: string
  legend?: string
  hint?: string
  max?: number
}

/**
 * Checkbox chips over the vocabulary, plus a free-text add. Selected words that are not in the
 * vocabulary (a proposer's own, or a room feature that has since been renamed) stay visible and
 * removable, so an edit never silently drops what the proposer asked for.
 */
export function RequiredFeaturesField({
  value,
  onChange,
  vocabulary,
  idPrefix,
  legend = 'What the room needs (optional)',
  hint = 'Organizers use this to put you in a room that fits. It rides along on your public proposal.',
  max = MAX_REQUIRED_FEATURES,
}: RequiredFeaturesFieldProps) {
  const [custom, setCustom] = React.useState('')
  const selected = value.map((v) => v.toLowerCase())
  const full = selected.length >= max
  const extras = selected.filter((v) => !vocabulary.includes(v))

  const toggle = (feature: string) => {
    const f = feature.toLowerCase()
    if (selected.includes(f)) onChange(selected.filter((v) => v !== f))
    else if (!full) onChange([...selected, f])
  }

  const add = (raw: string) => {
    const f = raw.toLowerCase().trim().slice(0, 40)
    if (f && !selected.includes(f) && !full) onChange([...selected, f])
    setCustom('')
  }

  return (
    <fieldset className="space-y-2" data-testid={`${idPrefix}-required-features`}>
      <legend className="text-sm font-medium leading-none">{legend}</legend>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {vocabulary.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {vocabulary.map((feature) => (
            <FilterChip
              key={feature}
              pressed={selected.includes(feature)}
              onClick={() => toggle(feature)}
              disabled={full && !selected.includes(feature)}
            >
              {feature}
            </FilterChip>
          ))}
        </div>
      )}
      {extras.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {extras.map((feature) => (
            <RemovableChip key={feature} label={feature} onRemove={() => toggle(feature)} />
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          id={`${idPrefix}-feature`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Something else the room needs…"
          maxLength={40}
          disabled={full}
          aria-label="Add a room requirement"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(custom)
            }
          }}
        />
        <Button type="button" variant="outline" onClick={() => add(custom)} disabled={!custom.trim() || full}>
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {full ? `${max} of ${max} requirements used. Remove one to add another.` : `${selected.length} of ${max} requirements used.`}
      </p>
    </fieldset>
  )
}
