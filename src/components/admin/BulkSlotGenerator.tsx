'use client'

import * as React from 'react'
import { CalendarPlus, Coffee } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { plural } from '@/lib/format'

interface BulkSlotGeneratorProps {
  venues: { id: string; name: string; capacity: number | null }[]
  eventDays: { date: string; label: string }[]
  onGenerate: (slots: GeneratedSlot[]) => void
  onCancel: () => void
  isSaving?: boolean
  existingSlots?: Array<Pick<GeneratedSlot, 'venueId' | 'dayDate' | 'startTime' | 'endTime'>>
}

export interface GeneratedSlot {
  venueId: string
  dayDate: string
  startTime: string
  endTime: string
  label: string
  isBreak: boolean
}

const DURATION_OPTIONS = [
  { value: 30, label: '30 min' },
  { value: 45, label: '45 min' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hours' },
  { value: 120, label: '2 hours' },
]

const ALL = '__all__'

const BREAK_DURATION_OPTIONS = [
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 20, label: '20 min' },
  { value: 30, label: '30 min' },
]

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  const period = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`
}

export function BulkSlotGenerator({
  venues,
  eventDays,
  onGenerate,
  onCancel,
  isSaving = false,
  existingSlots = [],
}: BulkSlotGeneratorProps) {
  const [venueId, setVenueId] = React.useState(venues[0]?.id || '')
  const [dayDate, setDayDate] = React.useState(eventDays[0]?.date || '')
  const [startHour, setStartHour] = React.useState(9 * 60)
  const [endHour, setEndHour] = React.useState(17 * 60)
  const [duration, setDuration] = React.useState(60)
  const [includeBreaks, setIncludeBreaks] = React.useState(false)
  const [breakDuration, setBreakDuration] = React.useState(15)

  // One day's pattern of slots, as wall-clock times in the event timezone.
  const pattern = React.useMemo(() => {
    const slots: Array<Pick<GeneratedSlot, 'startTime' | 'endTime' | 'label' | 'isBreak'>> = []
    let currentMinutes = startHour
    const endMinutes = endHour
    while (currentMinutes + duration <= endMinutes) {
      const slotEndMinutes = currentMinutes + duration
      slots.push({ startTime: minutesToTime(currentMinutes), endTime: minutesToTime(slotEndMinutes), label: '', isBreak: false })
      currentMinutes = slotEndMinutes
      if (includeBreaks && currentMinutes + breakDuration + duration <= endMinutes) {
        const breakEndMinutes = currentMinutes + breakDuration
        slots.push({ startTime: minutesToTime(currentMinutes), endTime: minutesToTime(breakEndMinutes), label: 'Break', isBreak: true })
        currentMinutes = breakEndMinutes
      }
    }
    return slots
  }, [startHour, endHour, duration, includeBreaks, breakDuration])

  // Every (room, day) the pattern is applied to; saved in one transaction.
  const preview = React.useMemo(() => {
    const rooms = venueId === ALL ? venues.map((v) => v.id) : [venueId]
    const days = dayDate === ALL ? eventDays.map((d) => d.date) : [dayDate]
    return rooms.flatMap((room) => days.flatMap((day) => pattern.map((slot) => ({ ...slot, venueId: room, dayDate: day }))))
  }, [pattern, venueId, dayDate, venues, eventDays])

  const conflicts = preview.filter(slot => existingSlots.some(existing => existing.venueId === slot.venueId &&
    existing.dayDate === slot.dayDate && existing.startTime < slot.endTime && slot.startTime < existing.endTime))
  const selectedVenue = venues.find(v => v.id === venueId)
  const id = React.useId()

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-venue`}>Room</Label>
          <Select
            id={`${id}-venue`}
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
          >
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name} {venue.capacity ? `(${venue.capacity} cap)` : ''}
              </option>
            ))}
            {venues.length > 1 && <option value={ALL}>Every room</option>}
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-day`}>Day</Label>
          <Select
            id={`${id}-day`}
            value={dayDate}
            onChange={(e) => setDayDate(e.target.value)}
          >
            {eventDays.map((day) => (
              <option key={day.date} value={day.date}>
                {day.label}
              </option>
            ))}
            {eventDays.length > 1 && <option value={ALL}>Every day</option>}
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-start`}>Start time</Label>
          <Select
            id={`${id}-start`}
            value={startHour}
            onChange={(e) => setStartHour(Number(e.target.value))}
          >
            {Array.from({ length: 96 }, (_, i) => (
              <option key={i} value={i * 15}>
                {formatTime(minutesToTime(i * 15))}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-end`}>End time</Label>
          <Select
            id={`${id}-end`}
            value={endHour}
            onChange={(e) => setEndHour(Number(e.target.value))}
          >
            {Array.from({ length: 96 }, (_, i) => (
              <option key={i} value={i * 15}>
                {formatTime(minutesToTime(i * 15))}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-duration`}>Slot length</Label>
          <Select
            id={`${id}-duration`}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-2">
          <Label id={`${id}-breaks`}>Breaks between slots</Label>
          <div className="flex items-center gap-3 h-11">
            <Switch checked={includeBreaks} onCheckedChange={setIncludeBreaks} aria-labelledby={`${id}-breaks`} />
            {includeBreaks && (
              <Select
                aria-label="Break length"
                value={breakDuration}
                onChange={(e) => setBreakDuration(Number(e.target.value))}
                wrapperClassName="w-auto"
              >
                {BREAK_DURATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
      </div>

      {/* Preview */}
      {pattern.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Each day: {plural(pattern.filter(s => !s.isBreak).length, 'session')}, {plural(pattern.filter(s => s.isBreak).length, 'break')}</p>
          <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto">
            <div className="space-y-1.5">
              {pattern.map((slot, index) => (
                <div
                  key={index}
                  className={cn(
                    'flex items-center justify-between text-sm px-2 py-1 rounded',
                    slot.isBreak ? 'bg-signal-amber/10 text-signal-amber' : 'bg-background'
                  )}
                >
                  <span>
                    {formatTime(slot.startTime)}–{formatTime(slot.endTime)}
                  </span>
                  {slot.isBreak && (
                    <Badge variant="secondary" className="text-xs">
                      <Coffee className="h-3 w-3 mr-1" />
                      Break
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {venueId === ALL ? 'Every room' : selectedVenue?.name} · {dayDate === ALL ? 'every day' : eventDays.find(d => d.date === dayDate)?.label} · {plural(preview.length, 'slot')} in total, saved together or not at all
          </p>
        </div>
      )}

      {conflicts.length > 0 && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
        {plural(conflicts.length, 'proposed slot')} {conflicts.length === 1 ? 'overlaps' : 'overlap'} existing availability. Choose another time, room or day before adding slots.
      </p>}
      {startHour >= endHour && (
        <p className="text-sm text-destructive">End time must be after start time</p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          onClick={() => onGenerate(preview)}
          loading={isSaving}
          disabled={preview.length === 0 || conflicts.length > 0}
        >
          {!isSaving && <CalendarPlus className="h-4 w-4 mr-2" aria-hidden="true" />}
          Add {plural(preview.length, 'slot')}
        </Button>
      </div>
    </div>
  )
}
