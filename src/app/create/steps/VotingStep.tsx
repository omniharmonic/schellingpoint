'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { WarningBox } from '@/components/WarningBox';
import { Field, Toggle, ChoiceCard } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { VOTING_MECHANISMS } from '@/app/e/[slug]/admin/settings/_components/constants';
import { POLICY_THRESHOLD_BOUNDS, type GatheringPolicyThresholds } from '@/lib/events/policy';
import type { WizardState, WizardAction } from '../useWizardState';

/**
 * "Voting" mirrors the organizer settings Voting + Safeguards sections: credits, mechanism,
 * voting window, and the policy thresholds that become part of the gathering's public rules.
 */

interface VotingStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

/** At creation the only organizer is the person filling in the wizard. */
const ORGANIZERS_AT_CREATION = 1;

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

export function VotingStep({ state, dispatch }: VotingStepProps) {
  const { voting } = state;
  const errors = state.validation.voting ?? [];
  const thresholds = voting.policyThresholds;

  const updateVoting = (updates: Partial<typeof voting>) => dispatch({ type: 'UPDATE_VOTING', payload: updates });
  const setThresholds = (updates: Partial<GatheringPolicyThresholds>) =>
    updateVoting({ policyThresholds: { ...thresholds, ...updates } });

  const creditsError = errors.find((e) => /credits/i.test(e)) ?? null;
  const thresholdError = errors.find((e) => /threshold/i.test(e)) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Voting</CardTitle>
          <CardDescription>How people spend their credits, and when the polls are open. Times are in {state.dates.timezone}; voting also needs the phase to be “Voting open”, which you set from the organizer workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Field label="Credits per attendee" htmlFor="credits" hint="Each member receives this many credits to spread across sessions." error={creditsError}>
            <Input
              id="credits"
              type="number"
              inputMode="numeric"
              min={1}
              value={voting.credits}
              onChange={(e) => { const v = parseInt(e.target.value, 10); updateVoting({ credits: Number.isNaN(v) ? 0 : v }); }}
              className="max-w-[200px]"
              error={!!creditsError}
            />
          </Field>

          <div role="radiogroup" aria-label="Voting method" className="space-y-3">
            <p className="text-sm font-medium">Voting method</p>
            {VOTING_MECHANISMS.map((option) => (
              <ChoiceCard
                key={option.value}
                selected={voting.mechanism === option.value}
                onSelect={() => updateVoting({ mechanism: option.value })}
                label={option.label}
                description={option.description}
              />
            ))}
          </div>

          <div>
            <p className="text-sm font-medium mb-1">Voting window (optional)</p>
            <p className="text-xs text-muted-foreground mb-3">Usually opens after proposals close. Leave blank to rely on the phase alone.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Opens" htmlFor="votingOpensAt">
                <Input id="votingOpensAt" type="datetime-local" value={voting.votingOpensAt || ''} onChange={(e) => updateVoting({ votingOpensAt: e.target.value || null })} />
              </Field>
              <Field label="Closes" htmlFor="votingClosesAt">
                <Input id="votingClosesAt" type="datetime-local" value={voting.votingClosesAt || ''} onChange={(e) => updateVoting({ votingClosesAt: e.target.value || null })} />
              </Field>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Policy thresholds (freeschool.draft.policy#thresholds) */}
      <Card>
        <CardHeader>
          <CardTitle>Safeguards</CardTitle>
          <CardDescription>Rules that protect a published program and the people voting on it. They become part of the gathering’s public policy when you publish it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Field
            label="Approvals to move or cancel a published session"
            htmlFor="destructiveActionStewards"
            error={thresholdError}
            hint={`A published session is a public calendar record people may already rely on. ${thresholds.destructiveActionStewards === 1 ? 'With 1, any single organizer can move or cancel one.' : `With ${thresholds.destructiveActionStewards}, no single organizer can do it alone.`}`}
          >
            <Select
              id="destructiveActionStewards"
              value={thresholds.destructiveActionStewards}
              onChange={(e) => setThresholds({ destructiveActionStewards: parseInt(e.target.value, 10) })}
              wrapperClassName="max-w-[220px]"
            >
              {range(POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.min, POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.max).map((n) => (
                <option key={n} value={n}>{n} organizer{n === 1 ? '' : 's'}</option>
              ))}
            </Select>
          </Field>
          {thresholds.destructiveActionStewards > ORGANIZERS_AT_CREATION && (
            <WarningBox title="You are the only organizer so far">
              Moving or cancelling a published session will need {thresholds.destructiveActionStewards} organizers to approve. Invite co-organizers before you publish the schedule, or you will not be able to change it. You can also lower this later in Event settings.
            </WarningBox>
          )}

          <Field
            label="Fewest voters before a count is shown"
            htmlFor="feedbackK"
            hint={`Vote and feedback results for a session appear only once at least ${thresholds.feedbackK} people took part, so no individual choice can be worked out. Below that, the result reads “fewer than ${thresholds.feedbackK}”.`}
          >
            <Select
              id="feedbackK"
              value={thresholds.feedbackK}
              onChange={(e) => setThresholds({ feedbackK: parseInt(e.target.value, 10) })}
              wrapperClassName="max-w-[220px]"
            >
              {range(POLICY_THRESHOLD_BOUNDS.feedbackK.min, POLICY_THRESHOLD_BOUNDS.feedbackK.max).map((n) => (
                <option key={n} value={n}>{n} people</option>
              ))}
            </Select>
          </Field>

          <Toggle
            id="publishRoles"
            checked={thresholds.publishRoles}
            onChange={(publishRoles) => setThresholds({ publishRoles })}
            label="Let hosts and organizers publish their role"
            description="Off by default. When on, a host or organizer may add “I hosted at this gathering” to their public profile. Nobody’s role is published without their own opt-in."
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default VotingStep;
