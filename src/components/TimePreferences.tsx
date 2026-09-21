'use client'

/**
 * TimePreferences — when a proposer can actually be there (spec §4.2 `timePreference`).
 * Controlled; values are REAL INSTANTS (ISO 8601), entered as local day + time in the gathering's
 * timezone. App-side by default: the "publish" switch is a per-proposal opt-in that writes a
 * `schellingpoint.draft.timePreference` record in the proposer's own repo.
 *
 * For package B (proposal form / my sessions):
 *
 *   const [prefs, setPrefs] = useState<TimePreferencesValue>(EMPTY_TIME_PREFERENCES)
 *   <TimePreferences value={prefs} onChange={setPrefs} timezone={event.timezone}
 *                    startDate={event.start_date} endDate={event.end_date} />
 *   // after the session exists:
 *   await saveTimePreferences(event.slug, sessionId, prefs)
 *
 * Props
 *   value              { windows: TimeWindowValue[]; blackouts: TimeWindowValue[]; publish: boolean }
 *   onChange           (value) => void
 *   timezone           IANA zone of the gathering, e.g. "America/Denver"
 *   startDate/endDate  'YYYY-MM-DD' — the days offered
 *   disabled?          boolean
 *   showPublish?       boolean (default: shown when value.publish is defined)
 *
 * `saveTimePreferences` POSTs to /api/v1/events/[slug]/sessions/[id]/atproto { action:
 * 'time-preference' }; an OAuth-door author who has not confirmed public linkage and asked to
 * publish gets ApiError code `confirm_public_linkage` — retry with `confirmPublicLinkage: true`.
 */
import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { apiFetch } from '@/lib/api/client'
import { parseTimeInTimezone } from '@/lib/events/timezone'

export interface TimeWindowValue {
  startsAt: string
  endsAt: string
  /** 1 prefer, 2 acceptable, 3 last resort. */
  preference?: 1 | 2 | 3
}

export interface TimePreferenceValue {
  windows: TimeWindowValue[]
  blackouts: TimeWindowValue[]
  /** The per-proposal publish opt-in. Omit it to render the opt-in yourself (the switch is hidden). */
  publish?: boolean
}

/** Alias kept for readability at call sites. */
export type TimePreferencesValue = TimePreferenceValue

export const EMPTY_TIME_PREFERENCES: TimePreferenceValue = { windows: [], blackouts: [], publish: false }

export interface TimePreferencesProps {
  value: TimePreferencesValue
  onChange: (value: TimePreferencesValue) => void
  timezone: string
  /** 'YYYY-MM-DD' or the Date `new Date('YYYY-MM-DD')` produces (EventContext's `startDate`). */
  startDate: string | Date
  endDate: string | Date
  disabled?: boolean
  showPublish?: boolean
}

export const TIME_PREFERENCE_PUBLISH_NOTICE =
  'Publishing writes your availability for this session as a public record in your own ATProto repository. It says when you are not around; leave it off unless you want that public.'

const MAX_WINDOWS = 40

/** 'YYYY-MM-DD'. A Date is read as `new Date('YYYY-MM-DD')` builds it: UTC midnight of that day. */
function dayString(value: string | Date): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)
}

