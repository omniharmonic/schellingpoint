'use client';

import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Suspense } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { validateWizardState } from '@/lib/events/validate-creation';
import { useAuth } from '@/hooks/useAuth';

import { useWizardStateWithPersistence } from './useWizardPersistence';
import {
  WizardStepTabs,
  WizardNavButtons,
  WizardValidationErrors,
} from './WizardNavigation';
import { WIZARD_STEPS, getStepFromNumber, type WizardState, type WizardAction } from './useWizardState';

import BasicsStep from './steps/BasicsStep';
import DatesStep from './steps/DatesStep';
import VenuesStep from './steps/VenuesStep';
import ScheduleStep from './steps/ScheduleStep';
import TracksStep from './steps/TracksStep';
import VotingStep from './steps/VotingStep';
import BrandingStep from './steps/BrandingStep';
import IdentityStep from './steps/IdentityStep';
import ReviewStep from './steps/ReviewStep';

// ============================================================================
// Step Props Interface
// ============================================================================

interface StepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

// ============================================================================
// Step Loading Fallback
// ============================================================================

function StepLoadingFallback() {
  return (
    <Card>
      <CardContent className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Resume Draft Dialog
// ============================================================================

interface ResumeDraftDialogProps {
  timestamp: Date | null;
  onResume: () => void;
  onStartFresh: () => void;
}

function ResumeDraftDialog({ timestamp, onResume, onStartFresh }: ResumeDraftDialogProps) {
  const formattedTime = timestamp
    ? new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(timestamp)
    : 'Unknown';

  return (
    <Dialog.Root open><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-sm"/><Dialog.Content onEscapeKeyDown={e => e.preventDefault()} onPointerDownOutside={e => e.preventDefault()} className="fixed inset-0 z-50 flex items-center justify-center">
      <Card className="w-full max-w-md mx-4">
        <CardHeader>
          <Dialog.Title className="text-xl font-semibold">Pick up where you left off?</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">Your event draft was saved on {formattedTime}.</Dialog.Description>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Would you like to continue where you left off, or start fresh?
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onStartFresh} className="flex-1">
              Start Fresh
            </Button>
            <Button onClick={onResume} className="flex-1">
              Resume Draft
            </Button>
          </div>
        </CardContent>
      </Card>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
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
    nextStep,
    prevStep,
    clearDraft,
    hasSavedDraft,
    getDraftTimestamp,
    currentStepName,
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
      router.push('/login?redirect=/create');
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

  // Handler for next step (called after WizardNavigation validation)
  const handleNext = React.useCallback(() => {
    // WizardNavigation handles validation
    // This callback is called after successful navigation
  }, []);

  // Handler for previous step
  const handlePrev = React.useCallback(() => {
    // No additional logic needed
  }, []);

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
      setSubmitError(validation.error || 'Review your event details.');
      dispatch({ type: 'SET_STEP', payload: validation.step ?? 0 });
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    setSlugSuggestions([]);

    if (!state.identity.acknowledged) {
      setSubmitError('Confirm what becomes public before creating the gathering.');
      dispatch({ type: 'SET_STEP', payload: WIZARD_STEPS.indexOf('identity') });
      setIsSubmitting(false);
      return;
    }

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
          setSubmitError('Your session has expired. Please sign in again.');
        } else if (response.status === 409) {
          setSubmitError(data.error || 'This event URL is already taken.');
          if (data.suggestions?.length) setSlugSuggestions(data.suggestions);
        } else {
          setSubmitError(data.error || 'Failed to create event. Please try again.');
        }
        setIsSubmitting(false);
        return;
      }

      clearDraft();
      const eventSlug = data.eventSlug || data.event?.slug;
      // A pending identity is surfaced, with a retry, in Event settings.
      const destination = data.identity?.status === 'pending' ? 'admin/settings?identity=pending#network' : 'admin';
      router.push(eventSlug ? `/e/${eventSlug}/${destination}` : '/');
    } catch (error) {
      console.error('Error creating event:', error);
      setSubmitError('An unexpected error occurred. Please try again.');
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
      case 'basics':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <BasicsStep {...props} />
          </Suspense>
        );
      case 'dates':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <DatesStep {...props} />
          </Suspense>
        );
      case 'venues':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <VenuesStep {...props} />
          </Suspense>
        );
      case 'schedule':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <ScheduleStep {...props} />
          </Suspense>
        );
      case 'tracks':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <TracksStep {...props} />
          </Suspense>
        );
      case 'voting':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <VotingStep {...props} />
          </Suspense>
        );
      case 'branding':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <BrandingStep {...props} />
          </Suspense>
        );
      case 'identity':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <IdentityStep {...props} />
          </Suspense>
        );
      case 'review':
        return (
          <Suspense fallback={<StepLoadingFallback />}>
            <ReviewStep
              state={state}
              dispatch={dispatch}
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
            />
          </Suspense>
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
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">
            {authLoading ? 'Loading...' : 'Redirecting to sign in...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background sticky top-0 z-10 ruler-edge">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-14">
            <Link
              href="/"
              className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to home
            </Link>
            <div className="text-sm text-muted-foreground">
              Draft saved on this device
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="max-w-5xl mx-auto space-y-8">
          {/* Page Title */}
          <div className="space-y-3 max-w-2xl">
            <h1 className="text-4xl sm:text-5xl font-display font-semibold">Make room for your people.</h1>
            <p className="text-muted-foreground">
              Start with the essentials. Add the spaces, topics, and small details that make this gathering yours.
            </p>
          </div>

          {/* Wizard Content */}
          <div className="space-y-6">
            {/* Error Alert */}
            {submitError && (
              <Alert id="create-submit-error" variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="space-y-3">
                  <p>{submitError}</p>
                  {/* Login button for auth errors */}
                  {(submitError.includes('logged in') || submitError.includes('session has expired')) && (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/login?redirect=/create">
                        <LogIn className="h-4 w-4 mr-2" />
                        Sign In
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
                            className="text-xs"
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

            {/* Top Navigation: step tabs + back/next (hidden on review) */}
            <Card>
              <CardContent className="py-4 space-y-4">
                <WizardStepTabs
                  state={state}
                  dispatch={dispatch}
                  onNext={handleNext}
                  onPrev={handlePrev}
                />
                <WizardValidationErrors state={state} />
                <WizardNavButtons
                  state={state}
                  dispatch={dispatch}
                  onNext={handleNext}
                  onPrev={handlePrev}
                  hideOnLastStep
                />
              </CardContent>
            </Card>

            {/* Step Content */}
            <div className="min-h-[400px]">
              {renderStep()}
            </div>

            {/* Keep the next action available after the form. */}
            {state.currentStep < WIZARD_STEPS.length - 1 && (
              <Card className="sticky bottom-3 z-10 shadow-lg">
                <CardContent className="py-4">
                  <WizardNavButtons
                    state={state}
                    dispatch={dispatch}
                    onNext={handleNext}
                    onPrev={handlePrev}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>

      {/* Resume Draft Dialog */}
      {showResumeDialog && (
        <ResumeDraftDialog
          timestamp={getDraftTimestamp()}
          onResume={handleResume}
          onStartFresh={handleStartFresh}
        />
      )}
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
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <CreateWizardContent />
    </Suspense>
  );
}
