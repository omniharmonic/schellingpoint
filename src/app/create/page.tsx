'use client';

import * as React from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SiteHeader } from '@/components/SiteHeader';
import { Footer } from '@/components/Footer';
import { PageHeader } from '@/components/PageHeader';
import { ELLIPSIS } from '@/lib/format';
import { validateWizardState } from '@/lib/events/validate-creation';
import { useAuth } from '@/hooks/useAuth';

import { useWizardStateWithPersistence } from './useWizardPersistence';
import { WizardStepTabs, WizardNavButtons, WizardValidationErrors, getMaxNavigableStep } from './WizardNavigation';
import {
  getStepFromNumber,
  getNumberFromStep,
  stepForValidationArea,
  type WizardState,
  type WizardAction,
} from './useWizardState';

import IdentityStep from './steps/IdentityStep';
import BasicsStep from './steps/BasicsStep';
import DatesStep from './steps/DatesStep';
import VenuesStep from './steps/VenuesStep';
import ScheduleStep from './steps/ScheduleStep';
import TracksStep from './steps/TracksStep';
import ParticipationStep from './steps/ParticipationStep';
import VotingStep from './steps/VotingStep';
import BrandingStep from './steps/BrandingStep';
import ReviewStep from './steps/ReviewStep';

// ============================================================================
// Step Props Interface
// ============================================================================

interface StepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

const LOGIN_HREF = '/login?returnTo=%2Fcreate';

// ============================================================================
// Resume Draft Dialog
// ============================================================================

interface ResumeDraftDialogProps {
  open: boolean;
  timestamp: Date | null;
  onResume: () => void;
  onStartFresh: () => void;
}

