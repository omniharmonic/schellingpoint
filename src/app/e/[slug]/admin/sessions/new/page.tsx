'use client'

import * as React from 'react'
import Link from 'next/link'
import { FileText, Info, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { RemovableChip } from '@/components/ui/removable-chip'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PageHeader } from '@/components/PageHeader'
import { SuccessPanel } from '@/components/SuccessPanel'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { CSVSessionImport } from '@/components/admin/CSVSessionImport'
import { apiFetch, ApiError } from '@/lib/api/client'
import { formatInEventTimezone } from '@/lib/events/timezone'
import { plural } from '@/lib/format'
import { sessionStatusLabel } from '@/lib/labels'
import { allowedDurationOptions, allowedFormatOptions, durationLabel, MAX_TAGS } from '@/lib/sessions/constants'
import { cn } from '@/lib/utils'
import type { AdminTimeSlot, AdminTrack, AdminVenue } from '@/components/admin/types'

const STATUSES = [
  { value: 'approved', label: 'Approved', description: 'Ready for voting and scheduling' },
  { value: 'scheduled', label: 'Scheduled', description: 'Placed in a slot now' },
  { value: 'pending', label: 'Awaiting review', description: 'Reviewed later' },
] as const

type Mode = 'single' | 'bulk'

/** A selectable option card (format, duration, status, track). */
function OptionButton({
  selected,
  onClick,
  className,
  children,
}: {
  selected: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground/50',
        className
      )}
    >
      {children}
    </button>
  )
}

