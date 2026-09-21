'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, MapPin, Building2, Clock, Users, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/select'
import { FilterChip } from '@/components/ui/filter-chip'
import { RemovableChip } from '@/components/ui/removable-chip'
import { Label } from '@/components/ui/label'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { SuccessPanel } from '@/components/SuccessPanel'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { parseTimeInTimezone, formatInEventTimezone } from '@/lib/events/timezone'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { apiFetch } from '@/lib/api/client'
import { useTracks } from '@/hooks/useTracks'
import { SkillPicker } from '@/components/SkillPicker'
import { TimePreferences, type TimePreferenceValue } from '@/components/TimePreferences'
import {
  allowedDurationOptions,
  allowedFormatOptions,
  DEFAULT_TAGS,
  durationLabel,
  EXPECTED_ATTENDANCE,
  MAX_TAGS,
  TIME_OPTIONS,
} from '@/lib/sessions/constants'
import { cn } from '@/lib/utils'

/** Said wherever a record is written into someone's own repository. */
const PERMANENCE = 'Public records can be deleted from your repository later, but copies may persist on the network.'

function buildTimestamp(day: string, time: string, timezone: string): string {
  return parseTimeInTimezone(time, day, timezone).toISOString()
}

/** A selectable option card (format, duration, attendance, track, venue type). */
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

function FieldHint({ children, id }: { children: React.ReactNode; id?: string }) {
  return <p id={id} className="text-xs text-muted-foreground">{children}</p>
}