function ResumeDraftDialog({ open, timestamp, onResume, onStartFresh }: ResumeDraftDialogProps) {
  const formattedTime = timestamp
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : null;

  return (
    // Escape and clicking outside keep the draft: resuming is the safe choice.
    <Dialog open={open} onOpenChange={(next) => { if (!next) onResume(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Pick up where you left off?</DialogTitle>
          <DialogDescription>
            {formattedTime ? `A draft of your gathering was saved on this device on ${formattedTime}.` : 'A draft of your gathering was saved on this device.'}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Starting fresh deletes that saved draft. This cannot be undone.</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onStartFresh}>Start fresh</Button>
          <Button onClick={onResume}>Resume draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Main Wizard Content
// ============================================================================

function CreateWizardContent() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const {
    state,
    dispatch,
    clearDraft,
    hasSavedDraft,
    getDraftTimestamp,
    lastSavedAt,
  } = useWizardStateWithPersistence();

  // State for showing resume dialog
  const [showResumeDialog, setShowResumeDialog] = React.useState(false);
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [slugSuggestions, setSlugSuggestions] = React.useState<string[]>([]);

  // Redirect to login if not authenticated
  React.useEffect(() => {
    if (!authLoading && !user) {
      router.push(LOGIN_HREF);
    }
  }, [user, authLoading, router]);

  // Check for saved draft on mount
  React.useEffect(() => {
    // Only check on initial mount
    if (!isInitialized) {
      const hasDraft = hasSavedDraft();
      if (hasDraft && state.basics.name === '' && state.currentStep === 0) {
        // There's a draft but state is empty, show resume dialog
        setShowResumeDialog(true);
      }
      setIsInitialized(true);
    }
  }, [hasSavedDraft, isInitialized, state.basics.name, state.currentStep]);

  // Handle resume draft
  const handleResume = React.useCallback(() => {
    setShowResumeDialog(false);
    // State is already loaded by useWizardStateWithPersistence
  }, []);

  // Handle start fresh
  const handleStartFresh = React.useCallback(() => {
    clearDraft(true);
    setShowResumeDialog(false);
  }, [clearDraft]);

  // Scroll to top whenever the step changes so the new step loads at the top
  // of the viewport (fixes the review page opening scrolled to the bottom).
  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [state.currentStep]);

  // Handler for event submission
  const handleSubmit = React.useCallback(async () => {
    if (isSubmitting) return;
    const validation = validateWizardState(state);
    if (!validation.valid) {
      setSubmitError(validation.error || 'Review your gathering’s details.');
      dispatch({ type: 'SET_STEP', payload: stepForValidationArea(validation.step, validation.error) });
      return;
    }
    if (!state.identity.acknowledged) {
      setSubmitError('Confirm what becomes public before creating the gathering.');
      dispatch({ type: 'SET_STEP', payload: getNumberFromStep('identity') });
      return;
    }
    if (!state.identity.termsAccepted) {
      setSubmitError('Accept the terms and privacy policy before creating the gathering.');
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    setSlugSuggestions([]);

    try {
      // Same-origin with the session cookie (plan §3.3). Read the body directly: a 409
      // carries slug suggestions alongside the error.
      const response = await fetch('/api/events/create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ wizardState: state }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        suggestions?: string[];
        eventSlug?: string;
        event?: { slug: string };
        identity?: { status: 'created' | 'pending'; error?: string };
      };

      if (!response.ok || !data.success) {
        if (response.status === 401) {
          setSubmitError('Your session has expired. Sign in again to continue.');
        } else if (response.status === 409) {
          setSubmitError(data.error || 'This event URL is already taken.');
          if (data.suggestions?.length) setSlugSuggestions(data.suggestions);
          dispatch({ type: 'SET_STEP', payload: getNumberFromStep('identity') });
        } else {
          setSubmitError(data.error || 'The gathering could not be created. Try again.');
        }
        setIsSubmitting(false);
        return;
      }

      clearDraft();
      const eventSlug = data.eventSlug || data.event?.slug;
      // The organizer workspace shows the "your gathering is ready" banner for `created=1`.
      // A pending identity is surfaced, with a retry, in Event settings.
      const destination = data.identity?.status === 'pending'
        ? 'admin/settings?identity=pending&created=1#network'
        : 'admin?created=1';
      router.push(eventSlug ? `/e/${eventSlug}/${destination}` : '/');
    } catch (error) {
      console.error('Error creating event:', error);
      setSubmitError('Something went wrong. Your draft is safe; try again.');
      setIsSubmitting(false);
    }
  }, [state, clearDraft, router, dispatch, isSubmitting]);

  React.useEffect(() => {
    if (submitError) document.getElementById('create-submit-error')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [submitError]);

  // Handler to apply a slug suggestion
  const handleApplySlugSuggestion = React.useCallback((suggestion: string) => {
    dispatch({ type: 'UPDATE_BASICS', payload: { slug: suggestion } });
    setSlugSuggestions([]);
    setSubmitError(null);
  }, [dispatch]);

  // Get current step component
  const renderStep = () => {
    const stepName = getStepFromNumber(state.currentStep);
    const props: StepProps = { state, dispatch };

    switch (stepName) {
      case 'identity':
        return <IdentityStep {...props} />;
      case 'basics':
        return <BasicsStep {...props} />;
      case 'dates':
        return <DatesStep {...props} />;
      case 'venues':
        return <VenuesStep {...props} />;
      case 'schedule':
        return <ScheduleStep {...props} />;
      case 'tracks':
        return <TracksStep {...props} />;
      case 'participation':
        return <ParticipationStep {...props} />;
      case 'voting':
        return <VotingStep {...props} />;
      case 'branding':
        return <BrandingStep {...props} />;
      case 'review':
        return (
          <ReviewStep
            state={state}
            dispatch={dispatch}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
          />
        );
      default:
        return <div>Unknown step</div>;
    }
  };

  // Show loading while checking authentication
  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            {authLoading ? `Loading${ELLIPSIS}` : `Redirecting to sign in${ELLIPSIS}`}
          </p>
        </div>
      </div>
    );
  }

  const datesStep = getNumberFromStep('dates');
  const reviewStep = getNumberFromStep('review');
  const canSkipToReview = getMaxNavigableStep(state) >= reviewStep;
  const draftSavedLabel = lastSavedAt
    ? `Draft saved on this device at ${new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(lastSavedAt)}`
    : null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      {/* Main Content */}
      <main className="container mx-auto px-5 py-8 flex-1">
        <div className="max-w-5xl mx-auto space-y-8">
          <PageHeader
            eyebrow="Create a gathering"
            title="Make room for your people."
            subtitle="Start with the essentials. Add the spaces, topics, and small details that make this gathering yours."
            actions={draftSavedLabel ? <p className="text-sm text-muted-foreground" aria-live="polite">{draftSavedLabel}</p> : undefined}
            className="mb-0"
          />

          {/* Wizard Content */}
          <div className="space-y-6">
            {/* Error Alert */}
            {submitError && (
              <Alert id="create-submit-error" variant="destructive">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription className="space-y-3">
                  <p>{submitError}</p>
                  {/* Login button for auth errors */}
                  {(submitError.includes('signed in') || submitError.includes('session has expired')) && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={LOGIN_HREF}>
                        <LogIn className="h-4 w-4 mr-2" aria-hidden="true" />
                        Sign in
                      </Link>
                    </Button>
                  )}
                  {slugSuggestions.length > 0 && (
                    <div className="pt-2">
                      <p className="text-sm font-medium mb-2">Try one of these available URLs:</p>
                      <div className="flex flex-wrap gap-2">
                        {slugSuggestions.map((suggestion) => (
                          <Button
                            key={suggestion}
                            variant="outline"
                            size="sm"
                            onClick={() => handleApplySlugSuggestion(suggestion)}
                          >
                            {suggestion}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* Step tabs and the current step's validation errors */}
            <Card>
              <CardContent className="py-4 space-y-4">
                <WizardStepTabs state={state} dispatch={dispatch} />
                <WizardValidationErrors state={state} />
              </CardContent>
            </Card>

            {/* Step Content */}
            <div className="min-h-[400px] space-y-6">
              {renderStep()}
              {state.currentStep === datesStep && (
                <div className="rounded-xl border bg-secondary/40 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">Start simple.</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Use the defaults for now. Add rooms, time slots and program details from your organizer workspace.
                    </p>
                    {!canSkipToReview && (
                      <p className="mt-1 text-xs text-muted-foreground">Choose your dates first, then you can skip straight to the review.</p>
                    )}
                  </div>
                  <Button
                    disabled={!canSkipToReview}
                    onClick={() => dispatch({ type: 'SET_STEP', payload: reviewStep })}
                  >
                    Continue with defaults
                  </Button>
                </div>
              )}
            </div>

            {/* The one sticky navigation bar: Back on every step after the first, Continue until Review. */}
            <Card className="sticky bottom-3 z-10 shadow-lg">
              <CardContent className="py-4">
                <WizardNavButtons state={state} dispatch={dispatch} />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <Footer variant="minimal" />

      {/* Resume Draft Dialog */}
      <ResumeDraftDialog
        open={showResumeDialog}
        timestamp={getDraftTimestamp()}
        onResume={handleResume}
        onStartFresh={handleStartFresh}
      />
    </div>
  );
}

// ============================================================================
// Page Export with Suspense
// ============================================================================

export default function CreateEventPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      }
    >
      <CreateWizardContent />
    </Suspense>
  );
}