function daysBetween(startValue: string | Date, endValue: string | Date): string[] {
  const out: string[] = []
  const start = dayString(startValue)
  const end = dayString(endValue)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return out
  const d = new Date(`${start}T12:00:00Z`)
  const last = new Date(`${end}T12:00:00Z`)
  while (d <= last && out.length < 60) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

function localParts(iso: string, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

function toInstant(day: string, time: string, timezone: string): string | null {
  try {
    return parseTimeInTimezone(time, day, timezone).toISOString()
  } catch {
    return null
  }
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`))
}

interface RowProps {
  window: TimeWindowValue
  days: string[]
  timezone: string
  disabled: boolean
  withPreference: boolean
  onChange: (w: TimeWindowValue) => void
  onRemove: () => void
  label: string
}

function WindowRow({ window: w, days, timezone, disabled, withPreference, onChange, onRemove, label }: RowProps) {
  const start = localParts(w.startsAt, timezone)
  const end = localParts(w.endsAt, timezone)
  const [error, setError] = React.useState<string | null>(null)

  const update = (day: string, startTime: string, endTime: string, preference = w.preference) => {
    const s = toInstant(day, startTime, timezone)
    const e = toInstant(day, endTime, timezone)
    if (!s || !e) return setError('That time does not exist on this day (clock change).')
    if (s >= e) return setError('The end must be after the start.')
    setError(null)
    onChange({ startsAt: s, endsAt: e, ...(withPreference && preference ? { preference } : {}) })
  }

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
        <Select
          wrapperClassName="w-auto min-w-[9rem] flex-1 sm:flex-none"
          value={start.day}
          disabled={disabled}
          onChange={(e) => update(e.target.value, start.time, end.time)}
          aria-label="Day"
        >
          {days.map((d) => (
            <option key={d} value={d}>
              {dayLabel(d)}
            </option>
          ))}
        </Select>
        <Input
          type="time"
          className="w-auto"
          value={start.time}
          step={900}
          disabled={disabled}
          aria-label="From"
          onChange={(e) => update(start.day, e.target.value, end.time)}
        />
        <span className="text-sm text-muted-foreground">to</span>
        <Input
          type="time"
          className="w-auto"
          value={end.time}
          step={900}
          disabled={disabled}
          aria-label="Until"
          onChange={(e) => update(start.day, start.time, e.target.value)}
        />
        {withPreference ? (
          <Select
            wrapperClassName="w-auto min-w-[8rem]"
            value={w.preference ?? 2}
            disabled={disabled}
            aria-label="Preference"
            onChange={(e) => update(start.day, start.time, end.time, Number(e.target.value) as 1 | 2 | 3)}
          >
            <option value={1}>Preferred</option>
            <option value={2}>Works</option>
            <option value={3}>Last resort</option>
          </Select>
        ) : null}
        <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} disabled={disabled} aria-label={`Remove ${label}`} title="Remove">
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    </li>
  )
}

export function TimePreferences({ value, onChange, timezone, startDate, endDate, disabled = false, showPublish = value.publish !== undefined }: TimePreferencesProps) {
  const startKey = dayString(startDate)
  const endKey = dayString(endDate)
  const days = React.useMemo(() => daysBetween(startKey, endKey), [startKey, endKey])
  const publishId = React.useId()

  const blank = (preference?: 1 | 2 | 3): TimeWindowValue | null => {
    const day = days[0]
    if (!day) return null
    const s = toInstant(day, '09:00', timezone)
    const e = toInstant(day, '12:00', timezone)
    return s && e ? { startsAt: s, endsAt: e, ...(preference ? { preference } : {}) } : null
  }

  const section = (kind: 'windows' | 'blackouts', title: string, hint: string, addLabel: string) => {
    const list = value[kind]
    return (
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium leading-none">{title}</legend>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {list.length ? (
          <ul className="space-y-2">
            {list.map((w, i) => (
              <WindowRow
                key={`${kind}-${i}`}
                window={w}
                days={days}
                timezone={timezone}
                disabled={disabled}
                withPreference={kind === 'windows'}
                label={`${kind === 'windows' ? 'Available' : 'Unavailable'} window ${i + 1}`}
                onChange={(next) => onChange({ ...value, [kind]: list.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => onChange({ ...value, [kind]: list.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || list.length >= MAX_WINDOWS || !days.length}
          onClick={() => {
            const w = blank(kind === 'windows' ? 2 : undefined)
            if (w) onChange({ ...value, [kind]: [...list, w] })
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {addLabel}
        </Button>
      </fieldset>
    )
  }

  const empty = value.windows.length === 0 && value.blackouts.length === 0

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        {empty ? 'Nothing added yet: organizers will assume any time works. ' : ''}
        Times are in the gathering’s timezone ({timezone}).
      </p>
      {section('windows', 'When you can be there', 'Organizers use this to schedule your session. Mark the times you prefer.', 'Add a window')}
      {section('blackouts', 'When you can’t be there', 'Optional: times that do not work at all.', 'Add a blackout')}
      {showPublish ? (
        <div className="flex items-start gap-3 rounded-xl border p-3">
          <Checkbox
            id={publishId}
            checked={value.publish === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...value, publish: checked === true })}
            className="mt-0.5"
          />
          <div className="space-y-1">
            <label htmlFor={publishId} className="text-sm font-medium">
              Publish my availability on the network
            </label>
            <p className="text-xs text-muted-foreground">{TIME_PREFERENCE_PUBLISH_NOTICE}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Save through the session's ATProto route. Returns the stored value and the record (when published). */
export async function saveTimePreferences(
  eventSlug: string,
  sessionId: string,
  value: TimePreferencesValue,
  opts: { confirmPublicLinkage?: boolean } = {},
): Promise<TimePreferencesValue & { record: { uri: string; cid: string } | null }> {
  return apiFetch(`/api/v1/events/${encodeURIComponent(eventSlug)}/sessions/${encodeURIComponent(sessionId)}/atproto`, {
    method: 'POST',
    json: { action: 'time-preference', ...value, ...(opts.confirmPublicLinkage ? { confirmPublicLinkage: true } : {}) },
  })
}

export default TimePreferences