export default function ProposePage() {
  const router = useRouter()
  const { user, profile, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const proposalsClosed = !isParticipationOpen(event, 'propose')

  const { tracks } = useTracks(event.slug)
  const [title, setTitle] = React.useState('')
  const [trackId, setTrackId] = React.useState<string | null>(null)
  const [description, setDescription] = React.useState('')
  const [format, setFormat] = React.useState('talk')
  const [duration, setDuration] = React.useState(60)
  const [expectedAttendance, setExpectedAttendance] = React.useState<number | null>(null)
  const [tags, setTags] = React.useState<string[]>([])
  const [customTag, setCustomTag] = React.useState('')
  const [skills, setSkills] = React.useState<string[]>([])
  const [availability, setAvailability] = React.useState<TimePreferenceValue>({ windows: [], blackouts: [] })
  const [publishAvailability, setPublishAvailability] = React.useState(false)
  const [isSelfHosted, setIsSelfHosted] = React.useState(false)
  const [customLocation, setCustomLocation] = React.useState('')
  const [publicPlace, setPublicPlace] = React.useState('')
  const [selfHostedDay, setSelfHostedDay] = React.useState('')
  const [selfHostedStartTime, setSelfHostedStartTime] = React.useState('')
  const [selfHostedEndTime, setSelfHostedEndTime] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [created, setCreated] = React.useState<{ id: string; title: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [publishNote, setPublishNote] = React.useState<string | null>(null)
  // Custodial accounts publish the proposal into their own repository on submit; accounts from
  // the Bluesky door do so once they have confirmed public linkage (spec §4.2, §7).
  const publishesNow = user?.kind === 'custodial' || !!profile?.publish_proposals

  const eventDays = React.useMemo(() => {
    return getEventDays(event.startDate, event.endDate).map((date) => ({
      value: date,
      label: formatCalendarDate(date, { weekday: 'short', month: 'short', day: 'numeric' }),
    }))
  }, [event.startDate, event.endDate])

  const allowedFormats = React.useMemo(() => allowedFormatOptions(event.allowedFormats), [event.allowedFormats])
  const allowedDurations = React.useMemo(() => allowedDurationOptions(event.allowedDurations), [event.allowedDurations])

  // The gathering's own topics when it has them; otherwise a neutral set.
  const suggestedTags = React.useMemo(() => {
    const topics = event.suggestedTopics && event.suggestedTopics.length > 0 ? event.suggestedTopics : DEFAULT_TAGS
    return topics.map((t) => t.toLowerCase())
  }, [event.suggestedTopics])

  React.useEffect(() => {
    if (!authLoading && !user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/propose`)}`)
    }
  }, [user, authLoading, router, event.slug])

  React.useEffect(() => {
    if (allowedFormats.length > 0 && !allowedFormats.some((f) => f.value === format)) setFormat(allowedFormats[0].value)
  }, [allowedFormats, format])

  React.useEffect(() => {
    if (allowedDurations.length > 0 && !allowedDurations.includes(duration)) setDuration(allowedDurations[0])
  }, [allowedDurations, duration])

  const handleAddTag = (tag: string) => {
    const normalizedTag = tag.toLowerCase().trim()
    if (normalizedTag && !tags.includes(normalizedTag) && tags.length < MAX_TAGS) setTags([...tags, normalizedTag])
    setCustomTag('')
  }

  const handleRemoveTag = (tag: string) => setTags(tags.filter((t) => t !== tag))

  const resetForm = () => {
    setCreated(null)
    setTitle('')
    setDescription('')
    setFormat(allowedFormats[0]?.value ?? 'talk')
    setDuration(allowedDurations.includes(60) ? 60 : allowedDurations[0] ?? 60)
    setExpectedAttendance(null)
    setTags([])
    setSkills([])
    setAvailability({ windows: [], blackouts: [] })
    setPublishAvailability(false)
    setPublishNote(null)
    setIsSelfHosted(false)
    setCustomLocation('')
    setPublicPlace('')
    setSelfHostedDay('')
    setSelfHostedStartTime('')
    setSelfHostedEndTime('')
    setTrackId(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !profile) return
    if (!title.trim()) {
      setError('Give your session a title.')
      return
    }
    if (isSelfHosted && !customLocation.trim()) {
      setError('Tell attendees where a self-hosted session takes place.')
      return
    }
    if (isSelfHosted && selfHostedDay && (!selfHostedStartTime || !selfHostedEndTime)) {
      setError('Pick both a start and an end time for your self-hosted session.')
      return
    }
    if (isSelfHosted && selfHostedDay && selfHostedStartTime && selfHostedEndTime && selfHostedEndTime <= selfHostedStartTime) {
      setError('The end time must be after the start time.')
      return
    }

    setIsSubmitting(true)
    setError(null)
    setPublishNote(null)

    const hasAvailability = availability.windows.length > 0 || availability.blackouts.length > 0
    try {
      const result = await apiFetch<{ id: string; status: string; atproto?: { uri?: string; error?: string; skipped?: string } }>('/api/v1/sessions', {
        method: 'POST',
        json: {
          event_slug: event.slug,
          title: title.trim(),
          description: description.trim() || null,
          format,
          duration,
          expected_attendance: expectedAttendance,
          topic_tags: tags.length > 0 ? tags : null,
          skills,
          is_self_hosted: isSelfHosted,
          custom_location: isSelfHosted ? customLocation.trim() || null : null,
          public_place: isSelfHosted ? publicPlace.trim() || null : null,
          self_hosted_start_time: isSelfHosted && selfHostedDay && selfHostedStartTime
            ? buildTimestamp(selfHostedDay, selfHostedStartTime, event.timezone) : null,
          self_hosted_end_time: isSelfHosted && selfHostedDay && selfHostedEndTime
            ? buildTimestamp(selfHostedDay, selfHostedEndTime, event.timezone) : null,
          track_id: trackId,
          ...(hasAvailability || publishAvailability
            ? { time_preference: { windows: availability.windows, blackouts: availability.blackouts, publish: publishAvailability } }
            : {}),
        },
      })
      if (result.atproto?.uri) setPublishNote('Your proposal is now a public record in your own repository.')
      else if (result.atproto?.error) setPublishNote('Your proposal is saved. Writing its public record failed; you can publish it from the session page.')
      else if (result.atproto?.skipped === 'not_confirmed') setPublishNote('Your proposal is saved in this gathering. Confirm public linkage from the session page to publish it to your repository.')
      setCreated({ id: result.id, title: title.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your proposal could not be submitted. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (authLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  if (proposalsClosed) {
    const opensAt = event.proposalsOpenAt && event.proposalsOpenAt.getTime() > Date.now() ? event.proposalsOpenAt : null
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl">
          <PageHeader
            title="Proposals aren’t open right now"
            subtitle={
              opensAt
                ? `Proposals open ${formatInEventTimezone(opensAt, event.timezone, 'datetime')}. Explore the sessions while the organizers prepare the next phase.`
                : 'Explore the sessions while the organizers prepare the next phase.'
            }
          />
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/e/${event.slug}/sessions`}>Explore sessions</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/e/${event.slug}`}>Back to {event.name}</Link>
            </Button>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  if (created) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl">
          <SuccessPanel
            title="Your session is proposed"
            body={
              <>
                {event.requireProposalApproval
                  ? `“${created.title}” is ready for organizer review. An organizer will approve it for voting.`
                  : `“${created.title}” is now in the voting pool for the community to discover.`}
                {publishNote ? ` ${publishNote}` : ''}
                {' '}Want co-hosts? Share an invite link from the session page; they accept it themselves.
              </>
            }
            primary={
              <Button asChild>
                <Link href={`/e/${event.slug}/sessions/${created.id}`}>View your session</Link>
              </Button>
            }
            secondary={
              <Button variant="outline" onClick={resetForm}>
                Propose another
              </Button>
            }
          />
        </div>
      </DashboardLayout>
    )
  }

  const tagsFull = tags.length >= MAX_TAGS

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title="Propose a session"
          subtitle={`A question, a skill, a conversation worth having. What would you like to explore with ${event.name}?`}
        />

        <Card>
          <CardHeader>
            <CardTitle>Session details</CardTitle>
            <CardDescription>
              {event.requireProposalApproval
                ? 'Organizers review proposals before they appear for voting.'
                : 'Proposals go straight into the voting pool.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6" noValidate>
              <div className="space-y-2">
                <Label htmlFor="propose-title">Title</Label>
                <Input
                  id="propose-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What’s your session about?"
                  maxLength={100}
                  required
                  aria-describedby="propose-title-count"
                />
                <FieldHint id="propose-title-count">{title.length}/100</FieldHint>
              </div>

              <div className="space-y-2">
                <Label htmlFor="propose-description">Description (optional)</Label>
                <Textarea
                  id="propose-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe what participants will learn or experience…"
                  rows={4}
                  maxLength={500}
                  aria-describedby="propose-description-count"
                />
                <FieldHint id="propose-description-count">{description.length}/500</FieldHint>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">Format</legend>
                <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
                  {allowedFormats.map((f) => (
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
                  {allowedDurations.map((d) => (
                    <OptionButton key={d} selected={duration === d} onClick={() => setDuration(d)} className="text-center text-sm">
                      {durationLabel(d)}
                    </OptionButton>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="flex items-center gap-2 text-sm font-medium leading-none">
                  <Users className="h-4 w-4" aria-hidden />
                  Expected attendance (optional)
                </legend>
                <FieldHint>Helps organizers assign a room that fits.</FieldHint>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {EXPECTED_ATTENDANCE.map((opt) => (
                    <OptionButton
                      key={opt.value}
                      selected={expectedAttendance === opt.value}
                      onClick={() => setExpectedAttendance(expectedAttendance === opt.value ? null : opt.value)}
                    >
                      <div className="text-sm font-medium">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.description}</div>
                    </OptionButton>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium leading-none">When can you be there? (optional)</legend>
                <FieldHint>Organizers use this to schedule you. It stays inside this gathering unless you choose to publish it.</FieldHint>
                <TimePreferences
                  value={availability}
                  onChange={setAvailability}
                  startDate={eventDays[0]?.value ?? ''}
                  endDate={eventDays[eventDays.length - 1]?.value ?? ''}
                  timezone={event.timezone}
                />
                {(availability.windows.length > 0 || availability.blackouts.length > 0) && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3">
                    <Checkbox
                      id="publish-availability"
                      checked={publishAvailability}
                      onCheckedChange={(checked) => setPublishAvailability(checked === true)}
                      className="mt-0.5"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Also publish my availability for this proposal</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Writes a public record to your repository saying when you can and cannot attend. {PERMANENCE}
                      </span>
                    </span>
                  </label>
                )}
              </fieldset>

              {tracks.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium leading-none">Track (optional)</legend>
                  <FieldHint>Which theme does your session fit best?</FieldHint>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <OptionButton selected={trackId === null} onClick={() => setTrackId(null)} className="text-sm">
                      None
                    </OptionButton>
                    {tracks.map((track) => (
                      <OptionButton
                        key={track.id}
                        selected={trackId === track.id}
                        onClick={() => setTrackId(track.id)}
                        className="flex items-center gap-2 text-sm"
                      >
                        {track.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: track.color }} aria-hidden />}
                        <span className="truncate">{track.name}</span>
                      </OptionButton>
                    ))}
                  </div>
                </fieldset>
              )}

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium leading-none">Venue</legend>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <OptionButton selected={!isSelfHosted} onClick={() => setIsSelfHosted(false)} className="flex items-start gap-3 p-4">
                    <Building2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                    <span>
                      <span className="block text-sm font-medium">Official venue</span>
                      <span className="block text-xs text-muted-foreground">One of the gathering’s scheduled rooms</span>
                    </span>
                  </OptionButton>
                  <OptionButton selected={isSelfHosted} onClick={() => setIsSelfHosted(true)} className="flex items-start gap-3 p-4">
                    <MapPin className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                    <span>
                      <span className="block text-sm font-medium">Self-hosted</span>
                      <span className="block text-xs text-muted-foreground">Host at your own location</span>
                    </span>
                  </OptionButton>
                </div>

                {isSelfHosted && (
                  <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium leading-none">Which day? (optional)</legend>
                      <div className="flex flex-wrap gap-2 pt-2">
                        {eventDays.map((day) => (
                          <FilterChip
                            key={day.value}
                            pressed={selfHostedDay === day.value}
                            onClick={() => setSelfHostedDay(selfHostedDay === day.value ? '' : day.value)}
                          >
                            {day.label}
                          </FilterChip>
                        ))}
                      </div>
                    </fieldset>

                    {selfHostedDay && (
                      <fieldset className="space-y-2">
                        <legend className="flex items-center gap-2 text-sm font-medium leading-none">
                          <Clock className="h-4 w-4" aria-hidden />
                          Time
                        </legend>
                        <div className="flex items-center gap-2 pt-2">
                          <Select aria-label="Start time" value={selfHostedStartTime} onChange={(e) => setSelfHostedStartTime(e.target.value)}>
                            <option value="">Start time</option>
                            {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </Select>
                          <span className="text-sm text-muted-foreground">to</span>
                          <Select aria-label="End time" value={selfHostedEndTime} onChange={(e) => setSelfHostedEndTime(e.target.value)}>
                            <option value="">End time</option>
                            {TIME_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </Select>
                        </div>
                      </fieldset>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="propose-location" className="flex items-center gap-2">
                        <MapPin className="h-4 w-4" aria-hidden />
                        Location details
                      </Label>
                      <Textarea
                        id="propose-location"
                        value={customLocation}
                        onChange={(e) => setCustomLocation(e.target.value)}
                        placeholder="Where will your session be held? Include the address, room and any directions attendees need…"
                        rows={3}
                        maxLength={300}
                        aria-describedby="propose-location-hint"
                      />
                      <FieldHint id="propose-location-hint">
                        {customLocation.length}/300 · Shown only to confirmed attendees, hosts and organizers. Never published.
                      </FieldHint>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="propose-public-place">Public area (optional)</Label>
                      <Input
                        id="propose-public-place"
                        value={publicPlace}
                        onChange={(e) => setPublicPlace(e.target.value)}
                        placeholder="e.g. Near Pearl St, Boulder"
                        maxLength={80}
                        aria-describedby="propose-public-place-hint"
                      />
                      <FieldHint id="propose-public-place-hint">
                        A neighborhood or landmark, never a street address. This label goes on your public
                        proposal record, so anyone on the network can see it. Leave it empty to publish no location.
                      </FieldHint>
                    </div>
                  </div>
                )}
              </fieldset>

              <SkillPicker
                value={skills}
                onChange={(next) => setSkills(next.slice(0, 5))}
                max={5}
                label="Skills (optional, up to 5)"
                description="From the shared skill taxonomy, so people can find this session next to classes on the same subject."
              />

              <div className="space-y-2">
                <Label htmlFor="propose-tag">Tags (optional)</Label>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <RemovableChip key={tag} label={tag} onRemove={() => handleRemoveTag(tag)} />
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    id="propose-tag"
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
                    aria-describedby="propose-tag-count"
                  />
                  <Button type="button" variant="outline" onClick={() => handleAddTag(customTag)} disabled={!customTag.trim() || tagsFull}>
                    Add
                  </Button>
                </div>
                <FieldHint id="propose-tag-count">
                  {tagsFull ? `${MAX_TAGS} of ${MAX_TAGS} tags used. Remove one to add another.` : `${tags.length} of ${MAX_TAGS} tags used.`}
                </FieldHint>
                {!tagsFull && suggestedTags.filter((t) => !tags.includes(t)).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Suggested:</span>
                    {suggestedTags
                      .filter((t) => !tags.includes(t))
                      .slice(0, 6)
                      .map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => handleAddTag(tag)}
                          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          aria-label={`Add tag ${tag}`}
                        >
                          <Badge variant="muted" className="cursor-pointer hover:bg-accent hover:text-foreground">
                            + {tag}
                          </Badge>
                        </button>
                      ))}
                  </div>
                )}
              </div>

              <div className="space-y-2 rounded-xl border p-4 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <Globe className="h-4 w-4" aria-hidden />
                  Your proposal is yours
                </p>
                <p className="text-muted-foreground">
                  {user?.kind === 'custodial'
                    ? 'Submitting writes this proposal as a public record in your own repository. It names only you, travels with you, and no organizer can edit it.'
                    : publishesNow
                      ? 'Submitting writes this proposal as a public record in your own Bluesky/ATProto repository. It names only you, and no organizer can edit it.'
                      : 'Your proposal is saved in this gathering. It becomes a public record in your own Bluesky/ATProto repository after you confirm public linkage from the session page.'}{' '}
                  {PERMANENCE}
                </p>
                <p className="text-muted-foreground">
                  Co-hosts are never added on your say-so: after submitting, share an invite link and each co-host accepts it themselves.
                </p>
              </div>

              {error && (
                <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" asChild>
                  <Link href={`/e/${event.slug}/sessions`}>Cancel</Link>
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Propose a session
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
