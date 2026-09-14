'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, X } from 'lucide-react';
import type { WizardTimeSlot, WizardVenue } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

export interface ScheduleCalendarProps {
  eventDates: string[];
  venues: WizardVenue[];
  slots: WizardTimeSlot[];
  /** When non-null, creates new slots for this venue id. When null / "all",
   * creates identical slots for every venue (bulk). */
  selectedVenueId: string | 'all' | null;
  /** Resolution in minutes (default 30). */
  resolutionMinutes?: number;
  /** Range of hours shown in the grid. */
  startHour?: number;
  endHour?: number;
  onCreateSlot: (
    venueIds: string[],
    dayDate: string,
    startTime: string,
    endTime: string,
  ) => void;
  onEditSlot: (slot: WizardTimeSlot) => void;
  onDeleteSlot: (slotId: string) => void;
}

// ============================================================================
// Utilities
// ============================================================================

function pad2(n: number) {
  return n.toString().padStart(2, '0');
}

function minutesToTimeStr(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function timeStrToMinutes(time: string) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function formatHourLabel(hour: number) {
  const period = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 || 12;
  return `${display}:00 ${period}`;
}

function formatTimeRange(start: string, end: string) {
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const display = h % 12 || 12;
    return `${display}:${pad2(m)} ${period}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function formatDayLabel(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
    day: d.getDate(),
    month: d.toLocaleDateString('en-US', { month: 'short' }),
  };
}

// ============================================================================
// ScheduleCalendar
// ============================================================================

export function ScheduleCalendar({
  eventDates,
  venues,
  slots,
  selectedVenueId,
  resolutionMinutes = 30,
  startHour = 8,
  endHour = 22,
  onCreateSlot,
  onEditSlot,
  onDeleteSlot,
}: ScheduleCalendarProps) {
  const rowCount = ((endHour - startHour) * 60) / resolutionMinutes;
  const rowHeightPx = 28; // Compact row height

  // Which slots to render depending on venue filter
  const visibleSlots = React.useMemo(() => {
    if (!selectedVenueId || selectedVenueId === 'all') return slots;
    return slots.filter((s) => s.venueId === selectedVenueId);
  }, [slots, selectedVenueId]);

  // Group by day
  const slotsByDay = React.useMemo(() => {
    const map = new Map<string, WizardTimeSlot[]>();
    for (const day of eventDates) map.set(day, []);
    for (const slot of visibleSlots) {
      if (!map.has(slot.dayDate)) map.set(slot.dayDate, []);
      map.get(slot.dayDate)!.push(slot);
    }
    return map;
  }, [visibleSlots, eventDates]);

  // Drag-to-create state (per day-column)
  const [dragState, setDragState] = React.useState<null | {
    dayDate: string;
    startRow: number; // index (inclusive)
    currentRow: number; // index (inclusive)
  }>(null);

  const canCreate = selectedVenueId !== null;

  const gridStartMinutes = startHour * 60;

  const rowToTime = (rowIndex: number) =>
    minutesToTimeStr(gridStartMinutes + rowIndex * resolutionMinutes);

  const handleMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    dayDate: string,
    rowIndex: number,
  ) => {
    if (!canCreate) return;
    if ((e.target as HTMLElement).closest('[data-slot-block]')) return;
    e.preventDefault();
    setDragState({ dayDate, startRow: rowIndex, currentRow: rowIndex });
  };

  const handleMouseEnter = (dayDate: string, rowIndex: number) => {
    if (!dragState) return;
    if (dragState.dayDate !== dayDate) return;
    setDragState({ ...dragState, currentRow: rowIndex });
  };

  const commitDrag = React.useCallback(() => {
    if (!dragState) return;
    const { dayDate, startRow, currentRow } = dragState;
    setDragState(null);

    const [lo, hi] = startRow <= currentRow ? [startRow, currentRow] : [currentRow, startRow];
    const startTime = rowToTime(lo);
    const endTime = rowToTime(hi + 1); // exclusive end
    if (startTime === endTime) return;

    // Determine venue(s) to create in
    if (!selectedVenueId) return;
    const venueIds =
      selectedVenueId === 'all' ? venues.map((v) => v.id) : [selectedVenueId];

    if (venueIds.length === 0) return;
    onCreateSlot(venueIds, dayDate, startTime, endTime);
  }, [dragState, venues, selectedVenueId, onCreateSlot, rowToTime]);

  // Bind mouseup to document so releasing outside also commits
  React.useEffect(() => {
    if (!dragState) return;
    const handler = () => commitDrag();
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [dragState, commitDrag]);

  return (
    <div className="rounded-xl border bg-card overflow-hidden select-none">
      {/* Header row: day labels */}
      <div
        className="grid border-b bg-muted/30"
        style={{ gridTemplateColumns: `72px repeat(${eventDates.length}, minmax(0, 1fr))` }}
      >
        <div className="px-2 py-2 text-xs font-medium text-muted-foreground">
          Time
        </div>
        {eventDates.map((date) => {
          const label = formatDayLabel(date);
          return (
            <div
              key={date}
              className="px-2 py-2 text-xs font-medium text-muted-foreground border-l"
            >
              <div className="tracking-wide opacity-70">
                {label.weekday}
              </div>
              <div className="text-sm text-foreground font-semibold">
                {label.month} {label.day}
              </div>
            </div>
          );
        })}
      </div>

      {/* Grid body */}
      <div
        className="grid relative"
        style={{
          gridTemplateColumns: `72px repeat(${eventDates.length}, minmax(0, 1fr))`,
        }}
      >
        {/* Hour gutter */}
        <div
          className="relative"
          style={{ height: `${rowCount * rowHeightPx}px` }}
        >
          {Array.from({ length: endHour - startHour }).map((_, i) => {
            const hour = startHour + i;
            return (
              <div
                key={hour}
                className="absolute left-0 right-0 border-t text-xs text-muted-foreground px-1"
                style={{ top: `${i * (60 / resolutionMinutes) * rowHeightPx}px` }}
              >
                {formatHourLabel(hour)}
              </div>
            );
          })}
        </div>

        {/* Day columns */}
        {eventDates.map((dayDate) => {
          const daySlots = slotsByDay.get(dayDate) || [];
          const isDragDay = dragState?.dayDate === dayDate;
          const dragLo = isDragDay
            ? Math.min(dragState!.startRow, dragState!.currentRow)
            : -1;
          const dragHi = isDragDay
            ? Math.max(dragState!.startRow, dragState!.currentRow)
            : -1;

          return (
            <div
              key={dayDate}
              className="relative border-l"
              style={{ height: `${rowCount * rowHeightPx}px` }}
            >
              {/* Background cells */}
              {Array.from({ length: rowCount }).map((_, rowIndex) => (
                <div
                  key={rowIndex}
                  className={cn(
                    'absolute left-0 right-0 transition-colors',
                    // Thin border at every hour
                    rowIndex % (60 / resolutionMinutes) === 0
                      ? 'border-t border-border'
                      : 'border-t border-border/30',
                    canCreate
                      ? 'cursor-crosshair hover:bg-primary/5'
                      : 'cursor-not-allowed',
                    isDragDay && rowIndex >= dragLo && rowIndex <= dragHi
                      ? 'bg-primary/20'
                      : '',
                  )}
                  style={{
                    top: `${rowIndex * rowHeightPx}px`,
                    height: `${rowHeightPx}px`,
                  }}
                  onMouseDown={(e) => handleMouseDown(e, dayDate, rowIndex)}
                  onMouseEnter={() => handleMouseEnter(dayDate, rowIndex)}
                />
              ))}

              {/* Existing slot blocks */}
              {daySlots.map((slot) => {
                const startMin = timeStrToMinutes(slot.startTime);
                const endMin = timeStrToMinutes(slot.endTime);
                if (endMin <= gridStartMinutes || startMin >= endHour * 60) {
                  return null;
                }
                const top = Math.max(
                  0,
                  ((startMin - gridStartMinutes) / resolutionMinutes) * rowHeightPx,
                );
                const clampedEnd = Math.min(endMin, endHour * 60);
                const height =
                  ((clampedEnd - Math.max(startMin, gridStartMinutes)) /
                    resolutionMinutes) *
                  rowHeightPx;
                const venue = venues.find((v) => v.id === slot.venueId);
                const baseColor = slot.isBreak
                  ? 'bg-muted text-muted-foreground border-muted-foreground/30'
                  : 'bg-primary/15 text-foreground border-primary/40 hover:bg-primary/25';
                return (
                  <div
                    key={slot.id}
                    data-slot-block
                    className={cn(
                      'absolute left-0.5 right-0.5 rounded-md border px-1.5 py-0.5 text-[11px] overflow-hidden group',
                      baseColor,
                    )}
                    style={{ top: `${top}px`, height: `${Math.max(height, 16)}px` }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
                          {formatTimeRange(slot.startTime, slot.endTime)}
                        </div>
                        {slot.label && (
                          <div className="text-xs opacity-70 truncate">
                            {slot.label}
                          </div>
                        )}
                        {venue && (
                          <div className="text-xs opacity-60 truncate">
                            {venue.name}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditSlot(slot);
                          }}
                          className="p-0.5 rounded hover:bg-background"
                          aria-label="Edit slot"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSlot(slot.id);
                          }}
                          className="p-0.5 rounded hover:bg-background text-destructive"
                          aria-label="Delete slot"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Help text */}
      <div className="border-t px-3 py-2 bg-muted/20 text-xs text-muted-foreground flex items-center justify-between gap-2">
        <span>
          {canCreate
            ? 'Click and drag across time cells to create a new time slot.'
            : 'Select a venue to enable drag-to-create.'}
        </span>
        {dragState && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setDragState(null)}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export default ScheduleCalendar;
