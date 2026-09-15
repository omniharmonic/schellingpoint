'use client';

import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WizardState, WizardAction, VotingMechanism } from '../useWizardState';
import { POLICY_THRESHOLD_BOUNDS, type GatheringPolicyThresholds } from '@/lib/events/policy';

// ============================================================================
// Types
// ============================================================================

interface VotingStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

// ============================================================================
// Constants
// ============================================================================

const VOTING_MECHANISMS: {
  value: VotingMechanism;
  label: string;
  description: string;
}[] = [
  {
    value: 'quadratic',
    label: 'Quadratic',
    description:
      'Cost increases quadratically. 1 vote = 1 credit, 2 votes = 4 credits, 3 votes = 9 credits. Encourages broad support.',
  },
  {
    value: 'linear',
    label: 'Linear',
    description: '1 vote = 1 credit. Simple and straightforward.',
  },
  {
    value: 'approval',
    label: 'Approval',
    description: 'One vote per session, costing one credit. Support as many sessions as your budget allows.',
  },
];

const SESSION_FORMATS: { value: string; label: string }[] = [
  { value: 'talk', label: 'Talk' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'panel', label: 'Panel' },
  { value: 'discussion', label: 'Discussion' },
  { value: 'demo', label: 'Demo' },
  { value: 'fireside', label: 'Fireside Chat' },
  { value: 'ceremony', label: 'Ceremony' },
];

const SESSION_DURATIONS: { value: number; label: string }[] = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 45, label: '45 min' },
  { value: 60, label: '60 min' },
  { value: 90, label: '90 min' },
  { value: 120, label: '120 min' },
];

// ============================================================================
// Component
// ============================================================================

