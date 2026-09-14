'use client'

import * as React from 'react'
import { Zap, Coffee } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface BulkSlotGeneratorProps {
  venues: { id: string; name: string; capacity: number | null }[]
  eventDays: { date: string; label: string }[]
  onGenerate: (slots: GeneratedSlot[]) => void
  onCancel: () => void
  isSaving?: boolean
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
}: BulkSlotGeneratorProps) {
  const [venueId, setVenueId] = React.useState(venues[0]?.id || '')
  const [dayDate, setDayDate] = React.useState(eventDays[0]?.date || '')
  const [startHour, setStartHour] = React.useState(9)
  const [endHour, setEndHour] = React.useState(17)
  const [duration, setDuration] = React.useState(60)
  const [includeBreaks, setIncludeBreaks] = React.useState(false)
  const [breakDuration, setBreakDuration] = React.useState(15)

  // Generate preview
  const preview = React.useMemo(() => {
    const slots: GeneratedSlot[] = []
    let currentMinutes = startHour * 60
    const endMinutes = endHour * 60

    while (currentMinutes + duration <= endMinutes) {
      const startTime = minutesToTime(currentMinutes)
      const slotEndMinutes = currentMinutes + duration
      const endTime = minutesToTime(slotEndMinutes)

      slots.push({
        venueId,
        dayDate,
        startTime,
        endTime,
        label: '',
        isBreak: false,
      })

      currentMinutes = slotEndMinutes

      // Add break if enabled
      if (includeBreaks && currentMinutes + duration <= endMinutes) {
        const breakStart = minutesToTime(currentMinutes)
        const breakEndMinutes = currentMinutes + breakDuration
        const breakEnd = minutesToTime(breakEndMinutes)

        slots.push({
          venueId,
          dayDate,
          startTime: breakStart,
          endTime: breakEnd,
          label: 'Break',
          isBreak: true,
        })

        currentMinutes = breakEndMinutes
      }
    }

    return slots
  }, [venueId, dayDate, startHour, endHour, duration, includeBreaks, breakDuration])

  const selectedVenue = venues.find(v => v.id === venueId)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Venue</Label>
          <select
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm"
          >
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name} {venue.capacity ? `(${venue.capacity} cap)` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label>Date</Label>
          <select
            value={dayDate}
            onChange={(e) => setDayDate(e.target.value)}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm"
          >
            {eventDays.map((day) => (
              <option key={day.date} value={day.date}>
                {day.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label>Start Hour</Label>
          <select
            value={startHour}
            onChange={(e) => setStartHour(Number(e.target.value))}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>
                {formatTime(`${i.toString().padStart(2, '0')}:00`)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label>End Hour</Label>
          <select
            value={endHour}
            onChange={(e) => setEndHour(Number(e.target.value))}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>
                {formatTime(`${i.toString().padStart(2, '0')}:00`)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label>Slot Duration</Label>
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm"
          >
            {DURATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label>Breaks Between Slots</Label>
          <div className="flex items-center gap-3 h-10">
            <button
              type="button"
              role="switch"
              aria-checked={includeBreaks}
              onClick={() => setIncludeBreaks(!includeBreaks)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                includeBreaks ? 'bg-primary' : 'bg-input'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform',
                  includeBreaks ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
            {includeBreaks && (
              <select
                value={breakDuration}
                onChange={(e) => setBreakDuration(Number(e.target.value))}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              >
                {BREAK_DURATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Preview */}
      {preview.length > 0 && (
        <div className="space-y-2">
          <Label>Preview ({preview.filter(s => !s.isBreak).length} sessions, {preview.filter(s => s.isBreak).length} breaks)</Label>
          <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto">
            <div className="space-y-1.5">
              {preview.map((slot, index) => (
                <div
                  key={index}
                  className={cn(
                    'flex items-center justify-between text-sm px-2 py-1 rounded',
                    slot.isBreak ? 'bg-amber-100 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300' : 'bg-background'
                  )}
                >
                  <span>
                    {formatTime(slot.startTime)} - {formatTime(slot.endTime)}
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
            Slots for {selectedVenue?.name} on {eventDays.find(d => d.date === dayDate)?.label}
          </p>
        </div>
      )}

      {startHour >= endHour && (
        <p className="text-sm text-destructive">End hour must be after start hour</p>
      )}

      <div className="flex gap-3 pt-2">
        <Button
          onClick={() => onGenerate(preview)}
          disabled={isSaving || preview.length === 0}
        >
          <Zap className="h-4 w-4 mr-2" />
          Generate {preview.filter(s => !s.isBreak).length} Slots
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
