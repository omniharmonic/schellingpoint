'use client';

import * as React from 'react';
import {
  Pencil,
  Calendar,
  MapPin,
  Building2,
  Clock,
  Tag,
  Vote,
  Palette,
  AlertCircle,
  CheckCircle2,
  Fingerprint,
  Users,
  FileText,
  ExternalLink,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { validateWizardState } from '@/lib/events/validate-creation';
import { plural, truncate, formatDateRange, ELLIPSIS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { VOTING_MECHANISMS, THEME_MODES, socialToList } from '@/app/e/[slug]/admin/settings/_components/constants';
import { EVENT_TYPES, VISIBILITY_OPTIONS } from './BasicsStep';
import { LOCATION_TYPE_OPTIONS } from './DatesStep';
import { featureLabel } from './VenuesStep';
import { formatLabel } from './ParticipationStep';
import {
  STEP_LABELS,
  getNumberFromStep,
  getStepFromNumber,
  isStepValid,
  stepForValidationArea,
  type WizardState,
  type WizardAction,
  type WizardStepName,
} from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface ReviewStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onSubmit: () => Promise<void>;
  isSubmitting: boolean;
}

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  stepName: WizardStepName;
  onEdit: (step: number) => void;
  children: React.ReactNode;
  isValid?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatDateTime(dateTimeString: string | null, timezone: string): string {
  if (!dateTimeString) return 'Not set';
  // datetime-local values are the gathering's wall clock; show them as typed.
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(dateTimeString);
  try {
    const date = local ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5])) : new Date(dateTimeString);
    return `${date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} (${timezone})`;
  } catch {
    return dateTimeString;
  }
}

const labelFor = <T extends string>(options: { value: T; label: string }[], value: string, fallback = value) =>
  options.find((o) => o.value === value)?.label ?? fallback;

// ============================================================================
// Sub-Components
// ============================================================================

function Section({ title, icon, stepName, onEdit, children, isValid = true }: SectionProps) {
  const stepNumber = getNumberFromStep(stepName);

  return (
    <Card className={cn(!isValid && 'border-signal-amber/50')}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className={cn('text-muted-foreground', !isValid && 'text-signal-amber')} aria-hidden="true">{icon}</div>
            <CardTitle className="text-lg">{title}</CardTitle>
            {!isValid && <AlertCircle className="h-4 w-4 text-signal-amber" aria-label="Needs attention" />}
          </div>
          <Button variant="ghost" size="sm" onClick={() => onEdit(stepNumber)} aria-label={`Edit ${title.toLowerCase()}`} className="text-muted-foreground hover:text-foreground shrink-0">
            <Pencil className="h-4 w-4 mr-1" aria-hidden="true" />
            Edit
          </Button>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DataRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn('font-medium text-right min-w-0 break-words', mono && 'font-mono text-sm')}>{value}</span>
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-medium text-muted-foreground mb-2">{children}</p>;
}

function ChipList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item} variant="muted">{item}</Badge>
      ))}
    </div>
  );
}

/** The one thing that still blocks creation, with a link to the step that fixes it. */
function readiness(state: WizardState): { ok: true } | { ok: false; error: string; step: number } {
  const validation = validateWizardState(state);
  if (!validation.valid) {
    return { ok: false, error: validation.error || 'Review the gathering’s details.', step: stepForValidationArea(validation.step, validation.error) };
  }
  if (!state.identity.acknowledged) {
    return { ok: false, error: 'Confirm what becomes public.', step: getNumberFromStep('identity') };
  }
  return { ok: true };
}

