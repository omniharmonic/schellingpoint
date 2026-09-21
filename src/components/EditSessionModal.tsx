'use client'

import * as React from 'react'
import { MessageSquareWarning, ShieldCheck, Lock, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { FilterChip } from '@/components/ui/filter-chip'
import { RemovableChip } from '@/components/ui/removable-chip'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { useTracks } from '@/hooks/useTracks'
import { useEvent } from '@/contexts/EventContext'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import { apiFetch } from '@/lib/api/client'
import { SkillPicker } from '@/components/SkillPicker'
import { TimePreferences, type TimePreferenceValue, type TimeWindowValue } from '@/components/TimePreferences'
import { SESSION_STATUS } from '@/lib/labels'
import { allowedFormatOptions, MAX_TAGS, TIME_OPTIONS } from '@/lib/sessions/constants'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

const SESSION_TYPES = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'curated', label: 'Curated' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'track_reserved', label: 'Track reserved' },
]

const REVIEW_STATUSES = (['pending', 'approved', 'rejected'] as const).map((value) => ({ value, label: SESSION_STATUS[value].label }))

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

/** A selectable option card (format, hosting, track). */
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
 *   - attendee logistics (the chat group link; stored as `telegram_group_url`, labelled
 *     generically in the UI): hosts, co-hosts, organizers
 *   - review status and session type: organizers
 * Hosts are never assigned here: co-hosts accept invites themselves (R9). Scheduling happens
 * in the schedule builder.
 */
