'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { MAX_CONTRIBUTION_PERCENT } from '@/lib/payments/format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RemovableChip } from '@/components/ui/removable-chip';
import { Field, Toggle, ChoiceCard } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { SESSION_FORMATS, SESSION_DURATIONS } from '@/app/e/[slug]/admin/settings/_components/constants';
import type { WizardState, WizardAction } from '../useWizardState';

/**
 * "Participation" mirrors the organizer settings section of the same name: how people join
 * (admission, platform contribution) and how they propose sessions (window, formats, lengths,
 * limits, suggested topics). Storage is unchanged: admission lives on `basics`, the rest on
 * `voting`, exactly as the create API expects.
 */

interface ParticipationStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

export const ADMISSION_OPTIONS: { value: boolean; label: string; description: string }[] = [
  { value: false, label: 'Open participation', description: 'People join and help shape the program.' },
  { value: true, label: 'Ticket required', description: 'A free or paid ticket unlocks participation.' },
];

const normalizeFormatValue = (raw: string) =>
  raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "fireside" → "Fireside chat"; "lightning-talk" → "Lightning talk". */
export function formatLabel(value: string): string {
  const preset = SESSION_FORMATS.find((f) => f.value === value);
  if (preset) return preset.label;
  const words = value.split('-').filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

export function ParticipationStep({ state, dispatch }: ParticipationStepProps) {
  const { basics, voting, suggestedTopics } = state;
  const errors = state.validation.participation ?? [];
  const [customFormatInput, setCustomFormatInput] = React.useState('');
  const [customDurationInput, setCustomDurationInput] = React.useState('');
  const [topicInput, setTopicInput] = React.useState('');

  const updateVoting = (updates: Partial<typeof voting>) => dispatch({ type: 'UPDATE_VOTING', payload: updates });

  const toggleFormat = (value: string) =>
    updateVoting({ allowedFormats: voting.allowedFormats.includes(value) ? voting.allowedFormats.filter((f) => f !== value) : [...voting.allowedFormats, value] });

  const toggleDuration = (value: number) =>
    updateVoting({ allowedDurations: voting.allowedDurations.includes(value) ? voting.allowedDurations.filter((d) => d !== value) : [...voting.allowedDurations, value].sort((a, b) => a - b) });

  const addCustomFormat = () => {
    const value = normalizeFormatValue(customFormatInput);
    if (value && !voting.allowedFormats.includes(value)) updateVoting({ allowedFormats: [...voting.allowedFormats, value] });
    setCustomFormatInput('');
  };

  const addCustomDuration = () => {
    const value = parseInt(customDurationInput, 10);
    if (Number.isInteger(value) && value > 0 && !voting.allowedDurations.includes(value)) {
      updateVoting({ allowedDurations: [...voting.allowedDurations, value].sort((a, b) => a - b) });
    }
    setCustomDurationInput('');
  };

  const addTopics = () => {
    const values = topicInput.split(',').map((t) => t.trim()).filter(Boolean);
    if (values.length) {
      const existing = new Set(suggestedTopics.map((t) => t.toLowerCase()));
      const fresh = values.filter((v) => !existing.has(v.toLowerCase()));
      if (fresh.length) dispatch({ type: 'SET_SUGGESTED_TOPICS', payload: [...suggestedTopics, ...fresh] });
    }
    setTopicInput('');
  };

  const customFormats = voting.allowedFormats.filter((v) => !SESSION_FORMATS.some((f) => f.value === v));
  const customDurations = voting.allowedDurations.filter((d) => !SESSION_DURATIONS.includes(d));
  const unlimited = voting.maxProposalsPerUser === 0;
  const feeError = errors.find((e) => /contribution/i.test(e)) ?? null;
  const formatError = errors.find((e) => /format/i.test(e)) ?? null;
  const durationError = errors.find((e) => /length/i.test(e)) ?? null;
  const limitError = errors.find((e) => /limit/i.test(e)) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Admission</CardTitle>
          <CardDescription>How people join. Ticket tiers and payouts are set up after the gathering exists.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div role="radiogroup" aria-label="Admission" className="grid gap-3 sm:grid-cols-2">
            {ADMISSION_OPTIONS.map((option) => (
              <ChoiceCard
                key={option.label}
                selected={Boolean(basics.ticketingEnabled) === option.value}
                onSelect={() => dispatch({ type: 'UPDATE_BASICS', payload: { ticketingEnabled: option.value } })}
                label={option.label}
                description={option.description}
              />
            ))}
          </div>
          <Field
            label="Platform contribution (%)"
            htmlFor="creation-contribution"
            hint="What you give back on paid tickets, from 1%. No fixed surcharge; free gatherings stay free. Card processing fees are separate."
            error={feeError}
          >
            <Input
              id="creation-contribution"
              type="number"
              inputMode="decimal"
              min={1}
              max={MAX_CONTRIBUTION_PERCENT}
              step={0.01}
              value={basics.platformFeePercent ?? 1}
              className="max-w-[200px]"
              error={!!feeError}
              onChange={(event) => dispatch({ type: 'UPDATE_BASICS', payload: { platformFeePercent: Number(event.target.value) } })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Proposals</CardTitle>
          <CardDescription>When people can propose sessions, in which formats, and how many. Times are in {state.dates.timezone}; leave the window blank to rely on the gathering’s phase alone.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <p className="text-sm font-medium mb-3">Proposal window (optional)</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Opens" htmlFor="proposalsOpenAt">
                <Input id="proposalsOpenAt" type="datetime-local" value={voting.proposalsOpenAt || ''} onChange={(e) => updateVoting({ proposalsOpenAt: e.target.value || null })} />
              </Field>
              <Field label="Closes" htmlFor="proposalsCloseAt">
                <Input id="proposalsCloseAt" type="datetime-local" value={voting.proposalsCloseAt || ''} onChange={(e) => updateVoting({ proposalsCloseAt: e.target.value || null })} />
              </Field>
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Session formats</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SESSION_FORMATS.map((format) => (
                <label key={format.value} className="flex items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <Checkbox checked={voting.allowedFormats.includes(format.value)} onCheckedChange={() => toggleFormat(format.value)} aria-label={format.label} />
                  {format.label}
                </label>
              ))}
            </div>
            {customFormats.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {customFormats.map((value) => (
                  <RemovableChip key={value} label={formatLabel(value)} variant="default" onRemove={() => toggleFormat(value)} />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                placeholder="Add a format (e.g. Lightning talk)"
                aria-label="Custom session format"
                value={customFormatInput}
                onChange={(e) => setCustomFormatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomFormat(); } }}
                maxLength={50}
                className="max-w-xs"
              />
              <Button type="button" variant="outline" size="sm" onClick={addCustomFormat} disabled={!customFormatInput.trim()}>
                <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
                Add
              </Button>
            </div>
            {formatError ? <p className="text-xs text-destructive" role="alert">{formatError}</p> : null}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Session lengths</legend>
            <div className="flex flex-wrap gap-2">
              {SESSION_DURATIONS.map((duration) => (
                <label key={duration} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <Checkbox checked={voting.allowedDurations.includes(duration)} onCheckedChange={() => toggleDuration(duration)} aria-label={`${duration} minutes`} />
                  {duration} min
                </label>
              ))}
              {customDurations.map((duration) => (
                <RemovableChip key={duration} label={`${duration} min`} variant="default" onRemove={() => toggleDuration(duration)} removeLabel={`Remove the ${duration} minute option`} />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                value={customDurationInput}
                onChange={(e) => setCustomDurationInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomDuration(); } }}
                placeholder="Custom minutes"
                className="max-w-[180px]"
                aria-label="Custom session length in minutes"
              />
              <Button type="button" variant="outline" size="sm" onClick={addCustomDuration} disabled={!customDurationInput.trim()}>
                <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
                Add
              </Button>
            </div>
            {durationError ? <p className="text-xs text-destructive" role="alert">{durationError}</p> : null}
          </fieldset>

          <div className="space-y-4">
            <Toggle
              id="unlimited-proposals"
              checked={unlimited}
              onChange={(next) => updateVoting({ maxProposalsPerUser: next ? 0 : 3 })}
              label="No per-person proposal limit"
              description="When on, anyone can propose as many sessions as they like."
            />
            {!unlimited ? (
              <Field label="Proposals per person" htmlFor="maxProposals" className="pl-14" error={limitError}>
                <Input
                  id="maxProposals"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1000}
                  value={voting.maxProposalsPerUser}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v) && v >= 0) updateVoting({ maxProposalsPerUser: v }); }}
                  className="max-w-[160px]"
                  error={!!limitError}
                />
              </Field>
            ) : null}
            <Toggle
              id="require-approval"
              checked={voting.requireProposalApproval}
              onChange={(requireProposalApproval) => updateVoting({ requireProposalApproval })}
              label="Require organizer approval"
              description="Off by default: proposals are listed as soon as they are written, and organizers decline by not scheduling. Turn on to review each one before it appears."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suggested topics</CardTitle>
          <CardDescription>
            Shown to people as prompts on their profile and when tagging a proposal. Specific to this gathering; use whatever fits your community. Optional.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Add topics" htmlFor="topic-input" hint="Press Enter or use commas to add several.">
            <div className="flex items-center gap-2">
              <Input
                id="topic-input"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTopics(); } }}
                placeholder="e.g. Governance, Local food systems"
                maxLength={80}
              />
              <Button type="button" variant="outline" size="sm" onClick={addTopics} disabled={!topicInput.trim()}>
                <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
                Add
              </Button>
            </div>
          </Field>
          {suggestedTopics.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {suggestedTopics.map((topic) => (
                <RemovableChip key={topic} label={topic} onRemove={() => dispatch({ type: 'SET_SUGGESTED_TOPICS', payload: suggestedTopics.filter((t) => t !== topic) })} removeLabel={`Remove topic ${topic}`} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No topics yet. People will add their own interests if you leave this empty.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ParticipationStep;
