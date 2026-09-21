'use client';

import * as React from 'react';
import { Plus, Pencil, Trash2, Clock, Calendar, MapPin, X, Zap, Coffee, LayoutGrid, List } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ConfirmInline } from '@/components/ui/confirm-inline';
import { Field } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { plural, EN_DASH } from '@/lib/format';
import { cn } from '@/lib/utils';
import { getNumberFromStep, type WizardState, type WizardAction, type WizardTimeSlot, type WizardVenue } from '../useWizardState';
import { ScheduleCalendar } from '../components/ScheduleCalendar';

// ============================================================================
// Types
// ============================================================================

interface ScheduleStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

interface TimeSlotFormData {
  dayDate: string;
  startTime: string;
  endTime: string;
  venueId: string;
  label: string;
  isBreak: boolean;
}

interface BulkGeneratorFormData {
  dayDate: string;
  startHour: number;
  endHour: number;
  durationMinutes: number;
  venueId: string;
  includeBreaks: boolean;
  breakDuration: number;
}

// ============================================================================
// Constants
// ============================================================================

const INITIAL_FORM_DATA: TimeSlotFormData = {
  dayDate: '',
  startTime: '09:00',
  endTime: '10:00',
  venueId: '',
  label: '',
  isBreak: false,
};

const INITIAL_BULK_DATA: BulkGeneratorFormData = {
  dayDate: '',
  startHour: 9,
  endHour: 17,
  durationMinutes: 60,
  venueId: '',
  includeBreaks: false,
  breakDuration: 15,
};

const DURATION_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 45, label: '45 minutes' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hours' },
  { value: 120, label: '2 hours' },
];

const BREAK_DURATION_OPTIONS = [
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 20, label: '20 min' },
  { value: 30, label: '30 min' },
  { value: 45, label: '45 min' },
  { value: 60, label: '1 hour' },
];

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}

