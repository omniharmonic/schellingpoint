'use client';

import * as React from 'react';
import { useCallback, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TimezonePicker, getBrowserTimezone } from '@/components/ui/timezone-picker';
import { Field, ChoiceCard } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import type { WizardState, WizardAction, LocationType } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface DatesStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

// ============================================================================
// Constants
// ============================================================================

export const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string; description: string }[] = [
  { value: 'in-person', label: 'In person', description: 'A physical venue' },
  { value: 'virtual', label: 'Online', description: 'Online only' },
  { value: 'hybrid', label: 'Hybrid', description: 'Both in person and online' },
];

// ============================================================================
// Main Component
// ============================================================================

export function DatesStep({ state, dispatch }: DatesStepProps) {
  const { dates } = state;
  const errors = state.validation.dates ?? [];

  // Set default timezone on mount if not set
  useEffect(() => {
    if (!dates.timezone) {
      dispatch({ type: 'UPDATE_DATES', payload: { timezone: getBrowserTimezone() } });
    }
  }, [dates.timezone, dispatch]);

  const ordered = !dates.startDate || !dates.endDate || dates.endDate >= dates.startDate;

  const handleStartDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newStartDate = e.target.value;
      // Keep the end date on or after the start date.
      const endDate = dates.endDate && newStartDate && dates.endDate < newStartDate ? newStartDate : dates.endDate;
      dispatch({ type: 'UPDATE_DATES', payload: { startDate: newStartDate, endDate } });
    },
    [dates.endDate, dispatch]
  );

  const handleEndDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      dispatch({ type: 'UPDATE_DATES', payload: { endDate: e.target.value } });
    },
    [dispatch]
  );

  const handleTimezoneChange = useCallback(
    (value: string) => {
      dispatch({ type: 'UPDATE_DATES', payload: { timezone: value } });
    },
    [dispatch]
  );

  const handleLocationTypeChange = useCallback(
    (value: LocationType) => {
      // Clear location fields when switching to online only
      dispatch({
        type: 'UPDATE_DATES',
        payload: value === 'virtual' ? { locationType: value, locationName: '', locationAddress: '' } : { locationType: value },
      });
    },
    [dispatch]
  );

  const showLocationFields = dates.locationType === 'in-person' || dates.locationType === 'hybrid';
  const startError = errors.find((e) => /start date/i.test(e)) ?? null;
  const endError = errors.find((e) => /end date/i.test(e)) ?? (!ordered ? 'The end date must be on or after the start date' : null);
  const tzError = errors.find((e) => /timezone/i.test(e)) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Dates and timezone</CardTitle>
          <CardDescription>When the gathering happens. Proposal and voting deadlines, and the schedule, are shown on this clock.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Start date" htmlFor="startDate" error={startError}>
              <Input
                id="startDate"
                type="date"
                value={dates.startDate}
                onChange={handleStartDateChange}
                required
                error={!!startError}
              />
            </Field>
            <Field label="End date" htmlFor="endDate" error={endError}>
              <Input
                id="endDate"
                type="date"
                value={dates.endDate}
                onChange={handleEndDateChange}
                min={dates.startDate || undefined}
                required
                error={!!endError}
              />
            </Field>
          </div>

          <Field label="Timezone" hint="Every time in this gathering is shown in this timezone." error={tzError}>
            <TimezonePicker value={dates.timezone} onChange={handleTimezoneChange} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location</CardTitle>
          <CardDescription>Where people meet. Rooms come in the next step.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div role="radiogroup" aria-label="Location type" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {LOCATION_TYPE_OPTIONS.map((option) => (
              <ChoiceCard
                key={option.value}
                selected={dates.locationType === option.value}
                onSelect={() => handleLocationTypeChange(option.value)}
                label={option.label}
                description={option.description}
              />
            ))}
          </div>

          {showLocationFields && (
            <div className="space-y-4">
              <Field label="Location name (optional)" htmlFor="locationName" hint="The venue, building or city.">
                <Input
                  id="locationName"
                  type="text"
                  placeholder="e.g. University of Colorado Boulder"
                  value={dates.locationName}
                  onChange={(e) => dispatch({ type: 'UPDATE_DATES', payload: { locationName: e.target.value } })}
                  maxLength={200}
                />
              </Field>
              <Field label="Address (optional)" htmlFor="locationAddress" hint="Shared with members only; the public page shows the location name.">
                <Input
                  id="locationAddress"
                  type="text"
                  placeholder="e.g. 1234 Main St, Boulder, CO 80302"
                  value={dates.locationAddress}
                  onChange={(e) => dispatch({ type: 'UPDATE_DATES', payload: { locationAddress: e.target.value } })}
                  maxLength={500}
                />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default DatesStep;