export default function AdminCreateSessionPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const base = `/api/v1/events/${event.slug}/admin`
  const formats = React.useMemo(() => allowedFormatOptions(event.allowedFormats), [event.allowedFormats])
  const durations = React.useMemo(() => allowedDurationOptions(event.allowedDurations), [event.allowedDurations])

  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [format, setFormat] = React.useState(formats[0]?.value ?? 'talk')
  const [duration, setDuration] = React.useState(durations.includes(60) ? 60 : durations[0])
  const [status, setStatus] = React.useState<(typeof STATUSES)[number]['value']>('approved')
  const [trackId, setTrackId] = React.useState<string | null>(null)
  const [tags, setTags] = React.useState<string[]>([])
  const [customTag, setCustomTag] = React.useState('')
  const [listedName, setListedName] = React.useState('')
  const [venueId, setVenueId] = React.useState<string | null>(null)
  const [timeSlotId, setTimeSlotId] = React.useState<string | null>(null)

  const [tracks, setTracks] = React.useState<AdminTrack[]>([])
  const [venues, setVenues] = React.useState<AdminVenue[]>([])
  const [timeSlots, setTimeSlots] = React.useState<AdminTimeSlot[]>([])
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [mode, setMode] = React.useState<Mode>('single')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [created, setCreated] = React.useState<{ id: string; title: string; status: string } | null>(null)
  const [bulkImportCount, setBulkImportCount] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    Promise.all([
      apiFetch<{ tracks: AdminTrack[] }>(`${base}/tracks`),
      apiFetch<{ venues: AdminVenue[] }>(`${base}/venues`),
      apiFetch<{ timeSlots: AdminTimeSlot[] }>(`${base}/time-slots`),
    ])
      .then(([t, v, s]) => {
        if (cancelled) return
        setTracks(t.tracks.filter((track) => track.is_active))
        setVenues(v.venues)
        setTimeSlots(s.timeSlots)
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof ApiError ? e.message : 'Tracks and rooms could not be loaded.') })
    return () => { cancelled = true }
  }, [base])

  const addTag = (tag: string) => {
    const normalized = tag.toLowerCase().trim()
    if (normalized && !tags.includes(normalized) && tags.length < MAX_TAGS) setTags([...tags, normalized])
    setCustomTag('')
  }

  const freeSlots = React.useMemo(
    () => (venueId ? timeSlots.filter((t) => t.venue_id === venueId && !t.is_break && t.sessions.length === 0) : []),
    [timeSlots, venueId],
  )

  const reset = () => {
    setCreated(null)
    setTitle('')
    setDescription('')
    setFormat(formats[0]?.value ?? 'talk')
    setDuration(durations.includes(60) ? 60 : durations[0])
    setStatus('approved')
    setTrackId(null)
    setTags([])
    setListedName('')
    setVenueId(null)
    setTimeSlotId(null)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!title.trim()) { setError('Give the session a title.'); return }
    if (status === 'scheduled' && !timeSlotId) { setError('Choose a room and a free time slot for a scheduled session.'); return }
    setIsSubmitting(true)
    try {
      const res = await apiFetch<{ id: string; status: string }>(`${base}/sessions`, {
        method: 'POST',
        json: {
          title: title.trim(),
          description: description.trim() || null,
          format,
          duration,
          status,
          track_id: trackId,
          topic_tags: tags.length ? tags : null,
          host_name: listedName.trim() || null,
          time_slot_id: status === 'scheduled' ? timeSlotId : null,
        },
      })
      setCreated({ id: res.id, title: title.trim(), status: res.status })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The session could not be created. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!can('manageSchedule')) {
    return (
      <Card>
        <CardContent className="p-8">
          <PageHeader title="Organizer access required" subtitle="Only this gathering’s owner and admins can add sessions." className="mb-5" />
          <Button asChild variant="outline"><Link href={`/e/${event.slug}`}>Return to the gathering</Link></Button>
        </CardContent>
      </Card>
    )
  }

  if (created) {
    return (
      <div className="max-w-2xl">
        <SuccessPanel
          title="Session created"
          body={`“${created.title}” is ${sessionStatusLabel(created.status).toLowerCase()}.`}
          primary={<Button asChild><Link href={`/e/${event.slug}/sessions/${created.id}`}>View session</Link></Button>}
          secondary={<Button variant="outline" onClick={reset}>Add another</Button>}
        />
        <div className="mt-4 text-center">
          <Button variant="link" asChild><Link href={`/e/${event.slug}/admin`}>Back to overview</Link></Button>
        </div>
      </div>
    )
  }

  const tagsFull = tags.length >= MAX_TAGS

  return (
    <div className="max-w-2xl">
      <PageHeader title="Add a session" subtitle={`Add a curated session to ${event.name}.`} />

      <div className="mb-6">
        <SegmentedControl<Mode>
          aria-label="How to add sessions"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'single', label: 'Single session', icon: <FileText className="h-4 w-4" aria-hidden /> },
            { value: 'bulk', label: 'Import CSV', icon: <Upload className="h-4 w-4" aria-hidden /> },
          ]}
        />
      </div>

      {loadError && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>
      )}

      <div className="mb-6 flex gap-3 rounded-xl border bg-muted/40 p-4 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          Sessions you add have no host account: nobody’s name goes on a public record they did not write. You can note the speaker as “listed as” — organizers see it, attendees and the network never do. When the speaker signs in and proposes the session themselves, it becomes theirs.
        </p>
      </div>

      {mode === 'bulk' ? (
        <div>
          {bulkImportCount > 0 && (
            <Alert variant="success" className="mb-6">
              <AlertTitle>Imported {plural(bulkImportCount, 'session')}</AlertTitle>
              <AlertDescription>
                <Link href={`/e/${event.slug}/admin`} className="underline underline-offset-4 hover:text-foreground">View all sessions</Link>
              </AlertDescription>
            </Alert>
          )}
          <CSVSessionImport
            eventSlug={event.slug}
            tracks={tracks}
            allowedFormats={formats.map((f) => f.value)}
            onImportComplete={(count) => setBulkImportCount((n) => n + count)}
          />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Session details</CardTitle>
            <CardDescription>Create a session with its status, track and (optionally) a time slot.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6" noValidate>
              <div className="space-y-2">
                <Label htmlFor="session-title">Title</Label>
                <Input id="session-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Session title" maxLength={200} required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="session-description">Description (optional)</Label>
                <Textarea id="session-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the session…" rows={4} maxLength={5000} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="session-listed">Speaker, listed as (optional)</Label>
                <Input id="session-listed" value={listedName} onChange={(e) => setListedName(e.target.value)} placeholder="e.g. Alice Smith" maxLength={200} />
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">Format</legend>
                <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
                  {formats.map((f) => (
                    <OptionButton key={f.value} selected={format === f.value} onClick={() => setFormat(f.value)}>
                      <div className="text-sm font-medium">{f.label}</div>
                      <div className="text-xs text-muted-foreground">{f.description}</div>
                    </OptionButton>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">Duration</legend>
                <div className="grid grid-cols-3 gap-3 pt-2 sm:grid-cols-4">
                  {durations.map((d) => (
                    <OptionButton key={d} selected={duration === d} onClick={() => setDuration(d)} className="text-center text-sm">
                      {durationLabel(d)}
                    </OptionButton>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">Status</legend>
                <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-3">
                  {STATUSES.map((s) => (
                    <OptionButton
                      key={s.value}
                      selected={status === s.value}
                      onClick={() => { setStatus(s.value); if (s.value !== 'scheduled') { setVenueId(null); setTimeSlotId(null) } }}
                    >
                      <div className="text-sm font-medium">{s.label}</div>
                      <div className="text-xs text-muted-foreground">{s.description}</div>
                    </OptionButton>
                  ))}
                </div>
                {status === 'scheduled' && (
                  <div className="mt-3 space-y-4 rounded-xl border bg-muted/40 p-4">
                    <div className="space-y-2">
                      <Label htmlFor="session-venue">Room</Label>
                      <Select id="session-venue" value={venueId || ''} onChange={(e) => { setVenueId(e.target.value || null); setTimeSlotId(null) }}>
                        <option value="">Select a room…</option>
                        {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </Select>
                    </div>
                    {venueId && (
                      <div className="space-y-2">
                        <Label htmlFor="session-slot">Free time slot</Label>
                        <Select id="session-slot" value={timeSlotId || ''} onChange={(e) => setTimeSlotId(e.target.value || null)} disabled={freeSlots.length === 0}>
                          <option value="">Select a time…</option>
                          {freeSlots.map((slot) => (
                            <option key={slot.id} value={slot.id}>
                              {formatInEventTimezone(new Date(slot.start_time), event.timezone, 'datetime')}–{formatInEventTimezone(new Date(slot.end_time), event.timezone, 'time')}{slot.label ? ` (${slot.label})` : ''}
                            </option>
                          ))}
                        </Select>
                        {freeSlots.length === 0 && <p className="text-xs text-muted-foreground">No free slots in this room.</p>}
                      </div>
                    )}
                  </div>
                )}
              </fieldset>

              {tracks.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium leading-none">Track (optional)</legend>
                  <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
                    <OptionButton selected={trackId === null} onClick={() => setTrackId(null)} className="text-sm">None</OptionButton>
                    {tracks.map((track) => (
                      <OptionButton key={track.id} selected={trackId === track.id} onClick={() => setTrackId(track.id)} className="flex items-center gap-2 text-sm">
                        {track.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: track.color }} aria-hidden />}
                        <span className="truncate">{track.name}</span>
                      </OptionButton>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="space-y-2">
                <Label htmlFor="session-tag">Tags (optional)</Label>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <RemovableChip key={tag} label={tag} onRemove={() => setTags(tags.filter((t) => t !== tag))} />
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    id="session-tag"
                    value={customTag}
                    onChange={(e) => setCustomTag(e.target.value)}
                    placeholder="Add a tag…"
                    maxLength={40}
                    disabled={tagsFull}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(customTag) } }}
                    aria-describedby="session-tag-count"
                  />
                  <Button type="button" variant="outline" onClick={() => addTag(customTag)} disabled={!customTag.trim() || tagsFull}>Add</Button>
                </div>
                <p id="session-tag-count" className="text-xs text-muted-foreground">
                  {tagsFull ? `${MAX_TAGS} of ${MAX_TAGS} tags used. Remove one to add another.` : `${tags.length} of ${MAX_TAGS} tags used.`}
                </p>
              </div>

              {error && <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" asChild><Link href={`/e/${event.slug}/admin`}>Cancel</Link></Button>
                <Button type="submit" loading={isSubmitting}>Create session</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
