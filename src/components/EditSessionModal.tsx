'use client'

import * as React from 'react'
import { X, Loader2, Send, ShieldCheck, MessageSquareWarning, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useTracks } from '@/hooks/useTracks'
import { useEvent } from '@/contexts/EventContext'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import { apiFetch } from '@/lib/api/client'
import { SkillPicker } from '@/components/SkillPicker'
import { TimePreferences, type TimePreferenceValue, type TimeWindowValue } from '@/components/TimePreferences'
import { Checkbox } from '@/components/ui/checkbox'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

const FORMATS = [
  { value: 'talk', label: 'Talk', description: 'A presentation or lecture' },
  { value: 'workshop', label: 'Workshop', description: 'Hands-on interactive session' },
  { value: 'discussion', label: 'Discussion', description: 'Open group conversation' },
  { value: 'panel', label: 'Panel', description: 'Multiple speakers discussing' },
  { value: 'demo', label: 'Demo', description: 'Live demonstration' },
]

const SESSION_TYPES = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'curated', label: 'Curated' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'track_reserved', label: 'Track reserved' },
]

const REVIEW_STATUSES = [
  { value: 'pending', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Declined' },
]

const TIME_OPTIONS: { value: string; label: string }[] = []
for (let h = 9; h <= 22; h++) {
  for (const m of [0, 30]) {
    if (h === 22 && m === 30) continue
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    TIME_OPTIONS.push({ value: `${hh}:${mm}`, label: `${h > 12 ? h - 12 : h}:${mm} ${h >= 12 ? 'PM' : 'AM'}` })
  }
}

/** Split a stored timestamp into the event-timezone calendar day and HH:MM. */
function parseTimestamp(iso: string | null | undefined, timezone: string): { day: string; time: string } {
  if (!iso) return { day: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '', time: '' }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const part = (type: string) => parts.find((x) => x.type === type)?.value ?? ''
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

interface EditSessionModalProps {
  isOpen: boolean
  onClose: () => void
  session: SessionView
  onSave: (updated: SessionView) => void
}

/**
 * Edit a session, in the sections the viewer has authority over (spec §4.2):
 *   - proposal content: only its author (the record lives in their repository); organizers
 *     edit content only on a host-less session, and otherwise "ask the proposer to update"
 *   - track: the author's suggestion or an organizer's curation (never rewrites the record)
 *   - attendee logistics (Telegram group): hosts, co-hosts, organizers
 *   - review status and session type: organizers
 * Hosts are never assigned here: co-hosts accept invites themselves (R9). Scheduling happens
 * in the schedule builder.
 */
export function EditSessionModal({ isOpen, onClose, session, onSave }: EditSessionModalProps) {
  const event = useEvent()
  const { tracks } = useTracks(event.slug)
  const isOrganizer = session.viewer.is_organizer
  const canEditContent = session.viewer.can_edit_content
  const canSetTrack = session.viewer.is_host || isOrganizer
  const authored = !session.unclaimed

  const eventDays = React.useMemo(
    () => getEventDays(event.startDate, event.endDate).map((date) => ({
      value: date,
      label: formatCalendarDate(date, { weekday: 'short', month: 'short', day: 'numeric' }),
    })),
    [event.startDate, event.endDate],
  )

  const allowedFormats = React.useMemo(() => {
    if (!event.allowedFormats.length) return FORMATS
    const preset = FORMATS.filter((f) => event.allowedFormats.includes(f.value))
    const current = FORMATS.find((f) => f.value === session.format)
    return current && !preset.includes(current) ? [...preset, current] : preset
  }, [event.allowedFormats, session.format])

  const initial = React.useCallback(() => {
    const start = parseTimestamp(session.self_hosted_start_time, event.timezone)
    const end = parseTimestamp(session.self_hosted_end_time, event.timezone)
    return {
      title: session.title,
      description: session.description || '',
      format: session.format || 'talk',
      tags: session.topic_tags,
      skills: session.skills,
      trackId: session.track_id,
      telegram: session.telegram_group_url || '',
      isSelfHosted: session.is_self_hosted,
      customLocation: session.custom_location || '',
      publicPlace: session.public_place || '',
      day: start.day,
      startTime: start.time,
      endTime: end.time,
      sessionType: session.session_type || 'proposed',
      status: session.status,
      availability: {
        windows: (session.time_preference?.windows as TimeWindowValue[] | undefined) ?? [],
        blackouts: (session.time_preference?.blackouts as TimeWindowValue[] | undefined) ?? [],
      } as TimePreferenceValue,
      publishAvailability: !!session.time_preference?.publish,
    }
  }, [session, event.timezone])

  const [form, setForm] = React.useState(initial)
  const [customTag, setCustomTag] = React.useState('')
  const [isSaving, setIsSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [askMessage, setAskMessage] = React.useState('')
  const [askState, setAskState] = React.useState<'idle' | 'sending' | 'sent'>('idle')
  const set = <K extends keyof ReturnType<typeof initial>>(key: K, value: ReturnType<typeof initial>[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  React.useEffect(() => {
    if (isOpen) {
      setForm(initial())
      setError(null)
      setAskMessage('')
      setAskState('idle')
    }
  }, [isOpen, initial])

  // Attendee-only details are only in the payload for hosts/organizers; if they are absent,
  // do not send them (an absent key is left untouched by the API).
  const canSeeAttendeeDetails = session.telegram_group_url !== undefined
  const canManageLogistics = session.viewer.can_manage && canSeeAttendeeDetails

  const handleAskToUpdate = async () => {
    if (!askMessage.trim()) return
    setAskState('sending')
    setError(null)
    try {
      await apiFetch(`/api/v1/sessions/${session.id}/request-update`, { method: 'POST', json: { message: askMessage.trim() } })
      setAskState('sent')
      setAskMessage('')
    } catch (err) {
      setAskState('idle')
      setError(err instanceof Error ? err.message : 'The request could not be sent')
    }
  }

  const handleAddTag = (tag: string) => {
    const normalized = tag.toLowerCase().trim()
    if (normalized && !form.tags.includes(normalized) && form.tags.length < 5) set('tags', [...form.tags, normalized])
    setCustomTag('')
  }

  const handleSave = async () => {
    if (canEditContent && !form.title.trim()) {
      setError('Title is required')
      return
    }
    if (form.isSelfHosted && form.day && form.startTime && form.endTime && form.endTime <= form.startTime) {
      setError('The end time must be after the start time.')
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      const withTimes = form.isSelfHosted && !!form.day
      // Send only what this viewer has authority over; the server enforces the same split.
      const body: Record<string, unknown> = {}
      if (canEditContent) {
        Object.assign(body, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          format: form.format,
          topic_tags: form.tags.length ? form.tags : null,
          skills: form.skills,
          is_self_hosted: form.isSelfHosted,
        })
        if (form.isSelfHosted) {
          body.self_hosted_start_time = withTimes && form.startTime ? parseTimeInTimezone(form.startTime, form.day, event.timezone).toISOString() : null
          body.self_hosted_end_time = withTimes && form.endTime ? parseTimeInTimezone(form.endTime, form.day, event.timezone).toISOString() : null
          if (canSeeAttendeeDetails) body.custom_location = form.customLocation.trim() || null
          body.public_place = form.publicPlace.trim() || null
        }
      }
      if (canSetTrack && form.trackId !== session.track_id) body.track_id = form.trackId
      if (canManageLogistics) body.telegram_group_url = form.telegram.trim() || null

      if (session.viewer.is_host) {
        const before = initial()
        const changed = JSON.stringify(before.availability) !== JSON.stringify({ windows: form.availability.windows, blackouts: form.availability.blackouts })
          || before.publishAvailability !== form.publishAvailability
        if (changed) {
          body.time_preference = { windows: form.availability.windows, blackouts: form.availability.blackouts, publish: form.publishAvailability }
        }
      }

      if (isOrganizer) {
        if ((form.sessionType || 'proposed') !== (session.session_type || 'proposed')) body.session_type = form.sessionType
        if (form.status !== session.status) body.status = form.status
        // An organizer moving a host-less session to self-hosted also releases its official slot.
        if (canEditContent && form.isSelfHosted && !session.is_self_hosted && (session.venue || session.time_slot)) {
          body.venue_id = null
          body.time_slot_id = null
        }
      }

      if (Object.keys(body).length === 0) {
        onClose()
        return
      }
      const result = await apiFetch<{ session: SessionView; atproto?: { error?: string } }>(`/api/v1/sessions/${session.id}`, {
        method: 'PATCH',
        json: body,
      })
      onSave(result.session)
      if (result.atproto?.error) {
        setError(`Saved. Updating the public proposal record failed: ${result.atproto.error}`)
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update session')
    } finally {
      setIsSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-session-title"
        className="fixed inset-4 md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-full md:max-w-lg bg-card border rounded-2xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden"
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h2 id="edit-session-title" className="text-lg font-semibold">Edit Session</h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-muted transition-colors" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {error && (
            <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">{error}</div>
          )}

          {canEditContent && session.viewer.is_host && session.proposal_uri && (
            <p className="text-xs text-muted-foreground rounded-lg border p-3">
              This proposal is a public record in your own repository. Saving content changes updates that record.
            </p>
          )}

          {authored && !canEditContent && (
            <div className="rounded-lg border p-3 space-y-3">
              <p className="text-xs text-muted-foreground flex items-start gap-2">
                <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                This proposal belongs to its proposer: its title, description, format, skills, place and time are theirs to change.
                {isOrganizer ? ' You can still set its track, review status and type.' : ''}
              </p>
              {isOrganizer && (
                <div className="space-y-2">
                  <label htmlFor="ask-proposer" className="text-sm font-medium flex items-center gap-2">
                    <MessageSquareWarning className="h-4 w-4" />
                    Ask the proposer to update
                  </label>
                  <Textarea
                    id="ask-proposer"
                    value={askMessage}
                    onChange={(e) => { setAskMessage(e.target.value); if (askState === 'sent') setAskState('idle') }}
                    placeholder="What would you like them to change, and why?"
                    rows={3}
                    maxLength={1000}
                  />
                  <div className="flex items-center gap-3">
                    <Button type="button" variant="outline" size="sm" onClick={handleAskToUpdate} disabled={!askMessage.trim() || askState === 'sending'}>
                      {askState === 'sending' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Send request
                    </Button>
                    {askState === 'sent' && <span role="status" className="text-xs text-muted-foreground">Sent. The proposer was notified.</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {canEditContent && (<>
          <div className="space-y-2">
            <label htmlFor="edit-title" className="text-sm font-medium">Title <span className="text-destructive">*</span></label>
            <Input id="edit-title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="What's your session about?" maxLength={100} />
            <p className="text-xs text-muted-foreground">{form.title.length}/100</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="edit-description" className="text-sm font-medium">Description</label>
            <Textarea id="edit-description" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Describe what participants will learn or experience..." rows={4} maxLength={500} />
            <p className="text-xs text-muted-foreground">{form.description.length}/500</p>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">Format</span>
            <div className="grid grid-cols-2 gap-2">
              {allowedFormats.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={form.format === f.value}
                  onClick={() => set('format', f.value)}
                  className={cn('p-3 rounded-lg border text-left transition-colors', form.format === f.value ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}
                >
                  <div className="font-medium text-sm">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.description}</div>
                </button>
              ))}
            </div>
          </div>
          </>)}

          {canSetTrack && tracks.length > 0 && (
            <div className="space-y-2">
              <span className="text-sm font-medium">Track</span>
              <div className="grid grid-cols-2 gap-2">
                {[{ id: null as string | null, name: 'None', color: null as string | null }, ...tracks].map((track) => (
                  <button
                    key={track.id ?? 'none'}
                    type="button"
                    aria-pressed={form.trackId === track.id}
                    onClick={() => set('trackId', track.id)}
                    className={cn('px-3 py-2 rounded-lg border text-sm transition-colors text-left flex items-center gap-2', form.trackId === track.id ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}
                  >
                    {track.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: track.color }} />}
                    <span className="truncate">{track.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {canEditContent && (<>
          <SkillPicker
            value={form.skills}
            onChange={(skills) => set('skills', skills.slice(0, 5))}
            max={5}
            label="Skills (up to 5)"
            description="From the shared skill taxonomy."
          />

          <div className="space-y-3">
            <span className="text-sm font-medium">Hosting</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={!form.isSelfHosted}
                onClick={() => set('isSelfHosted', false)}
                className={cn('p-3 rounded-lg border text-left transition-colors', !form.isSelfHosted ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}
              >
                <div className="font-medium text-sm">Official Venue</div>
                <div className="text-xs text-muted-foreground">Assigned by organizers</div>
              </button>
              <button
                type="button"
                aria-pressed={form.isSelfHosted}
                onClick={() => set('isSelfHosted', true)}
                className={cn('p-3 rounded-lg border text-left transition-colors', form.isSelfHosted ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50')}
              >
                <div className="font-medium text-sm">Self-Hosted</div>
                <div className="text-xs text-muted-foreground">Your own location</div>
              </button>
            </div>

            {form.isSelfHosted && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Day</span>
                  <div className="flex flex-wrap gap-1.5">
                    {eventDays.map((day) => (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={form.day === day.value}
                        onClick={() => set('day', form.day === day.value ? '' : day.value)}
                        className={cn('px-2.5 py-1.5 rounded-md border text-xs transition-colors', form.day === day.value ? 'border-primary bg-primary/10 font-medium' : 'hover:border-muted-foreground/50')}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>
                {form.day && (
                  <div className="flex items-center gap-2">
                    <select aria-label="Start time" value={form.startTime} onChange={(e) => set('startTime', e.target.value)} className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm">
                      <option value="">Start</option>
                      {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <span className="text-xs text-muted-foreground">to</span>
                    <select aria-label="End time" value={form.endTime} onChange={(e) => set('endTime', e.target.value)} className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm">
                      <option value="">End</option>
                      {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                )}
                {canSeeAttendeeDetails && (
                  <div className="space-y-1.5">
                    <label htmlFor="edit-location" className="text-xs font-medium text-muted-foreground">Location / Address</label>
                    <Textarea id="edit-location" value={form.customLocation} onChange={(e) => set('customLocation', e.target.value)} placeholder="Address or directions for attendees..." rows={2} maxLength={300} />
                    <p className="text-xs text-muted-foreground">Shown only to confirmed attendees, hosts and organizers.</p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <label htmlFor="edit-public-place" className="text-xs font-medium text-muted-foreground">Public area (optional)</label>
                  <input id="edit-public-place" type="text" value={form.publicPlace} onChange={(e) => set('publicPlace', e.target.value)} placeholder="e.g. Near Pearl St, Boulder" maxLength={80} className="w-full rounded-md border bg-background px-3 py-1.5 text-sm" />
                  <p className="text-xs text-muted-foreground">A neighbourhood or landmark, never a street address. It appears on your public proposal record.</p>
                </div>
              </div>
            )}
          </div>
          </>)}

          {session.viewer.is_host && eventDays.length > 0 && (
            <div className="space-y-2">
              <span className="text-sm font-medium">Your availability</span>
              <p className="text-xs text-muted-foreground">Organizers use this to schedule you. It stays in this gathering unless you publish it.</p>
              <TimePreferences
                value={form.availability}
                onChange={(value) => set('availability', { windows: value.windows, blackouts: value.blackouts })}
                timezone={event.timezone}
                startDate={eventDays[0].value}
                endDate={eventDays[eventDays.length - 1].value}
              />
              <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3">
                <Checkbox
                  checked={form.publishAvailability}
                  onCheckedChange={(checked) => set('publishAvailability', checked === true)}
                  className="mt-0.5"
                />
                <span className="text-xs text-muted-foreground">
                  <span className="block text-sm font-medium text-foreground">Publish my availability for this proposal</span>
                  Writes a public record to your repository saying when you can and cannot attend. Public records can be deleted later, but copies may persist on the network.
                </span>
              </label>
            </div>
          )}

          {canManageLogistics && (
            <div className="space-y-2">
              <label htmlFor="edit-telegram" className="text-sm font-medium flex items-center gap-2">
                <Send className="h-4 w-4" />
                Telegram Group URL (optional)
              </label>
              <Input id="edit-telegram" type="url" placeholder="https://t.me/your_group" value={form.telegram} onChange={(e) => set('telegram', e.target.value)} />
              <p className="text-xs text-muted-foreground">Shared with confirmed attendees only.</p>
            </div>
          )}

          {canEditContent && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Tags (up to 5)</span>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {form.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="cursor-pointer hover:bg-destructive/20" onClick={() => set('tags', form.tags.filter((t) => t !== tag))}>
                  {tag} ×
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Add a tag"
                value={customTag}
                onChange={(e) => setCustomTag(e.target.value)}
                placeholder="Add a tag..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddTag(customTag)
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={() => handleAddTag(customTag)} disabled={!customTag.trim() || form.tags.length >= 5}>Add</Button>
            </div>
            {event.suggestedTopics.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {event.suggestedTopics.map((t) => t.toLowerCase()).filter((t) => !form.tags.includes(t)).slice(0, 6).map((tag) => (
                  <button key={tag} type="button" onClick={() => handleAddTag(tag)} className="px-2 py-1 text-xs rounded border hover:bg-accent" disabled={form.tags.length >= 5}>
                    + {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {isOrganizer && (
            <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
              <p className="text-sm font-medium flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Organizer settings
              </p>
              {session.unclaimed && (
                <p className="text-xs text-muted-foreground">
                  {session.listed_as ? <>Listed as <span className="font-medium text-foreground">{session.listed_as}</span>. </> : null}
                  Unclaimed: no participant has proposed or claimed this session. Listing labels are managed in the admin sessions view and are never shown publicly.
                </p>
              )}
              {session.status !== 'scheduled' && (
                <div className="space-y-1.5">
                  <label htmlFor="edit-review-status" className="text-xs font-medium text-muted-foreground">Review status</label>
                  <select id="edit-review-status" value={form.status} onChange={(e) => set('status', e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                    {REVIEW_STATUSES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <label htmlFor="edit-session-type" className="text-xs font-medium text-muted-foreground">Session type</label>
                <select id="edit-session-type" value={form.sessionType} onChange={(e) => set('sessionType', e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                  {SESSION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <p className="text-xs text-muted-foreground">
                Venue and time are set in the schedule builder. None of these settings change the proposer&apos;s record.
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-3 p-4 border-t">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving} className="flex-1">
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </div>
    </>
  )
}
