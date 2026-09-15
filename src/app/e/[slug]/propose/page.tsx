'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, CheckCircle, MapPin, Building2, Clock, Users, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import { getEventDays, formatCalendarDate } from '@/lib/events/dates'
import { apiFetch } from '@/lib/api/client'
import { useTracks } from '@/hooks/useTracks'
import { SkillPicker } from '@/components/SkillPicker'
import { TimePreferences, type TimePreferenceValue } from '@/components/TimePreferences'
import { cn } from '@/lib/utils'

/** Said wherever a record is written into someone's own repository. */
const PERMANENCE = 'Public records can be deleted from your repository later, but copies may persist on the network.'

const formats = [
  { value: 'talk', label: 'Talk', description: 'A presentation or lecture' },
  { value: 'workshop', label: 'Workshop', description: 'Hands-on interactive session' },
  { value: 'discussion', label: 'Discussion', description: 'Open group conversation' },
  { value: 'panel', label: 'Panel', description: 'Multiple speakers discussing' },
  { value: 'demo', label: 'Demo', description: 'Live demonstration' },
]

const durations = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '60 min' },
  { value: 90, label: '90 min' },
]

const expectedAttendanceOptions = [
  { value: 10, label: 'Small (1-10)', description: 'Intimate discussion' },
  { value: 25, label: 'Medium (10-25)', description: 'Standard session' },
  { value: 50, label: 'Large (25-50)', description: 'Popular topic' },
  { value: 100, label: 'Very Large (50-100)', description: 'High interest' },
  { value: 150, label: 'Auditorium (100+)', description: 'Keynote level' },
]

// Default tags - will be overridden by event's suggestedTopics
const DEFAULT_TAGS = [
  'governance', 'defi', 'nfts', 'infrastructure', 'security',
  'community', 'education', 'tooling', 'research', 'design'
]

// Generate time options
const TIME_OPTIONS: { value: string; label: string }[] = []
for (let h = 9; h <= 22; h++) {
  for (const m of [0, 30]) {
    if (h === 22 && m === 30) continue
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    const label = `${h > 12 ? h - 12 : h === 0 ? 12 : h}:${mm} ${h >= 12 ? 'PM' : 'AM'}`
    TIME_OPTIONS.push({ value: `${hh}:${mm}`, label })
  }
}