export function EditSessionModal({ isOpen, onClose, session, onSave }: EditSessionModalProps) {
  const event = useEvent()
  const { tracks } = useTracks(event.slug)
  const { toast } = useToast()
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

  const allowedFormats = React.useMemo(
    () => allowedFormatOptions(event.allowedFormats, session.format),
    [event.allowedFormats, session.format],
  )

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
      chatUrl: session.telegram_group_url || '',
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
      setCustomTag('')
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
      toast({ title: 'Request sent', description: 'The proposer was notified.', variant: 'success' })
    } catch (err) {
      setAskState('idle')
      setError(err instanceof Error ? err.message : 'The request could not be sent. Please try again.')
    }
  }

  const handleAddTag = (tag: string) => {
    const normalized = tag.toLowerCase().trim()
    if (normalized && !form.tags.includes(normalized) && form.tags.length < MAX_TAGS) set('tags', [...form.tags, normalized])
    setCustomTag('')
  }

  const handleSave = async () => {
    if (canEditContent && !form.title.trim()) {
      setError('Give the session a title.')
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
      // The UI says "chat group link"; the column and API field keep their historical name.
      if (canManageLogistics) body.telegram_group_url = form.chatUrl.trim() || null

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
        setError(`Saved in this gathering, but updating the public proposal record failed: ${result.atproto.error}`)
        return
      }
      toast({ title: 'Changes saved', variant: 'success' })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The session could not be updated. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const tagsFull = form.tags.length >= MAX_TAGS

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !isSaving) onClose() }}>
      <DialogContent size="lg" className="max-h-[calc(100dvh-2rem)] gap-0 p-0">
        <div className="p-6 pb-4">
          <DialogHeader>
            <DialogTitle>Edit session</DialogTitle>
            <DialogDescription>
              {canEditContent && session.viewer.is_host && session.proposal_uri
                ? 'This proposal is a public record in your own repository. Saving content changes updates that record.'
                : 'Changes are visible to organizers right away.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-6 px-6 pb-6">
          {error && (
            <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}

          {authored && !canEditContent && (
            <div className="space-y-3 rounded-xl border p-4">
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  This proposal belongs to its proposer: its title, description, format, skills, place and time are theirs to change.
                  {isOrganizer ? ' You can still set its track, review status and type.' : ''}
                </span>
              </p>
              {isOrganizer && (
                <div className="space-y-2">
                  <Label htmlFor="ask-proposer" className="flex items-center gap-2">
                    <MessageSquareWarning className="h-4 w-4" aria-hidden />
                    Ask the proposer to update
                  </Label>
                  <Textarea
                    id="ask-proposer"
                    value={askMessage}
                    onChange={(e) => { setAskMessage(e.target.value); if (askState === 'sent') setAskState('idle') }}
                    placeholder="What would you like them to change, and why?"
                    rows={3}
                    maxLength={1000}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="outline" size="sm" onClick={handleAskToUpdate} loading={askState === 'sending'} disabled={!askMessage.trim()}>
                      Send request
                    </Button>
                    {askState === 'sent' && <span role="status" className="text-sm text-success">Sent. The proposer was notified.</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {canEditContent && (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-title">Title</Label>
                <Input id="edit-title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="What’s your session about?" maxLength={100} required aria-describedby="edit-title-count" />
                <p id="edit-title-count" className="text-xs text-muted-foreground">{form.title.length}/100</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-description">Description (optional)</Label>
                <Textarea id="edit-description" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Describe what participants will learn or experience…" rows={4} maxLength={500} aria-describedby="edit-description-count" />
                <p id="edit-description-count" className="text-xs text-muted-foreground">{form.description.length}/500</p>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">Format</legend>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  {allowedFormats.map((f) => (
                    <OptionButton key={f.value} selected={form.format === f.value} onClick={() => set('format', f.value)}>
                      <div className="text-sm font-medium">{f.label}</div>
                      <div className="text-xs text-muted-foreground">{f.description}</div>
                    </OptionButton>
                  ))}
                </div>
              </fieldset>
            </>
          )}

          {canSetTrack && tracks.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium leading-none">Track</legend>
              <div className="grid grid-cols-2 gap-3 pt-2">
                {[{ id: null as string | null, name: 'None', color: null as string | null }, ...tracks].map((track) => (
                  <OptionButton
                    key={track.id ?? 'none'}
                    selected={form.trackId === track.id}
                    onClick={() => set('trackId', track.id)}
                    className="flex items-center gap-2 text-sm"
                  >
                    {track.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: track.color }} aria-hidden />}
                    <span className="truncate">{track.name}</span>
                  </OptionButton>
                ))}
              </div>
            </fieldset>
          )}

          {canEditContent && (
            <>
              <SkillPicker
                value={form.skills}
                onChange={(skills) => set('skills', skills.slice(0, 5))}
                max={5}
                label="Skills (optional, up to 5)"
                description="From the shared skill taxonomy."
              />

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium leading-none">Hosting</legend>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <OptionButton selected={!form.isSelfHosted} onClick={() => set('isSelfHosted', false)}>
                    <div className="text-sm font-medium">Official venue</div>
                    <div className="text-xs text-muted-foreground">Assigned by organizers</div>
                  </OptionButton>
                  <OptionButton selected={form.isSelfHosted} onClick={() => set('isSelfHosted', true)}>
                    <div className="text-sm font-medium">Self-hosted</div>
                    <div className="text-xs text-muted-foreground">Your own location</div>
                  </OptionButton>
                </div>

                {form.isSelfHosted && (
                  <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium leading-none">Day (optional)</legend>
                      <div className="flex flex-wrap gap-2 pt-2">
                        {eventDays.map((day) => (
                          <FilterChip key={day.value} pressed={form.day === day.value} onClick={() => set('day', form.day === day.value ? '' : day.value)}>
                            {day.label}
                          </FilterChip>
                        ))}
                      </div>
                    </fieldset>
                    {form.day && (
                      <div className="flex items-center gap-2">
                        <Select aria-label="Start time" value={form.startTime} onChange={(e) => set('startTime', e.target.value)}>
                          <option value="">Start time</option>
                          {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </Select>
                        <span className="text-sm text-muted-foreground">to</span>
                        <Select aria-label="End time" value={form.endTime} onChange={(e) => set('endTime', e.target.value)}>
                          <option value="">End time</option>
                          {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </Select>
                      </div>
                    )}
                    {canSeeAttendeeDetails && (
                      <div className="space-y-2">
                        <Label htmlFor="edit-location">Location details</Label>
                        <Textarea id="edit-location" value={form.customLocation} onChange={(e) => set('customLocation', e.target.value)} placeholder="Address or directions for attendees…" rows={2} maxLength={300} aria-describedby="edit-location-hint" />
                        <p id="edit-location-hint" className="text-xs text-muted-foreground">Shown only to confirmed attendees, hosts and organizers.</p>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="edit-public-place">Public area (optional)</Label>
                      <Input id="edit-public-place" value={form.publicPlace} onChange={(e) => set('publicPlace', e.target.value)} placeholder="e.g. Near Pearl St, Boulder" maxLength={80} aria-describedby="edit-public-place-hint" />
                      <p id="edit-public-place-hint" className="text-xs text-muted-foreground">A neighborhood or landmark, never a street address. It appears on your public proposal record.</p>
                    </div>
                  </div>
                )}
              </fieldset>
            </>
          )}

          {session.viewer.is_host && eventDays.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium leading-none">Your availability (optional)</legend>
              <p className="text-xs text-muted-foreground">Organizers use this to schedule you. It stays in this gathering unless you publish it.</p>
              <TimePreferences
                value={form.availability}
                onChange={(value) => set('availability', { windows: value.windows, blackouts: value.blackouts })}
                timezone={event.timezone}
                startDate={eventDays[0].value}
                endDate={eventDays[eventDays.length - 1].value}
              />
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3">
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
            </fieldset>
          )}

          {canManageLogistics && (
            <div className="space-y-2">
              <Label htmlFor="edit-chat-url" className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4" aria-hidden />
                Chat group link (optional)
              </Label>
              <Input id="edit-chat-url" type="url" placeholder="https://…" value={form.chatUrl} onChange={(e) => set('chatUrl', e.target.value)} aria-describedby="edit-chat-url-hint" />
              <p id="edit-chat-url-hint" className="text-xs text-muted-foreground">Telegram, Signal, Discord, Matrix — any link. Shared with confirmed attendees only.</p>
            </div>
          )}

          {canEditContent && (
            <div className="space-y-2">
              <Label htmlFor="edit-tag">Tags (optional)</Label>
              {form.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.tags.map((tag) => (
                    <RemovableChip key={tag} label={tag} onRemove={() => set('tags', form.tags.filter((t) => t !== tag))} />
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  id="edit-tag"
                  value={customTag}
                  onChange={(e) => setCustomTag(e.target.value)}
                  placeholder="Add a tag…"
                  maxLength={40}
                  disabled={tagsFull}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddTag(customTag)
                    }
                  }}
                  aria-describedby="edit-tag-count"
                />
                <Button type="button" variant="outline" onClick={() => handleAddTag(customTag)} disabled={!customTag.trim() || tagsFull}>Add</Button>
              </div>
              <p id="edit-tag-count" className="text-xs text-muted-foreground">
                {tagsFull ? `${MAX_TAGS} of ${MAX_TAGS} tags used. Remove one to add another.` : `${form.tags.length} of ${MAX_TAGS} tags used.`}
              </p>
              {!tagsFull && event.suggestedTopics.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Suggested:</span>
                  {event.suggestedTopics.map((t) => t.toLowerCase()).filter((t) => !form.tags.includes(t)).slice(0, 6).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleAddTag(tag)}
                      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      aria-label={`Add tag ${tag}`}
                    >
                      <Badge variant="muted" className="cursor-pointer hover:bg-accent hover:text-foreground">+ {tag}</Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {isOrganizer && (
            <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  Organizer settings
                </Badge>
              </div>
              {session.unclaimed && (
                <p className="text-xs text-muted-foreground">
                  {session.listed_as ? <>Listed as <span className="font-medium text-foreground">{session.listed_as}</span>. </> : null}
                  Unclaimed: no participant has proposed or claimed this session. Listing labels are managed in the organizer sessions view and are never shown publicly.
                </p>
              )}
              {session.status !== 'scheduled' && (
                <div className="space-y-2">
                  <Label htmlFor="edit-review-status">Review status</Label>
                  <Select id="edit-review-status" value={form.status} onChange={(e) => set('status', e.target.value)}>
                    {REVIEW_STATUSES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="edit-session-type">Session type</Label>
                <Select id="edit-session-type" value={form.sessionType} onChange={(e) => set('sessionType', e.target.value)}>
                  {SESSION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Venue and time are set in the schedule builder. None of these settings change the proposer’s record.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
          <Button type="button" onClick={handleSave} loading={isSaving}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