function ValidationSummary({ state, onEdit }: { state: WizardState; onEdit: (step: number) => void }) {
  const ready = readiness(state);

  if (ready.ok) {
    return (
      <Alert variant="success">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Ready to create</AlertTitle>
        <AlertDescription>Everything required is filled in. Everything else can change from the organizer workspace.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="warning">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>One more thing before creating</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-x-2">
        <span>{ready.error}</span>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onEdit(ready.step)}>
          Go to {STEP_LABELS[getStepFromNumber(ready.step)]}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function ReviewStep({ state, dispatch, onSubmit, isSubmitting }: ReviewStepProps) {
  const { basics, dates, venues, schedule, tracks, voting, branding, identity } = state;
  const termsAccepted = identity.termsAccepted;

  const handleEdit = React.useCallback(
    (stepNumber: number) => dispatch({ type: 'SET_STEP', payload: stepNumber }),
    [dispatch]
  );

  const ready = readiness(state);
  const canCreate = ready.ok && termsAccepted && !isSubmitting;

  const handleSubmit = async () => {
    if (!canCreate) return;
    await onSubmit();
  };

  const scheduleDays = new Set(schedule.timeSlots.map((slot) => slot.dayDate)).size;
  const links = socialToList(branding.social);
  const showLocation = dates.locationType !== 'virtual';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-display font-semibold tracking-tight">Review</h2>
        <p className="text-muted-foreground mt-1">Check the details before creating the gathering. Nothing is published until you say so.</p>
      </div>

      <ValidationSummary state={state} onEdit={handleEdit} />

      <Section title="Identity" icon={<Fingerprint className="h-5 w-5" />} stepName="identity" onEdit={handleEdit} isValid={isStepValid(state, getNumberFromStep('identity'))}>
        <div className="space-y-1">
          <DataRow label="Name" value={basics.name || 'Not set'} />
          <DataRow label="URL" value={<span><span className="text-muted-foreground">/e/</span>{basics.slug || 'not-set'}</span>} mono />
          <DataRow label="Network identity" value="Created with the gathering (a draft publishes nothing)" />
          <DataRow label="What becomes public" value={identity.acknowledged ? 'Acknowledged' : 'Not yet acknowledged'} />
        </div>
      </Section>

      <Section title="Basics" icon={<FileText className="h-5 w-5" />} stepName="basics" onEdit={handleEdit} isValid={isStepValid(state, getNumberFromStep('basics'))}>
        <div className="space-y-1">
          <DataRow label="Tagline" value={basics.tagline ? truncate(basics.tagline, 80) : 'None'} />
          <DataRow label="Description" value={basics.description ? truncate(basics.description, 120) : 'None'} />
          <DataRow
            label="Type"
            value={labelFor(EVENT_TYPES, basics.eventType, basics.eventType ? basics.eventType.charAt(0).toUpperCase() + basics.eventType.slice(1) : 'Not set')}
          />
          <DataRow label="Visibility" value={labelFor(VISIBILITY_OPTIONS, basics.visibility)} />
        </div>
      </Section>

      <Section title="Dates" icon={<Calendar className="h-5 w-5" />} stepName="dates" onEdit={handleEdit} isValid={isStepValid(state, getNumberFromStep('dates'))}>
        <div className="space-y-1">
          <DataRow label="When" value={dates.startDate && dates.endDate ? formatDateRange(`${dates.startDate}T00:00:00Z`, `${dates.endDate}T00:00:00Z`, 'UTC') : 'Not set'} />
          <DataRow label="Timezone" value={dates.timezone || 'Not set'} />
          <DataRow label="Where" value={labelFor(LOCATION_TYPE_OPTIONS, dates.locationType)} />
          {showLocation && dates.locationName && (
            <DataRow label="Location" value={<span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden="true" />{dates.locationName}</span>} />
          )}
          {showLocation && dates.locationAddress && <DataRow label="Address" value={truncate(dates.locationAddress, 60)} />}
        </div>
      </Section>

      <Section title="Venues" icon={<Building2 className="h-5 w-5" />} stepName="venues" onEdit={handleEdit}>
        {venues.length > 0 ? (
          <div className="space-y-3">
            {venues.map((venue) => (
              <div key={venue.id} className="p-3 rounded-lg bg-muted/50 space-y-1">
                <p className="font-medium">{venue.name}</p>
                {venue.capacity ? <p className="text-sm text-muted-foreground">Capacity: {venue.capacity}</p> : null}
                {venue.features.length > 0 && <ChipList items={venue.features.map(featureLabel)} />}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No rooms yet. Add them from the organizer workspace.</p>
        )}
      </Section>

      <Section title="Schedule" icon={<Clock className="h-5 w-5" />} stepName="schedule" onEdit={handleEdit}>
        {schedule.timeSlots.length > 0 ? (
          <div className="space-y-1">
            <DataRow label="Time slots" value={plural(schedule.timeSlots.length, 'slot')} />
            <DataRow label="Days with slots" value={plural(scheduleDays, 'day')} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No time slots yet. Build the schedule from the organizer workspace.</p>
        )}
      </Section>

      <Section title="Tracks" icon={<Tag className="h-5 w-5" />} stepName="tracks" onEdit={handleEdit}>
        {tracks.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {tracks.map((track) => (
              <span
                key={track.id}
                className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border"
                style={{ backgroundColor: `${track.color}20`, color: track.color, borderColor: `${track.color}40` }}
              >
                <span className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: track.color }} aria-hidden="true" />
                {track.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No tracks. Sessions can still be proposed without them.</p>
        )}
      </Section>

      <Section title="Participation" icon={<Users className="h-5 w-5" />} stepName="participation" onEdit={handleEdit} isValid={isStepValid(state, getNumberFromStep('participation'))}>
        <div className="space-y-4">
          <div className="space-y-1">
            <DataRow label="Admission" value={basics.ticketingEnabled ? 'Ticket required' : 'Open participation'} />
            <DataRow label="Platform contribution" value={`${basics.platformFeePercent ?? 1}% of paid ticket sales`} />
            <DataRow label="Proposals per person" value={voting.maxProposalsPerUser === 0 ? 'Unlimited' : String(voting.maxProposalsPerUser)} />
            <DataRow label="Organizer approval" value={voting.requireProposalApproval ? 'Required before listing' : 'Not required'} />
          </div>
          <div className="pt-2 border-t">
            <SubHeading>Proposal window</SubHeading>
            <div className="space-y-1">
              <DataRow label="Opens" value={formatDateTime(voting.proposalsOpenAt, dates.timezone)} />
              <DataRow label="Closes" value={formatDateTime(voting.proposalsCloseAt, dates.timezone)} />
            </div>
          </div>
          <div className="pt-2 border-t">
            <SubHeading>Session formats</SubHeading>
            <ChipList items={voting.allowedFormats.map(formatLabel)} />
          </div>
          <div className="pt-2 border-t">
            <SubHeading>Session lengths</SubHeading>
            <ChipList items={voting.allowedDurations.map((d) => `${d} min`)} />
          </div>
          {state.suggestedTopics.length > 0 && (
            <div className="pt-2 border-t">
              <SubHeading>Suggested topics</SubHeading>
              <ChipList items={state.suggestedTopics} />
            </div>
          )}
        </div>
      </Section>

      <Section title="Voting" icon={<Vote className="h-5 w-5" />} stepName="voting" onEdit={handleEdit} isValid={isStepValid(state, getNumberFromStep('voting'))}>
        <div className="space-y-4">
          <div className="space-y-1">
            <DataRow label="Method" value={labelFor(VOTING_MECHANISMS, voting.mechanism)} />
            <DataRow label="Credits per attendee" value={voting.credits} />
          </div>
          <div className="pt-2 border-t">
            <SubHeading>Voting window</SubHeading>
            <div className="space-y-1">
              <DataRow label="Opens" value={formatDateTime(voting.votingOpensAt, dates.timezone)} />
              <DataRow label="Closes" value={formatDateTime(voting.votingClosesAt, dates.timezone)} />
            </div>
          </div>
          <div className="pt-2 border-t">
            <SubHeading>Safeguards</SubHeading>
            <div className="space-y-1">
              <DataRow label="Approvals to move or cancel a published session" value={plural(voting.policyThresholds.destructiveActionStewards, 'organizer')} />
              <DataRow label="Fewest voters before a count is shown" value={plural(voting.policyThresholds.feedbackK, 'person', 'people')} />
              <DataRow label="Hosts may publish their role" value={voting.policyThresholds.publishRoles ? 'Allowed (each person opts in)' : 'Off'} />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Branding" icon={<Palette className="h-5 w-5" />} stepName="branding" onEdit={handleEdit}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <SubHeading>Logo</SubHeading>
              {branding.logoUrl ? (
                <img src={branding.logoUrl} alt="Gathering logo" className="h-16 w-16 object-contain rounded-lg border" />
              ) : (
                <div className="h-16 w-16 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">None</span>
                </div>
              )}
            </div>
            <div>
              <SubHeading>Banner</SubHeading>
              {branding.bannerUrl ? (
                <img src={branding.bannerUrl} alt="Gathering banner" className="h-16 w-32 object-cover rounded-lg border" />
              ) : (
                <div className="h-16 w-32 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">None</span>
                </div>
              )}
            </div>
          </div>

          <div className="pt-2 border-t">
            <SubHeading>Colors</SubHeading>
            <div className="flex items-center gap-3">
              <div className="flex gap-1">
                <div className="w-8 h-8 rounded-full border shadow-sm" style={{ backgroundColor: branding.theme.primary }} title="Primary" />
                <div className="w-8 h-8 rounded-full border shadow-sm" style={{ backgroundColor: branding.theme.secondary }} title="Secondary" />
                <div className="w-8 h-8 rounded-full border shadow-sm" style={{ backgroundColor: branding.theme.accent }} title="Accent" />
              </div>
              <span className="text-sm text-muted-foreground">Appearance: {labelFor(THEME_MODES, branding.theme.mode)}</span>
            </div>
            <div
              className="h-2 rounded-full mt-2"
              style={{ background: `linear-gradient(to right, ${branding.theme.primary}, ${branding.theme.secondary}, ${branding.theme.accent})` }}
            />
          </div>

          {links.length > 0 && (
            <div className="pt-2 border-t">
              <SubHeading>Links</SubHeading>
              <ul className="flex flex-wrap gap-2">
                {links.map((link) => (
                  <li key={`${link.label}-${link.url}`}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs font-medium hover:text-primary"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Section>

      {/* Terms */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <Checkbox
              id="terms-accepted"
              checked={termsAccepted}
              onCheckedChange={(checked) => dispatch({ type: 'UPDATE_IDENTITY', payload: { termsAccepted: checked === true } })}
              className="mt-0.5"
            />
            <label htmlFor="terms-accepted" className="cursor-pointer">
              <span className="font-medium">I agree to the terms and privacy policy</span>
              <p className="text-sm text-muted-foreground mt-0.5">
                By creating this gathering you agree to the{' '}
                <a href="/terms" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">terms of service</a>{' '}
                and{' '}
                <a href="/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">privacy policy</a>.
              </p>
            </label>
          </div>
        </CardContent>
      </Card>

      <div className="pt-2 space-y-2">
        <Button size="lg" className="w-full" onClick={handleSubmit} loading={isSubmitting} disabled={!canCreate}>
          {isSubmitting ? `Creating the gathering${ELLIPSIS}` : 'Create a gathering'}
        </Button>
        {!ready.ok ? (
          <p className="text-sm text-muted-foreground text-center">
            {ready.error}{' '}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => handleEdit(ready.step)}>
              Go to {STEP_LABELS[getStepFromNumber(ready.step)]}
            </Button>
          </p>
        ) : !termsAccepted ? (
          <p className="text-sm text-muted-foreground text-center">Accept the terms and privacy policy to continue.</p>
        ) : null}
      </div>
    </div>
  );
}

export default ReviewStep;