function buildTimestamp(day: string, time: string, timezone: string): string {
  // Use the timezone utility to properly convert local time to UTC
  const date = parseTimeInTimezone(time, day, timezone)
  return date.toISOString()
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
  const [isSuccess, setIsSuccess] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [publishNote, setPublishNote] = React.useState<string | null>(null)
  // Custodial accounts publish the proposal into their own repository on submit; accounts from
  // the Bluesky door do so once they have confirmed public linkage (spec §4.2, §7).
  const publishesNow = user?.kind === 'custodial' || !!profile?.publish_proposals

  // Generate event days from event dates
  const eventDays = React.useMemo(() => {
    return getEventDays(event.startDate, event.endDate).map((date) => ({
      value: date,
      label: formatCalendarDate(date, { weekday: 'long', month: 'short', day: 'numeric' }),
    }))
  }, [event.startDate, event.endDate])

  // Humanize a custom format slug ("fireside-chat" -> "Fireside chat")
  const humanizeFormatValue = (value: string) => {
    const label = value
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    return label
  }

  // Filter formats/durations based on event settings, including any custom ones
  const allowedFormats = React.useMemo(() => {
    if (event.allowedFormats.length === 0) return formats
    // Start from preset formats that are enabled for the event
    const preset = formats.filter(f => event.allowedFormats.includes(f.value))
    // Add any event-defined formats not in the preset list
    const custom = event.allowedFormats
      .filter(v => !formats.some(f => f.value === v))
      .map(v => ({
        value: v,
        label: humanizeFormatValue(v),
        description: 'Custom format',
      }))
    return [...preset, ...custom]
  }, [event.allowedFormats])

  const allowedDurations = React.useMemo(() => {
    if (event.allowedDurations.length === 0) return durations
    const preset = durations.filter(d => event.allowedDurations.includes(d.value))
    const custom = event.allowedDurations
      .filter(v => !durations.some(d => d.value === v))
      .map(v => ({ value: v, label: `${v} min` }))
    return [...preset, ...custom].sort((a, b) => a.value - b.value)
  }, [event.allowedDurations])

  // Use event's suggested topics if available, with lowercase for tag matching
  const suggestedTags = React.useMemo(() => {
    const topics = event.suggestedTopics && event.suggestedTopics.length > 0
      ? event.suggestedTopics
      : DEFAULT_TAGS
    return topics.map(t => t.toLowerCase())
  }, [event.suggestedTopics])

  // Redirect if not logged in
  React.useEffect(() => {
    if (!authLoading && !user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/propose`)}`)
    }
  }, [user, authLoading, router, event.slug])

  // Ensure format/duration defaults match what the event allows
  React.useEffect(() => {
    if (allowedFormats.length > 0 && !allowedFormats.some(f => f.value === format)) {
      setFormat(allowedFormats[0].value)
    }
  }, [allowedFormats, format])

  React.useEffect(() => {
    if (allowedDurations.length > 0 && !allowedDurations.some(d => d.value === duration)) {
      setDuration(allowedDurations[0].value)
    }
  }, [allowedDurations, duration])

  const handleAddTag = (tag: string) => {
    const normalizedTag = tag.toLowerCase().trim()
    if (normalizedTag && !tags.includes(normalizedTag) && tags.length < 5) {
      setTags([...tags, normalizedTag])
    }
    setCustomTag('')
  }

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!user || !profile) return
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    if (isSelfHosted && !customLocation.trim()) {
      setError('Please provide location details for self-hosted sessions')
      return
    }
    if (isSelfHosted && selfHostedDay && (!selfHostedStartTime || !selfHostedEndTime)) {
      setError('Please provide both start and end times for your self-hosted session')
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
      setIsSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit proposal')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (authLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  if (proposalsClosed) {
    return <DashboardLayout><Card className="max-w-xl mx-auto p-8"><h1 className="text-2xl font-semibold">Proposals are not open right now.</h1><p className="mt-3 text-muted-foreground">Explore the sessions while the organizers prepare the next phase.</p><Button asChild className="mt-6"><Link href={`/e/${event.slug}/sessions`}>Explore sessions</Link></Button></Card></DashboardLayout>
  }

  if (isSuccess) {
    return (
      <DashboardLayout>
        <div className="max-w-md mx-auto py-8">
          <Card>
            <CardHeader className="text-center">
              <div className="flex justify-center mb-4">
                <div className="rounded-full bg-green-500/10 p-4">
                  <CheckCircle className="h-12 w-12 text-green-500" />
                </div>
              </div>
              <CardTitle className="text-2xl">Session Proposed!</CardTitle>
              <CardDescription>
                {event.requireProposalApproval ? `Your session “${title}” is ready for organizer review.` : `Your session “${title}” is now open for the community to discover.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted p-4 text-sm text-center space-y-2">
                <p>
                  {event.requireProposalApproval
                    ? 'An organizer will review your proposal and approve it for voting.'
                    : 'Your session has been added to the voting pool.'}
                </p>
                {publishNote && <p className="text-muted-foreground">{publishNote}</p>}
                <p className="text-muted-foreground">Want co-hosts? Share an invite link from the session page; they accept it themselves.</p>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" asChild>
                  <Link href={`/e/${event.slug}/sessions`}>View Sessions</Link>
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => {
                    setIsSuccess(false)
                    setTitle('')
                    setDescription('')
                    setFormat('talk')
                    setDuration(60)
                    setExpectedAttendance(null)
                    setTags([])
                    setSkills([])
                    setAvailability({ windows: [], blackouts: [] })
                    setPublishAvailability(false)
                    setPublishNote(null)
                    setIsSelfHosted(false)
                    setCustomLocation('')
                    setSelfHostedDay('')
                    setSelfHostedStartTime('')
                    setSelfHostedEndTime('')
                    setTrackId(null)
                  }}
                >
                  Propose Another
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Bring an idea to the room.</h1>
          <p className="text-muted-foreground mt-1">
            A question, a skill, a conversation worth having. What would you like to explore with {event.name}?
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Propose a Session</CardTitle>
            <CardDescription>
              Share your knowledge with the community.
              {event.requireProposalApproval
                ? ' Sessions will be reviewed before appearing for voting.'
                : ' Sessions will be added directly to the voting pool.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Title */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Title <span className="text-destructive">*</span>
                </label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What's your session about?"
                  maxLength={100}
                />
                <p className="text-xs text-muted-foreground">{title.length}/100</p>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe what participants will learn or experience..."
                  rows={4}
                  maxLength={500}
                />
                <p className="text-xs text-muted-foreground">{description.length}/500</p>
              </div>

              {/* Format */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Format</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {allowedFormats.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => setFormat(f.value)}
                      className={cn(
                        'p-3 rounded-lg border text-left transition-colors',
                        format === f.value
                          ? 'border-primary bg-primary/10'
                          : 'hover:border-muted-foreground/50'
                      )}
                    >
                      <div className="font-medium text-sm">{f.label}</div>
                      <div className="text-xs text-muted-foreground">{f.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Duration</label>
                <div className="flex gap-2">
                  {allowedDurations.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => setDuration(d.value)}
                      className={cn(
                        'px-4 py-2 rounded-lg border transition-colors',
                        duration === d.value
                          ? 'border-primary bg-primary/10'
                          : 'hover:border-muted-foreground/50'
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Expected Attendance */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Expected Attendance
                </label>
                <p className="text-xs text-muted-foreground">
                  Helps organizers assign an appropriate venue
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {expectedAttendanceOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setExpectedAttendance(expectedAttendance === opt.value ? null : opt.value)}
                      className={cn(
                        'p-3 rounded-lg border text-left transition-colors',
                        expectedAttendance === opt.value
                          ? 'border-primary bg-primary/10'
                          : 'hover:border-muted-foreground/50'
                      )}
                    >
                      <div className="font-medium text-sm">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Availability (app-side by default) */}
              <div className="space-y-2">
                <span className="text-sm font-medium">When can you be there?</span>
                <p className="text-xs text-muted-foreground">
                  Optional. Organizers use this to schedule you; it stays inside this gathering unless you choose to publish it.
                </p>
                <TimePreferences
                  value={availability}
                  onChange={setAvailability}
                  startDate={eventDays[0]?.value ?? ''}
                  endDate={eventDays[eventDays.length - 1]?.value ?? ''}
                  timezone={event.timezone}
                />
                {(availability.windows.length > 0 || availability.blackouts.length > 0) && (
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3">
                    <Checkbox
                      id="publish-availability"
                      checked={publishAvailability}
                      onCheckedChange={(checked) => setPublishAvailability(checked === true)}
                      className="mt-0.5"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Also publish my availability for this proposal</span>
                      <span className="block text-xs text-muted-foreground mt-1">
                        Writes a public record to your repository saying when you can and cannot attend. {PERMANENCE}
                      </span>
                    </span>
                  </label>
                )}
              </div>

              {/* Track */}
              {tracks.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Track</label>
                  <p className="text-xs text-muted-foreground">
                    Which theme does your session fit best?
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setTrackId(null)}
                      className={cn(
                        'px-3 py-2 rounded-lg border text-sm transition-colors text-left',
                        trackId === null
                          ? 'border-primary bg-primary/10'
                          : 'hover:border-muted-foreground/50'
                      )}
                    >
                      None
                    </button>
                    {tracks.map((track) => (
                      <button
                        key={track.id}
                        type="button"
                        onClick={() => setTrackId(track.id)}
                        className={cn(
                          'px-3 py-2 rounded-lg border text-sm transition-colors text-left flex items-center gap-2',
                          trackId === track.id
                            ? 'border-primary bg-primary/10'
                            : 'hover:border-muted-foreground/50'
                        )}
                      >
                        {track.color && (
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: track.color }}
                          />
                        )}
                        <span className="truncate">{track.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Venue Type */}
              <div className="space-y-3">
                <label className="text-sm font-medium">Venue</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setIsSelfHosted(false)}
                    className={cn(
                      'p-4 rounded-lg border text-left transition-colors flex items-start gap-3',
                      !isSelfHosted
                        ? 'border-primary bg-primary/10'
                        : 'hover:border-muted-foreground/50'
                    )}
                  >
                    <Building2 className="h-5 w-5 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Official Venue</div>
                      <div className="text-xs text-muted-foreground">
                        Use one of the event's scheduled venues
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsSelfHosted(true)}
                    className={cn(
                      'p-4 rounded-lg border text-left transition-colors flex items-start gap-3',
                      isSelfHosted
                        ? 'border-primary bg-primary/10'
                        : 'hover:border-muted-foreground/50'
                    )}
                  >
                    <MapPin className="h-5 w-5 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Self-Hosted</div>
                      <div className="text-xs text-muted-foreground">
                        Host at your own location
                      </div>
                    </div>
                  </button>
                </div>

                {/* Self-hosted details - shown when self-hosted */}
                {isSelfHosted && (
                  <>
                  {/* Day Picker */}
                  <div className="space-y-2 pt-2">
                    <label className="text-sm font-medium">
                      Which day? <span className="text-xs text-muted-foreground">(optional)</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {eventDays.map((day) => (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => setSelfHostedDay(selfHostedDay === day.value ? '' : day.value)}
                          className={cn(
                            'px-3 py-2 rounded-lg border text-sm transition-colors',
                            selfHostedDay === day.value
                              ? 'border-primary bg-primary/10 font-medium'
                              : 'hover:border-muted-foreground/50'
                          )}
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Time Range */}
                  {selfHostedDay && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Time Range
                      </label>
                      <div className="flex items-center gap-2">
                        <select
                          value={selfHostedStartTime}
                          onChange={(e) => setSelfHostedStartTime(e.target.value)}
                          className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
                        >
                          <option value="">Start time</option>
                          {TIME_OPTIONS.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                        <span className="text-muted-foreground">to</span>
                        <select
                          value={selfHostedEndTime}
                          onChange={(e) => setSelfHostedEndTime(e.target.value)}
                          className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
                        >
                          <option value="">End time</option>
                          {TIME_OPTIONS.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 pt-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      Location Details <span className="text-destructive">*</span>
                    </label>
                    <Textarea
                      value={customLocation}
                      onChange={(e) => setCustomLocation(e.target.value)}
                      placeholder="Where will your session be held? Include address, room info, or any directions attendees need..."
                      rows={3}
                      maxLength={300}
                    />
                    <p className="text-xs text-muted-foreground">
                      {customLocation.length}/300 - Shown only to confirmed attendees, hosts and organizers. Never published.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="propose-public-place" className="text-sm font-medium">
                      Public area <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <input
                      id="propose-public-place"
                      type="text"
                      value={publicPlace}
                      onChange={(e) => setPublicPlace(e.target.value)}
                      placeholder="e.g. Near Pearl St, Boulder"
                      maxLength={80}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      A neighbourhood or landmark, never a street address. This label goes on your public
                      proposal record, so anyone on the network can see it. Leave it empty to publish no location.
                    </p>
                  </div>
                  </>
                )}
              </div>

              {/* Skills (shared taxonomy) */}
              <SkillPicker
                value={skills}
                onChange={(next) => setSkills(next.slice(0, 5))}
                max={5}
                label="Skills (up to 5)"
                description="From the shared skill taxonomy, so people can find this session next to classes on the same subject."
              />

              {/* Tags */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Tags (up to 5)</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="cursor-pointer hover:bg-destructive/20"
                      onClick={() => handleRemoveTag(tag)}
                    >
                      {tag} x
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleAddTag(customTag)}
                    disabled={!customTag.trim() || tags.length >= 5}
                  >
                    Add
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {suggestedTags
                    .filter((t) => !tags.includes(t))
                    .slice(0, 6)
                    .map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleAddTag(tag)}
                        className="px-2 py-1 text-xs rounded border hover:bg-accent"
                        disabled={tags.length >= 5}
                      >
                        + {tag}
                      </button>
                    ))}
                </div>
              </div>

              {/* What submitting publishes */}
              <div className="rounded-lg border p-4 text-sm space-y-2">
                <p className="font-medium flex items-center gap-2">
                  <Globe className="h-4 w-4" />
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

              {/* Error */}
              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {/* Submit */}
              <Button type="submit" className="w-full" loading={isSubmitting}>
                Submit Proposal
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