function formatRange(start: string, end: string): string {
  return `${formatTime(start)} ${EN_DASH} ${formatTime(end)}`;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function getEventDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function slotsOverlap(slot1: WizardTimeSlot, slot2: WizardTimeSlot): boolean {
  if (slot1.dayDate !== slot2.dayDate || slot1.venueId !== slot2.venueId) return false;
  const start1 = timeToMinutes(slot1.startTime);
  const end1 = timeToMinutes(slot1.endTime);
  const start2 = timeToMinutes(slot2.startTime);
  const end2 = timeToMinutes(slot2.endTime);
  return start1 < end2 && start2 < end1;
}

function validateTimeSlot(
  formData: TimeSlotFormData,
  existingSlots: WizardTimeSlot[],
  editingId: string | null,
  eventStartDate: string,
  eventEndDate: string
): string[] {
  const errors: string[] = [];

  if (!formData.dayDate) {
    errors.push('Choose a day');
  } else if (formData.dayDate < eventStartDate || formData.dayDate > eventEndDate) {
    errors.push('The day must fall within the gathering’s dates');
  }
  if (!formData.startTime) errors.push('Choose a start time');
  if (!formData.endTime) errors.push('Choose an end time');
  if (formData.startTime && formData.endTime && timeToMinutes(formData.endTime) <= timeToMinutes(formData.startTime)) {
    errors.push('The end time must be after the start time');
  }
  if (!formData.venueId) errors.push('Choose a room');

  if (formData.dayDate && formData.startTime && formData.endTime && formData.venueId) {
    const newSlot: WizardTimeSlot = { id: editingId || 'temp', ...formData };
    const overlapping = existingSlots.find((slot) => slot.id !== editingId && slotsOverlap(slot, newSlot));
    if (overlapping) {
      errors.push(`This overlaps an existing slot (${formatRange(overlapping.startTime, overlapping.endTime)})`);
    }
  }

  return errors;
}

// ============================================================================
// Time Slot Card Component
// ============================================================================

interface TimeSlotCardProps {
  slot: WizardTimeSlot;
  venue: WizardVenue | undefined;
  onEdit: (slot: WizardTimeSlot) => void;
  onDelete: (id: string) => void;
}

function TimeSlotCard({ slot, venue, onEdit, onDelete }: TimeSlotCardProps) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className={cn('rounded-lg border p-3 space-y-2', slot.isBreak ? 'bg-muted/50 border-dashed' : 'bg-card')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{formatRange(slot.startTime, slot.endTime)}</span>
            {slot.isBreak && (
              <Badge variant="secondary">
                <Coffee className="h-3 w-3 mr-1" aria-hidden="true" />
                Break
              </Badge>
            )}
          </div>
          {slot.label && <p className="text-sm text-muted-foreground mt-0.5">{slot.label}</p>}
          {venue && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {venue.name}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={() => onEdit(slot)} aria-label={`Edit the ${formatRange(slot.startTime, slot.endTime)} slot`}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
            aria-label={`Delete the ${formatRange(slot.startTime, slot.endTime)} slot`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {confirming && (
        <ConfirmInline
          message="Delete this time slot?"
          confirmLabel="Delete"
          destructive
          layout="inline"
          onConfirm={() => { onDelete(slot.id); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Time Slot Form Component
// ============================================================================

interface TimeSlotFormProps {
  initialData?: WizardTimeSlot | null;
  venues: WizardVenue[];
  eventDates: string[];
  existingSlots: WizardTimeSlot[];
  eventStartDate: string;
  eventEndDate: string;
  onSubmit: (data: TimeSlotFormData) => void;
  onCancel: () => void;
  isEditing: boolean;
}

function TimeSlotForm({
  initialData,
  venues,
  eventDates,
  existingSlots,
  eventStartDate,
  eventEndDate,
  onSubmit,
  onCancel,
  isEditing,
}: TimeSlotFormProps) {
  const [formData, setFormData] = React.useState<TimeSlotFormData>(() => {
    if (initialData) {
      return {
        dayDate: initialData.dayDate,
        startTime: initialData.startTime,
        endTime: initialData.endTime,
        venueId: initialData.venueId,
        label: initialData.label,
        isBreak: initialData.isBreak,
      };
    }
    return { ...INITIAL_FORM_DATA, dayDate: eventDates[0] || '', venueId: venues[0]?.id || '' };
  });

  const [errors, setErrors] = React.useState<string[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validateTimeSlot(formData, existingSlots, initialData?.id || null, eventStartDate, eventEndDate);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors([]);
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {errors.length > 0 && (
        <div role="alert" className="rounded-xl bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive space-y-1">
          {errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
        </div>
      )}

      <Field label="Day" htmlFor="slot-date">
        <Select id="slot-date" value={formData.dayDate} onChange={(e) => setFormData({ ...formData, dayDate: e.target.value })}>
          <option value="">Choose a day…</option>
          {eventDates.map((date) => (
            <option key={date} value={date}>{formatDate(date)}</option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Start time" htmlFor="slot-start-time">
          <Input id="slot-start-time" type="time" value={formData.startTime} onChange={(e) => setFormData({ ...formData, startTime: e.target.value })} />
        </Field>
        <Field label="End time" htmlFor="slot-end-time">
          <Input id="slot-end-time" type="time" value={formData.endTime} onChange={(e) => setFormData({ ...formData, endTime: e.target.value })} />
        </Field>
      </div>

      <Field label="Room" htmlFor="slot-venue">
        <Select id="slot-venue" value={formData.venueId} onChange={(e) => setFormData({ ...formData, venueId: e.target.value })}>
          <option value="">Choose a room…</option>
          {venues.map((venue) => (
            <option key={venue.id} value={venue.id}>
              {venue.name}{venue.capacity ? ` (${venue.capacity} seats)` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Label (optional)" htmlFor="slot-label">
        <Input
          id="slot-label"
          placeholder="e.g. Morning sessions, Keynote slot"
          value={formData.label}
          onChange={(e) => setFormData({ ...formData, label: e.target.value })}
          maxLength={100}
        />
      </Field>

      <div className="flex items-center gap-3">
        <Switch id="slot-is-break" checked={formData.isBreak} onCheckedChange={(isBreak) => setFormData({ ...formData, isBreak })} />
        <Label htmlFor="slot-is-break" className="cursor-pointer">Mark as a break or meal</Label>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{isEditing ? 'Save changes' : 'Add time slot'}</Button>
      </div>
    </form>
  );
}

// ============================================================================
// Bulk Generator Component
// ============================================================================

interface BulkGeneratorProps {
  venues: WizardVenue[];
  eventDates: string[];
  existingSlots: WizardTimeSlot[];
  onGenerate: (slots: Omit<WizardTimeSlot, 'id'>[]) => void;
  onCancel: () => void;
}

function BulkGenerator({ venues, eventDates, existingSlots, onGenerate, onCancel }: BulkGeneratorProps) {
  const [formData, setFormData] = React.useState<BulkGeneratorFormData>({
    ...INITIAL_BULK_DATA,
    dayDate: eventDates[0] || '',
    venueId: venues[0]?.id || '',
  });

  const preview = React.useMemo<Omit<WizardTimeSlot, 'id'>[]>(() => {
    if (!formData.dayDate || !formData.venueId) return [];

    const overlaps = (from: number, to: number) =>
      existingSlots.some((existing) => {
        if (existing.dayDate !== formData.dayDate || existing.venueId !== formData.venueId) return false;
        return from < timeToMinutes(existing.endTime) && to > timeToMinutes(existing.startTime);
      });

    const slots: Omit<WizardTimeSlot, 'id'>[] = [];
    let currentMinutes = formData.startHour * 60;
    const endMinutes = formData.endHour * 60;

    while (currentMinutes + formData.durationMinutes <= endMinutes) {
      const slotEndMinutes = currentMinutes + formData.durationMinutes;
      if (!overlaps(currentMinutes, slotEndMinutes)) {
        slots.push({
          dayDate: formData.dayDate,
          startTime: minutesToTime(currentMinutes),
          endTime: minutesToTime(slotEndMinutes),
          venueId: formData.venueId,
          label: '',
          isBreak: false,
        });
      }
      currentMinutes = slotEndMinutes;

      if (formData.includeBreaks && currentMinutes + formData.durationMinutes <= endMinutes) {
        const breakEndMinutes = currentMinutes + formData.breakDuration;
        if (!overlaps(currentMinutes, breakEndMinutes)) {
          slots.push({
            dayDate: formData.dayDate,
            startTime: minutesToTime(currentMinutes),
            endTime: minutesToTime(breakEndMinutes),
            venueId: formData.venueId,
            label: 'Break',
            isBreak: true,
          });
        }
        currentMinutes = breakEndMinutes;
      }
    }
    return slots;
  }, [formData, existingSlots]);

  const selectedVenue = venues.find((v) => v.id === formData.venueId);
  const hourOptions = Array.from({ length: 24 }, (_, i) => (
    <option key={i} value={i}>{formatTime(`${i.toString().padStart(2, '0')}:00`)}</option>
  ));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Day" htmlFor="bulk-date">
          <Select id="bulk-date" value={formData.dayDate} onChange={(e) => setFormData({ ...formData, dayDate: e.target.value })}>
            {eventDates.map((date) => (
              <option key={date} value={date}>{formatDate(date)}</option>
            ))}
          </Select>
        </Field>

        <Field label="Room" htmlFor="bulk-venue">
          <Select id="bulk-venue" value={formData.venueId} onChange={(e) => setFormData({ ...formData, venueId: e.target.value })}>
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>{venue.name}</option>
            ))}
          </Select>
        </Field>

        <Field label="First slot starts" htmlFor="bulk-start">
          <Select id="bulk-start" value={formData.startHour} onChange={(e) => setFormData({ ...formData, startHour: Number(e.target.value) })}>
            {hourOptions}
          </Select>
        </Field>

        <Field label="Last slot ends by" htmlFor="bulk-end">
          <Select id="bulk-end" value={formData.endHour} onChange={(e) => setFormData({ ...formData, endHour: Number(e.target.value) })}>
            {hourOptions}
          </Select>
        </Field>

        <Field label="Slot length" htmlFor="bulk-duration">
          <Select id="bulk-duration" value={formData.durationMinutes} onChange={(e) => setFormData({ ...formData, durationMinutes: Number(e.target.value) })}>
            {DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </Field>

        <div className="space-y-2">
          <Label htmlFor="bulk-breaks">Breaks between sessions</Label>
          <div className="flex items-center gap-3 h-11">
            <Switch id="bulk-breaks" checked={formData.includeBreaks} onCheckedChange={(includeBreaks) => setFormData({ ...formData, includeBreaks })} />
            <span className="text-sm text-muted-foreground">Add a break after each session</span>
          </div>
        </div>

        {formData.includeBreaks && (
          <Field label="Break length" htmlFor="bulk-break-duration">
            <Select id="bulk-break-duration" value={formData.breakDuration} onChange={(e) => setFormData({ ...formData, breakDuration: Number(e.target.value) })}>
              {BREAK_DURATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {preview.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Preview ({plural(preview.length, 'slot')})</p>
          <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto">
            <div className="space-y-1.5">
              {preview.map((slot, index) => (
                <div
                  key={index}
                  className={cn('flex items-center justify-between text-sm px-2 py-1 rounded', slot.isBreak ? 'bg-muted text-muted-foreground' : 'bg-background')}
                >
                  <span>{formatRange(slot.startTime, slot.endTime)}</span>
                  {slot.isBreak && <Badge variant="secondary">Break</Badge>}
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Slots are created in {selectedVenue?.name || 'the chosen room'} on {formData.dayDate ? formatDate(formData.dayDate) : 'the chosen day'}.
          </p>
        </div>
      )}

      {preview.length === 0 && formData.startHour >= formData.endHour && (
        <p className="text-sm text-destructive" role="alert">The end must be after the start.</p>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="button" onClick={() => onGenerate(preview)} disabled={preview.length === 0}>
          <Zap className="h-4 w-4 mr-2" aria-hidden="true" />
          Generate {plural(preview.length, 'slot')}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Slot actions (the one "Add a slot / Generate slots" pair)
// ============================================================================

function SlotActions({ onAdd, onBulk, className }: { onAdd: () => void; onBulk: () => void; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      <Button variant="outline" size="sm" onClick={onAdd}>
        <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Add a slot
      </Button>
      <Button variant="outline" size="sm" onClick={onBulk}>
        <Zap className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Generate slots
      </Button>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

type ViewMode = 'calendar' | 'list';

export function ScheduleStep({ state, dispatch }: ScheduleStepProps) {
  const { schedule, venues, dates } = state;
  const [showForm, setShowForm] = React.useState(false);
  const [showBulkGenerator, setShowBulkGenerator] = React.useState(false);
  const [editingSlot, setEditingSlot] = React.useState<WizardTimeSlot | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>('calendar');
  const [calendarVenue, setCalendarVenue] = React.useState<string | 'all'>('all');

  const eventDates = React.useMemo(() => {
    if (!dates.startDate || !dates.endDate) return [];
    return getEventDates(dates.startDate, dates.endDate);
  }, [dates.startDate, dates.endDate]);

  const slotsByDate = React.useMemo(() => {
    const grouped: Record<string, WizardTimeSlot[]> = {};
    for (const slot of schedule.timeSlots) {
      (grouped[slot.dayDate] ??= []).push(slot);
    }
    for (const date of Object.keys(grouped)) {
      grouped[date].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    }
    return grouped;
  }, [schedule.timeSlots]);

  const hasDates = eventDates.length > 0;
  const hasVenues = venues.length > 0;
  const canAddSlots = hasDates && hasVenues;

  const handleAddSlot = () => {
    setEditingSlot(null);
    setShowForm(true);
    setShowBulkGenerator(false);
  };

  const handleEditSlot = (slot: WizardTimeSlot) => {
    setEditingSlot(slot);
    setShowForm(true);
    setShowBulkGenerator(false);
  };

  const handleDeleteSlot = (id: string) => {
    dispatch({ type: 'REMOVE_TIME_SLOT', payload: id });
  };

  const handleFormSubmit = (data: TimeSlotFormData) => {
    const slotData: WizardTimeSlot = { id: editingSlot?.id || generateId(), ...data };
    if (editingSlot) {
      dispatch({ type: 'UPDATE_TIME_SLOT', payload: { id: editingSlot.id, updates: slotData } });
    } else {
      dispatch({ type: 'ADD_TIME_SLOT', payload: slotData });
    }
    setShowForm(false);
    setEditingSlot(null);
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingSlot(null);
  };

  const handleShowBulkGenerator = () => {
    setShowBulkGenerator(true);
    setShowForm(false);
    setEditingSlot(null);
  };

  const handleBulkGenerate = (slots: Omit<WizardTimeSlot, 'id'>[]) => {
    for (const slot of slots) {
      dispatch({ type: 'ADD_TIME_SLOT', payload: { ...slot, id: generateId() } });
    }
    setShowBulkGenerator(false);
  };

  const getVenueById = (id: string) => venues.find((v) => v.id === id);

  // Calendar create handler — emits one slot per venueId
  const handleCalendarCreate = (venueIds: string[], dayDate: string, startTime: string, endTime: string) => {
    for (const vid of venueIds) {
      dispatch({
        type: 'ADD_TIME_SLOT',
        payload: { id: generateId(), venueId: vid, dayDate, startTime, endTime, label: '', isBreak: false },
      });
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Schedule</CardTitle>
              <CardDescription>
                Time slots are the windows a session can be scheduled into; sessions are assigned later. Parallel slots in different rooms are fine, overlapping slots in one room are not. Mark meals and coffee as breaks so they read differently.
              </CardDescription>
            </div>
            {canAddSlots && (
              <SegmentedControl<ViewMode>
                aria-label="Schedule view"
                size="sm"
                value={viewMode}
                onValueChange={setViewMode}
                options={[
                  { value: 'calendar', label: 'Calendar', icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> },
                  { value: 'list', label: 'List', icon: <List className="h-3.5 w-3.5" aria-hidden="true" /> },
                ]}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canAddSlots && (
            <div className="rounded-lg bg-muted/50 border p-4 text-sm text-muted-foreground space-y-2">
              {!hasDates && (
                <p className="flex items-center gap-2 flex-wrap">
                  <Calendar className="h-4 w-4" aria-hidden="true" />
                  Choose the gathering’s dates first.
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => dispatch({ type: 'SET_STEP', payload: getNumberFromStep('dates') })}>
                    Go to Dates
                  </Button>
                </p>
              )}
              {!hasVenues && (
                <p className="flex items-center gap-2 flex-wrap">
                  <MapPin className="h-4 w-4" aria-hidden="true" />
                  Add at least one room before creating time slots.
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => dispatch({ type: 'SET_STEP', payload: getNumberFromStep('venues') })}>
                    Go to Venues
                  </Button>
                </p>
              )}
              <p>You can also build the schedule later from the organizer workspace.</p>
            </div>
          )}

          {canAddSlots && viewMode === 'calendar' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Label htmlFor="calendar-venue" className="text-sm">Room</Label>
                  <Select
                    id="calendar-venue"
                    value={calendarVenue}
                    onChange={(e) => setCalendarVenue(e.target.value as string | 'all')}
                    wrapperClassName="w-auto"
                    className="w-auto min-w-[200px]"
                  >
                    <option value="all">All rooms (one slot per room)</option>
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </Select>
                  {calendarVenue === 'all' && (
                    <span className="text-xs text-muted-foreground">Creates one slot in each of the {plural(venues.length, 'room')}</span>
                  )}
                </div>
                {!showForm && !showBulkGenerator && <SlotActions onAdd={handleAddSlot} onBulk={handleShowBulkGenerator} />}
              </div>

              <ScheduleCalendar
                eventDates={eventDates}
                venues={venues}
                slots={schedule.timeSlots}
                selectedVenueId={calendarVenue}
                onCreateSlot={handleCalendarCreate}
                onEditSlot={handleEditSlot}
                onDeleteSlot={handleDeleteSlot}
              />
            </div>
          )}

          {canAddSlots && viewMode === 'list' && Object.keys(slotsByDate).length > 0 && (
            <div className="space-y-4">
              {eventDates
                .filter((date) => slotsByDate[date]?.length > 0)
                .map((date) => (
                  <div key={date} className="space-y-2">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      {formatDate(date)}
                      <Badge variant="secondary">{plural(slotsByDate[date].length, 'slot')}</Badge>
                    </h4>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {slotsByDate[date].map((slot) => (
                        <TimeSlotCard key={slot.id} slot={slot} venue={getVenueById(slot.venueId)} onEdit={handleEditSlot} onDelete={handleDeleteSlot} />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}

          {canAddSlots && viewMode === 'list' && schedule.timeSlots.length === 0 && !showForm && !showBulkGenerator && (
            <div className="text-center py-8 border-2 border-dashed rounded-lg">
              <Clock className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" aria-hidden="true" />
              <p className="text-muted-foreground mb-4">No time slots yet. Add them one at a time or generate a day at once.</p>
              <SlotActions onAdd={handleAddSlot} onBulk={handleShowBulkGenerator} className="justify-center" />
            </div>
          )}

          {canAddSlots && viewMode === 'list' && schedule.timeSlots.length > 0 && !showForm && !showBulkGenerator && (
            <SlotActions onAdd={handleAddSlot} onBulk={handleShowBulkGenerator} />
          )}

          {showForm && canAddSlots && (
            <Card className="border-primary/50">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{editingSlot ? 'Edit time slot' : 'New time slot'}</CardTitle>
                  <Button variant="ghost" size="icon-sm" onClick={handleFormCancel} aria-label="Close the time slot form">
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <TimeSlotForm
                  key={editingSlot?.id ?? 'new'}
                  initialData={editingSlot}
                  venues={venues}
                  eventDates={eventDates}
                  existingSlots={schedule.timeSlots}
                  eventStartDate={dates.startDate}
                  eventEndDate={dates.endDate}
                  onSubmit={handleFormSubmit}
                  onCancel={handleFormCancel}
                  isEditing={!!editingSlot}
                />
              </CardContent>
            </Card>
          )}

          {showBulkGenerator && canAddSlots && (
            <Card className="border-primary/50">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">Generate time slots</CardTitle>
                    <CardDescription className="mt-1">Fill a day in one room with evenly spaced slots.</CardDescription>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => setShowBulkGenerator(false)} aria-label="Close the generator">
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <BulkGenerator
                  venues={venues}
                  eventDates={eventDates}
                  existingSlots={schedule.timeSlots}
                  onGenerate={handleBulkGenerate}
                  onCancel={() => setShowBulkGenerator(false)}
                />
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ScheduleStep;
