'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCircle, FileText, Info, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { CSVSessionImport } from '@/components/admin/CSVSessionImport'
import { apiFetch, ApiError } from '@/lib/api/client'
import { formatInEventTimezone } from '@/lib/events/timezone'
import { cn } from '@/lib/utils'
import type { AdminTimeSlot, AdminTrack, AdminVenue } from '@/components/admin/types'

const FORMAT_DESCRIPTIONS: Record<string, string> = {
  talk: 'A presentation or lecture',
  workshop: 'Hands-on interactive session',
  discussion: 'Open group conversation',
  panel: 'Multiple speakers discussing',
  demo: 'Live demonstration',
  fireside: 'An interview-style conversation',
  ceremony: 'Opening, closing or ritual',
}

const STATUSES = [
  { value: 'approved', label: 'Approved', description: 'Ready for voting and scheduling' },
  { value: 'scheduled', label: 'Scheduled', description: 'Placed in a slot now' },
  { value: 'pending', label: 'Pending', description: 'Awaiting review' },
] as const

export default function AdminCreateSessionPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const base = `/api/v1/events/${event.slug}/admin`
  const formats = event.allowedFormats.length ? event.allowedFormats : ['talk', 'workshop', 'discussion', 'panel', 'demo']
  const durations = event.allowedDurations.length ? [...event.allowedDurations].sort((a, b) => a - b) : [15, 30, 60, 90]

  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [format, setFormat] = React.useState(formats[0])
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

  const [mode, setMode] = React.useState<'single' | 'bulk'>('single')
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
    if (normalized && !tags.includes(normalized) && tags.length < 5) setTags([...tags, normalized])
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
    setFormat(formats[0])
    setStatus('approved')
    setTrackId(null)
    setTags([])
    setListedName('')
    setVenueId(null)
    setTimeSlotId(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!title.trim()) { setError('Title is required'); return }
    if (status === 'scheduled' && !timeSlotId) { setError('Choose a room and a free time slot for a scheduled session'); return }
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
      setError(err instanceof ApiError ? err.message : 'The session could not be created.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!can('manageSchedule')) {
    return <Card><CardContent className="py-8 text-center text-muted-foreground">Only owners and admins can add sessions.</CardContent></Card>
  }

  if (created) {
    return (
      <div className="max-w-md mx-auto">
        <Card>
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4"><div className="rounded-full bg-green-500/10 p-4"><CheckCircle className="h-12 w-12 text-green-500" aria-hidden /></div></div>
            <CardTitle className="text-2xl">Session created</CardTitle>
            <CardDescription>&ldquo;{created.title}&rdquo; is {created.status}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" asChild><Link href={`/e/${event.slug}/sessions/${created.id}`}>View session</Link></Button>
              <Button className="flex-1" onClick={reset}>Create another</Button>
            </div>
            <Button variant="ghost" className="w-full" asChild><Link href={`/e/${event.slug}/admin`}>Back to overview</Link></Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold">Add a session</h1>
        <p className="text-muted-foreground mt-1">Add a curated session for {event.name}</p>
      </div>

      <div className="flex gap-2 mb-6" role="tablist" aria-label="How to add sessions">
        {([['single', 'Single session', FileText], ['bulk', 'Import CSV', Upload]] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn('flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors', mode === value ? 'border-primary bg-primary/10 text-primary' : 'border-muted hover:border-muted-foreground/50')}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {loadError && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{loadError}</p>}

      <div className="mb-6 flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          Sessions you add have no host account: nobody&rsquo;s name goes on a public record they did not write. You can note the speaker as &ldquo;listed as&rdquo; — organizers see it, attendees and the network never do. When the speaker signs in and proposes the session themselves, it becomes theirs.
        </p>
      </div>

      {bulkImportCount > 0 && mode === 'bulk' && (
        <div role="status" className="mb-6 p-4 bg-green-500/10 border border-green-500/20 rounded-lg flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-green-500" aria-hidden />
          <div>
            <p className="font-medium text-green-700 dark:text-green-300">Imported {bulkImportCount} session{bulkImportCount === 1 ? '' : 's'}</p>
            <Link href={`/e/${event.slug}/admin`} className="text-sm text-green-600 dark:text-green-400 hover:underline">View all sessions</Link>
          </div>
        </div>
      )}

      {mode === 'bulk' ? (
        <CSVSessionImport eventSlug={event.slug} tracks={tracks} allowedFormats={formats} onImportComplete={(count) => setBulkImportCount((n) => n + count)} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Session details</CardTitle>
            <CardDescription>Create a session with its status, track and (optionally) a time slot.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="session-title" className="text-sm font-medium">Title <span className="text-destructive">*</span></label>
                <Input id="session-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Session title" maxLength={200} />
              </div>

              <div className="space-y-2">
                <label htmlFor="session-description" className="text-sm font-medium">Description</label>
                <Textarea id="session-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the session…" rows={4} maxLength={5000} />
              </div>

              <div className="space-y-2">
                <label htmlFor="session-listed" className="text-sm font-medium">Speaker (listed as)</label>
                <Input id="session-listed" value={listedName} onChange={(e) => setListedName(e.target.value)} placeholder="Optional — e.g., Alice Smith" maxLength={200} />
                <p className="text-xs text-muted-foreground">Visible to organizers only. Never shown to attendees or published.</p>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Format</legend>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {formats.map((f) => (
                    <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={cn('p-3 rounded-lg border text-left transition-colors', format === f ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}>
                      <div className="font-medium text-sm capitalize">{f}</div>
                      {FORMAT_DESCRIPTIONS[f] && <div className="text-xs text-muted-foreground">{FORMAT_DESCRIPTIONS[f]}</div>}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Duration</legend>
                <div className="flex flex-wrap gap-2">
                  {durations.map((d) => (
                    <button key={d} type="button" aria-pressed={duration === d} onClick={() => setDuration(d)} className={cn('px-4 py-2 rounded-lg border transition-colors', duration === d ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}>
                      {d} min
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Status</legend>
                <div className="grid grid-cols-3 gap-2">
                  {STATUSES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      aria-pressed={status === s.value}
                      onClick={() => { setStatus(s.value); if (s.value !== 'scheduled') { setVenueId(null); setTimeSlotId(null) } }}
                      className={cn('p-3 rounded-lg border text-left transition-colors', status === s.value ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}
                    >
                      <div className="font-medium text-sm">{s.label}</div>
                      <div className="text-xs text-muted-foreground">{s.description}</div>
                    </button>
                  ))}
                </div>
              </fieldset>

              {status === 'scheduled' && (
                <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
                  <div className="space-y-2">
                    <label htmlFor="session-venue" className="text-sm font-medium">Room</label>
                    <select id="session-venue" value={venueId || ''} onChange={(e) => { setVenueId(e.target.value || null); setTimeSlotId(null) }} className="w-full rounded-lg border bg-background px-3 py-2 text-sm">
                      <option value="">Select a room…</option>
                      {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                  {venueId && (
                    <div className="space-y-2">
                      <label htmlFor="session-slot" className="text-sm font-medium">Free time slot</label>
                      <select id="session-slot" value={timeSlotId || ''} onChange={(e) => setTimeSlotId(e.target.value || null)} className="w-full rounded-lg border bg-background px-3 py-2 text-sm">
                        <option value="">Select a time…</option>
                        {freeSlots.map((slot) => (
                          <option key={slot.id} value={slot.id}>
                            {formatInEventTimezone(new Date(slot.start_time), event.timezone, 'datetime')}–{formatInEventTimezone(new Date(slot.end_time), event.timezone, 'time')}{slot.label ? ` (${slot.label})` : ''}
                          </option>
                        ))}
                      </select>
                      {freeSlots.length === 0 && <p className="text-xs text-muted-foreground">No free slots in this room</p>}
                    </div>
                  )}
                </div>
              )}

              {tracks.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Track</legend>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <button type="button" aria-pressed={trackId === null} onClick={() => setTrackId(null)} className={cn('px-3 py-2 rounded-lg border text-sm transition-colors text-left', trackId === null ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}>None</button>
                    {tracks.map((track) => (
                      <button key={track.id} type="button" aria-pressed={trackId === track.id} onClick={() => setTrackId(track.id)} className={cn('px-3 py-2 rounded-lg border text-sm transition-colors text-left flex items-center gap-2', trackId === track.id ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}>
                        {track.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: track.color }} aria-hidden />}
                        <span className="truncate">{track.name}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="space-y-2">
                <label htmlFor="session-tag" className="text-sm font-medium">Tags (up to 5)</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1">
                      {tag}
                      <button type="button" onClick={() => setTags(tags.filter((t) => t !== tag))} aria-label={`Remove tag ${tag}`}>×</button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input id="session-tag" value={customTag} onChange={(e) => setCustomTag(e.target.value)} placeholder="Add a tag…" maxLength={40} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(customTag) } }} />
                  <Button type="button" variant="outline" onClick={() => addTag(customTag)} disabled={!customTag.trim() || tags.length >= 5}>Add</Button>
                </div>
              </div>

              {error && <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">{error}</div>}

              <div className="flex gap-3">
                <Button type="button" variant="outline" className="flex-1" asChild><Link href={`/e/${event.slug}/admin`}>Cancel</Link></Button>
                <Button type="submit" className="flex-1" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create session
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