export function VotingStep({ state, dispatch }: VotingStepProps) {
  const { voting } = state;

  // Local state for custom format/duration inputs
  const [customFormatInput, setCustomFormatInput] = React.useState('');
  const [customDurationInput, setCustomDurationInput] = React.useState('');

  // Handler for updating voting fields
  const handleVotingChange = (updates: Partial<typeof voting>) => {
    dispatch({ type: 'UPDATE_VOTING', payload: updates });
  };

  // Normalize a custom format label to a slug-like value
  const normalizeFormatValue = (raw: string) =>
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  // Add a custom format
  const handleAddCustomFormat = () => {
    const value = normalizeFormatValue(customFormatInput);
    if (!value) return;
    if (!voting.allowedFormats.includes(value)) {
      handleVotingChange({ allowedFormats: [...voting.allowedFormats, value] });
    }
    setCustomFormatInput('');
  };

  // Add a custom duration
  const handleAddCustomDuration = () => {
    const value = parseInt(customDurationInput, 10);
    if (isNaN(value) || value <= 0) return;
    if (!voting.allowedDurations.includes(value)) {
      const next = [...voting.allowedDurations, value].sort((a, b) => a - b);
      handleVotingChange({ allowedDurations: next });
    }
    setCustomDurationInput('');
  };

  // Remove a format/duration (used for custom items not in presets)
  const handleRemoveFormat = (value: string) => {
    handleVotingChange({
      allowedFormats: voting.allowedFormats.filter((f) => f !== value),
    });
  };

  const handleRemoveDuration = (value: number) => {
    handleVotingChange({
      allowedDurations: voting.allowedDurations.filter((d) => d !== value),
    });
  };

  // Format a custom format value for display (convert 'fireside-chat' -> 'Fireside chat')
  const displayFormatLabel = (value: string) => {
    const preset = SESSION_FORMATS.find((f) => f.value === value);
    if (preset) return preset.label;
    return value
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  // Handler for number inputs
  const handleNumberChange =
    (field: 'credits' | 'maxProposalsPerUser') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value) && value >= 0) {
        handleVotingChange({ [field]: value });
      }
    };

  // Handler for datetime inputs
  const handleDatetimeChange =
    (field: 'votingOpensAt' | 'votingClosesAt' | 'proposalsOpenAt' | 'proposalsCloseAt') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // Convert empty string to null, otherwise store ISO datetime
      handleVotingChange({ [field]: value || null });
    };

  // Handler for voting mechanism selection
  const handleMechanismChange = (mechanism: VotingMechanism) => {
    handleVotingChange({ mechanism });
  };

  // Handler for format checkbox toggle
  const handleFormatToggle = (format: string) => {
    const currentFormats = voting.allowedFormats;
    const newFormats = currentFormats.includes(format)
      ? currentFormats.filter((f) => f !== format)
      : [...currentFormats, format];
    handleVotingChange({ allowedFormats: newFormats });
  };

  // Handler for duration checkbox toggle
  const handleDurationToggle = (duration: number) => {
    const currentDurations = voting.allowedDurations;
    const newDurations = currentDurations.includes(duration)
      ? currentDurations.filter((d) => d !== duration)
      : [...currentDurations, duration];
    handleVotingChange({ allowedDurations: newDurations });
  };

  const thresholds = voting.policyThresholds;
  const setThresholds = (updates: Partial<GatheringPolicyThresholds>) => {
    handleVotingChange({ policyThresholds: { ...thresholds, ...updates } });
  };
  const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

  // Handler for proposal approval toggle
  const handleApprovalToggle = () => {
    handleVotingChange({ requireProposalApproval: !voting.requireProposalApproval });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">All opening and closing times use {state.dates.timezone}. The organizer also opens each phase from Event settings.</p>
      {/* Vote Credits */}
      <Card>
        <CardHeader>
          <CardTitle>Vote Credits</CardTitle>
          <CardDescription>
            Each attendee receives this many credits to allocate across sessions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="credits">Credits per Attendee</Label>
            <Input
              id="credits"
              type="number"
              min={1}
              value={voting.credits}
              onChange={handleNumberChange('credits')}
              className="max-w-[200px]"
              error={state.validation.voting?.includes('Vote credits must be greater than 0')}
            />
          </div>
        </CardContent>
      </Card>

      {/* Voting Mechanism */}
      <Card>
        <CardHeader>
          <CardTitle>Voting Mechanism</CardTitle>
          <CardDescription>
            Choose how votes are counted and credits are spent
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {VOTING_MECHANISMS.map((mechanism) => (
              <button
                key={mechanism.value}
                type="button"
                onClick={() => handleMechanismChange(mechanism.value)}
                className={cn(
                  'flex items-start w-full p-4 rounded-lg border-2 text-left transition-all',
                  'hover:border-primary/50 hover:bg-accent/50',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  voting.mechanism === mechanism.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border'
                )}
              >
                <div
                  className={cn(
                    'flex items-center justify-center w-5 h-5 rounded-full border-2 mr-4 mt-0.5 flex-shrink-0',
                    voting.mechanism === mechanism.value
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground'
                  )}
                >
                  {voting.mechanism === mechanism.value && (
                    <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                  )}
                </div>
                <div>
                  <span className="font-medium">{mechanism.label}</span>
                  <p className="text-sm text-muted-foreground mt-1">
                    {mechanism.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Proposal Window */}
      <Card>
        <CardHeader>
          <CardTitle>Proposal Window</CardTitle>
          <CardDescription>
            When can attendees submit session proposals?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="proposalsOpenAt">Opens At</Label>
              <Input
                id="proposalsOpenAt"
                type="datetime-local"
                value={voting.proposalsOpenAt || ''}
                onChange={handleDatetimeChange('proposalsOpenAt')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proposalsCloseAt">Closes At</Label>
              <Input
                id="proposalsCloseAt"
                type="datetime-local"
                value={voting.proposalsCloseAt || ''}
                onChange={handleDatetimeChange('proposalsCloseAt')}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Voting Window */}
      <Card>
        <CardHeader>
          <CardTitle>Voting Window</CardTitle>
          <CardDescription>
            When can attendees vote on sessions? Typically opens after proposals close.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="votingOpensAt">Opens At</Label>
              <Input
                id="votingOpensAt"
                type="datetime-local"
                value={voting.votingOpensAt || ''}
                onChange={handleDatetimeChange('votingOpensAt')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="votingClosesAt">Closes At</Label>
              <Input
                id="votingClosesAt"
                type="datetime-local"
                value={voting.votingClosesAt || ''}
                onChange={handleDatetimeChange('votingClosesAt')}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Proposal Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Proposal Settings</CardTitle>
          <CardDescription>
            Configure how session proposals work
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Max Proposals Per User */}
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={voting.maxProposalsPerUser === 0}
                onClick={() =>
                  handleVotingChange({
                    maxProposalsPerUser: voting.maxProposalsPerUser === 0 ? 3 : 0,
                  })
                }
                className={cn(
                  'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  voting.maxProposalsPerUser === 0 ? 'bg-primary' : 'bg-muted'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out',
                    voting.maxProposalsPerUser === 0 ? 'translate-x-5' : 'translate-x-0'
                  )}
                />
              </button>
              <div className="space-y-1">
                <Label className="cursor-pointer" onClick={() =>
                  handleVotingChange({
                    maxProposalsPerUser: voting.maxProposalsPerUser === 0 ? 3 : 0,
                  })
                }>
                  No per-user proposal limit
                </Label>
                <p className="text-sm text-muted-foreground">
                  When enabled, attendees can submit unlimited session proposals.
                </p>
              </div>
            </div>

            {voting.maxProposalsPerUser !== 0 && (
              <div className="space-y-2 pl-14">
                <Label htmlFor="maxProposals">Max Proposals Per User</Label>
                <Input
                  id="maxProposals"
                  type="number"
                  min={1}
                  value={voting.maxProposalsPerUser}
                  onChange={handleNumberChange('maxProposalsPerUser')}
                  className="max-w-[200px]"
                  error={state.validation.voting?.includes(
                    'Max proposals per user must be greater than 0'
                  )}
                />
                <p className="text-sm text-muted-foreground">
                  How many sessions can each person propose?
                </p>
              </div>
            )}
          </div>

          {/* Require Proposal Approval */}
          <div className="flex items-start space-x-3">
            <button
              type="button"
              role="switch"
              aria-checked={voting.requireProposalApproval}
              onClick={handleApprovalToggle}
              className={cn(
                'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                voting.requireProposalApproval ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out',
                  voting.requireProposalApproval ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
            <div className="space-y-1">
              <Label className="cursor-pointer" onClick={handleApprovalToggle}>
                Require Admin Approval
              </Label>
              <p className="text-sm text-muted-foreground">
                Off by default: proposals are public as soon as they are written, and organizers decline by not scheduling. Turn this on to review each proposal before it is listed.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Policy thresholds (freeschool.draft.policy#thresholds) */}
      <Card>
        <CardHeader>
          <CardTitle>Safeguards</CardTitle>
          <CardDescription>
            These become part of the gathering&apos;s public rules when you publish it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="destructiveActionStewards">Approvals to move or cancel a published session</Label>
            <select
              id="destructiveActionStewards"
              value={thresholds.destructiveActionStewards}
              onChange={(e) => setThresholds({ destructiveActionStewards: parseInt(e.target.value, 10) })}
              className="w-full max-w-[200px] rounded-xl border bg-background p-2.5 text-sm"
            >
              {range(POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.min, POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.max).map((n) => (
                <option key={n} value={n}>{n} organizer{n === 1 ? '' : 's'}</option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">
              Once the schedule is published, a session is a public calendar record people may already rely on. Moving or cancelling it needs this many organizers to approve. With {thresholds.destructiveActionStewards === 1 ? 'one, any single organizer can do it alone' : `${thresholds.destructiveActionStewards}, no single organizer can do it alone`}.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedbackK">Fewest voters before a count is shown</Label>
            <select
              id="feedbackK"
              value={thresholds.feedbackK}
              onChange={(e) => setThresholds({ feedbackK: parseInt(e.target.value, 10) })}
              className="w-full max-w-[200px] rounded-xl border bg-background p-2.5 text-sm"
            >
              {range(POLICY_THRESHOLD_BOUNDS.feedbackK.min, POLICY_THRESHOLD_BOUNDS.feedbackK.max).map((n) => (
                <option key={n} value={n}>{n} people</option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">
              Vote and feedback results for a session are only shown once at least this many people took part, so no one&apos;s individual choice can be worked out. Below it, the result reads “fewer than {thresholds.feedbackK}”.
            </p>
          </div>

          <div className="flex items-start gap-3">
            <button
              type="button"
              role="switch"
              id="publishRoles"
              aria-checked={thresholds.publishRoles}
              onClick={() => setThresholds({ publishRoles: !thresholds.publishRoles })}
              className={cn(
                'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                thresholds.publishRoles ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out',
                  thresholds.publishRoles ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
            <div className="space-y-1">
              <Label htmlFor="publishRoles" className="cursor-pointer" onClick={() => setThresholds({ publishRoles: !thresholds.publishRoles })}>
                Let hosts and organizers publish their role
              </Label>
              <p className="text-sm text-muted-foreground">
                Off by default. When on, a host or organizer can choose to add “I hosted at this gathering” to their public profile. Nobody&apos;s role is published without their own opt-in.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Allowed Formats */}
      <Card>
        <CardHeader>
          <CardTitle>Allowed Session Formats</CardTitle>
          <CardDescription>
            What types of sessions can attendees propose?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {SESSION_FORMATS.map((format) => {
              const isSelected = voting.allowedFormats.includes(format.value);
              return (
                <button
                  key={format.value}
                  type="button"
                  onClick={() => handleFormatToggle(format.value)}
                  className={cn(
                    'flex items-center p-3 rounded-lg border-2 transition-all',
                    'hover:border-primary/50 hover:bg-accent/50',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    isSelected ? 'border-primary bg-primary/5' : 'border-border'
                  )}
                >
                  <div
                    className={cn(
                      'flex items-center justify-center w-5 h-5 rounded border-2 mr-3 flex-shrink-0',
                      isSelected
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground'
                    )}
                  >
                    {isSelected && (
                      <svg
                        className="w-3 h-3 text-primary-foreground"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm font-medium">{format.label}</span>
                </button>
              );
            })}
          </div>

          {/* Custom Formats (added by organizer) */}
          {voting.allowedFormats.filter(
            (v) => !SESSION_FORMATS.some((f) => f.value === v)
          ).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground tracking-wide">
                Custom formats
              </p>
              <div className="flex flex-wrap gap-2">
                {voting.allowedFormats
                  .filter((v) => !SESSION_FORMATS.some((f) => f.value === v))
                  .map((value) => (
                    <span
                      key={value}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border-2 border-primary bg-primary/5"
                    >
                      {displayFormatLabel(value)}
                      <button
                        type="button"
                        onClick={() => handleRemoveFormat(value)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={`Remove ${value}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Add custom format input */}
          <div className="flex gap-2 items-center pt-2 border-t">
            <Input
              placeholder="Add a custom format (e.g., Fireside chat)"
              value={customFormatInput}
              onChange={(e) => setCustomFormatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCustomFormat();
                }
              }}
              maxLength={50}
              className="max-w-xs"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleAddCustomFormat}
              disabled={!customFormatInput.trim()}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>

          {state.validation.voting?.includes(
            'At least one session format must be allowed'
          ) && (
            <p className="text-sm text-destructive mt-2">
              Please select at least one session format
            </p>
          )}
        </CardContent>
      </Card>

      {/* Allowed Durations */}
      <Card>
        <CardHeader>
          <CardTitle>Allowed Session Durations</CardTitle>
          <CardDescription>
            What session lengths are available for proposals?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {SESSION_DURATIONS.map((duration) => {
              const isSelected = voting.allowedDurations.includes(duration.value);
              return (
                <button
                  key={duration.value}
                  type="button"
                  onClick={() => handleDurationToggle(duration.value)}
                  className={cn(
                    'flex items-center justify-center p-3 rounded-lg border-2 transition-all',
                    'hover:border-primary/50 hover:bg-accent/50',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    isSelected ? 'border-primary bg-primary/5' : 'border-border'
                  )}
                >
                  <div
                    className={cn(
                      'flex items-center justify-center w-5 h-5 rounded border-2 mr-2 flex-shrink-0',
                      isSelected
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground'
                    )}
                  >
                    {isSelected && (
                      <svg
                        className="w-3 h-3 text-primary-foreground"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm font-medium">{duration.label}</span>
                </button>
              );
            })}
          </div>

          {/* Custom Durations (organizer-added) */}
          {voting.allowedDurations.filter(
            (v) => !SESSION_DURATIONS.some((d) => d.value === v)
          ).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground tracking-wide">
                Custom durations
              </p>
              <div className="flex flex-wrap gap-2">
                {voting.allowedDurations
                  .filter((v) => !SESSION_DURATIONS.some((d) => d.value === v))
                  .map((value) => (
                    <span
                      key={value}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border-2 border-primary bg-primary/5"
                    >
                      {value} min
                      <button
                        type="button"
                        onClick={() => handleRemoveDuration(value)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={`Remove ${value} min`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Add custom duration input */}
          <div className="flex gap-2 items-center pt-2 border-t">
            <Input
              type="number"
              min={1}
              max={600}
              placeholder="Duration in minutes"
              value={customDurationInput}
              onChange={(e) => setCustomDurationInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCustomDuration();
                }
              }}
              className="max-w-[200px]"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleAddCustomDuration}
              disabled={!customDurationInput.trim()}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>

          {state.validation.voting?.includes(
            'At least one session duration must be allowed'
          ) && (
            <p className="text-sm text-destructive mt-2">
              Please select at least one session duration
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default VotingStep;
