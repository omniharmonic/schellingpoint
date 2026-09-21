'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, ChoiceCard } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { MAX_DESCRIPTION_LENGTH, type WizardState, type WizardAction, type EventVisibility } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface BasicsStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

// ============================================================================
// Constants
// ============================================================================

export const EVENT_TYPES: { value: string; label: string; description: string }[] = [
  { value: 'unconference', label: 'Unconference', description: 'Participant-driven, open space format' },
  { value: 'hackathon', label: 'Hackathon', description: 'Building projects over a set time period' },
  { value: 'conference', label: 'Conference', description: 'Traditional talks and presentations' },
  { value: 'meetup', label: 'Meetup', description: 'Casual community gathering' },
];

const PRESET_EVENT_TYPE_VALUES = new Set(EVENT_TYPES.map((t) => t.value));

export const VISIBILITY_OPTIONS: { value: EventVisibility; label: string; description: string }[] = [
  { value: 'public', label: 'Public', description: 'Listed in discovery; anyone can find it' },
  { value: 'unlisted', label: 'Unlisted', description: 'Only people with the link can open it' },
  { value: 'private', label: 'Private', description: 'Invited members only' },
];

const MAX_TAGLINE_LENGTH = 200;

// ============================================================================
// Component
// ============================================================================

export function BasicsStep({ state, dispatch }: BasicsStepProps) {
  const { basics } = state;
  const errors = state.validation.basics ?? [];

  const handleFieldChange = (field: 'tagline' | 'description') => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    dispatch({ type: 'UPDATE_BASICS', payload: { [field]: e.target.value } });
  };

  // Tracks whether the organizer is entering a custom event type
  const isCustomEventType = !!basics.eventType && !PRESET_EVENT_TYPE_VALUES.has(basics.eventType);
  const [customMode, setCustomMode] = React.useState(isCustomEventType);
  const [customValue, setCustomValue] = React.useState(isCustomEventType ? basics.eventType : '');
  const typeError = errors.find((e) => /type/i.test(e)) ?? null;

  const handleCustomEventTypeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCustomValue(value);
    dispatch({ type: 'UPDATE_BASICS', payload: { eventType: value.trim() } });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>About the gathering</CardTitle>
          <CardDescription>The invitation: a line under the name, and the longer story.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Tagline (optional)" htmlFor="tagline" hint={`${basics.tagline.length}/${MAX_TAGLINE_LENGTH} · One line under the name.`}>
            <Input
              id="tagline"
              placeholder="A short, catchy description"
              value={basics.tagline}
              onChange={handleFieldChange('tagline')}
              maxLength={MAX_TAGLINE_LENGTH}
            />
          </Field>

          <Field label="Description (optional)" htmlFor="description" hint={`${basics.description.length}/${MAX_DESCRIPTION_LENGTH} · Markdown formatting is supported.`}>
            <Textarea
              id="description"
              placeholder="Tell people what this gathering is about…"
              value={basics.description}
              onChange={handleFieldChange('description')}
              rows={5}
              maxLength={MAX_DESCRIPTION_LENGTH}
            />
          </Field>
        </CardContent>
      </Card>

      {/* Event type */}
      <Card>
        <CardHeader>
          <CardTitle>Event type</CardTitle>
          <CardDescription>What kind of gathering are you organizing?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div role="radiogroup" aria-label="Event type" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {EVENT_TYPES.map((type) => (
              <ChoiceCard
                key={type.value}
                selected={!customMode && basics.eventType === type.value}
                onSelect={() => {
                  setCustomMode(false);
                  dispatch({ type: 'UPDATE_BASICS', payload: { eventType: type.value } });
                }}
                label={type.label}
                description={type.description}
              />
            ))}
            <ChoiceCard
              selected={customMode}
              onSelect={() => {
                setCustomMode(true);
                dispatch({ type: 'UPDATE_BASICS', payload: { eventType: customValue.trim() } });
              }}
              label="Other"
              description="Name your own event type"
            />
          </div>

          {customMode && (
            <Field label="Custom event type" htmlFor="custom-event-type" hint="Saved with the gathering and shown in the review." error={typeError}>
              <Input
                id="custom-event-type"
                placeholder="e.g. Retreat, Summit, Festival"
                value={customValue}
                onChange={handleCustomEventTypeChange}
                maxLength={50}
                error={!!typeError}
                autoFocus
              />
            </Field>
          )}
          {!customMode && typeError ? <p className="text-xs text-destructive" role="alert">{typeError}</p> : null}
        </CardContent>
      </Card>

      {/* Visibility */}
      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
          <CardDescription>Who can discover this gathering. Drafts stay out of discovery until published.</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Visibility" className="space-y-3">
            {VISIBILITY_OPTIONS.map((option) => (
              <ChoiceCard
                key={option.value}
                selected={basics.visibility === option.value}
                onSelect={() => dispatch({ type: 'UPDATE_BASICS', payload: { visibility: option.value } })}
                label={option.label}
                description={option.description}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default BasicsStep;
