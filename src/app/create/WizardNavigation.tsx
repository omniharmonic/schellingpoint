'use client';

import * as React from 'react';
import { Check, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  WIZARD_STEPS,
  STEP_LABELS,
  isStepValid,
  getStepValidationErrors,
  getStepFromNumber,
  type WizardState,
  type WizardAction,
} from './useWizardState';

interface WizardCommonProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

/**
 * Determines the status of a step based on current state
 */
function getStepStatus(
  stepIndex: number,
  currentStep: number,
  state: WizardState
): 'completed' | 'current' | 'upcoming' | 'error' {
  if (stepIndex === currentStep) {
    const stepName = getStepFromNumber(stepIndex);
    if (state.validation[stepName] && state.validation[stepName].length > 0) {
      return 'error';
    }
    return 'current';
  }
  if (stepIndex < currentStep) {
    if (isStepValid(state, stepIndex)) {
      return 'completed';
    }
    return 'error';
  }
  return 'upcoming';
}

/**
 * Highest step the user can navigate to (all previous steps must be valid).
 */
export function getMaxNavigableStep(state: WizardState): number {
  for (let i = 0; i < WIZARD_STEPS.length; i++) {
    if (!isStepValid(state, i)) {
      return i;
    }
  }
  return WIZARD_STEPS.length - 1;
}

// ============================================================================
// Step Tabs (tab-styled step indicator, meant for the top of the wizard)
// ============================================================================

export function WizardStepTabs({ state, dispatch }: WizardCommonProps) {
  const { currentStep } = state;
  const currentStepName = getStepFromNumber(currentStep);
  const maxNavigable = getMaxNavigableStep(state);

  const handleStepClick = React.useCallback(
    (stepIndex: number) => {
      if (stepIndex <= maxNavigable && stepIndex !== currentStep) {
        dispatch({ type: 'SET_STEP', payload: stepIndex });
      }
    },
    [maxNavigable, currentStep, dispatch]
  );

  return (
    <nav aria-label="Wizard steps" className="w-full">
      {/* Desktop tabs */}
      <div className="hidden md:block">
        <div
          role="tablist"
          className="flex items-stretch justify-between gap-1 border-b border-border overflow-x-auto"
        >
          {WIZARD_STEPS.map((stepName, index) => {
            const status = getStepStatus(index, currentStep, state);
            const isClickable = index <= maxNavigable && index !== currentStep;

            return (
              <button
                key={stepName}
                role="tab"
                type="button"
                aria-selected={status === 'current'}
                onClick={() => handleStepClick(index)}
                disabled={!isClickable}
                className={cn(
                  'relative flex items-center gap-1.5 px-2.5 py-3 text-sm font-medium whitespace-nowrap transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-t-md',
                  status === 'current' && 'text-foreground',
                  status === 'completed' && 'text-muted-foreground hover:text-foreground',
                  status === 'upcoming' && 'text-muted-foreground/60 cursor-default',
                  status === 'error' && 'text-destructive',
                  isClickable && 'cursor-pointer hover:bg-accent/40'
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold',
                    status === 'completed' && 'border-primary bg-primary text-primary-foreground',
                    status === 'current' && 'border-primary bg-primary/10 text-primary',
                    status === 'upcoming' && 'border-muted-foreground/30 bg-background text-muted-foreground',
                    status === 'error' && 'border-destructive bg-destructive/10 text-destructive'
                  )}
                >
                  {status === 'completed' ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : status === 'error' ? (
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                {STEP_LABELS[stepName]}

                {/* Active indicator bar */}
                {status === 'current' && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 bg-primary rounded-full" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mobile compact indicator */}
      <div className="md:hidden space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Step {currentStep + 1} of {WIZARD_STEPS.length}
          </span>
          <span className="text-sm font-medium">
            {STEP_LABELS[currentStepName]}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {WIZARD_STEPS.map((stepName, index) => {
            const status = getStepStatus(index, currentStep, state);
            const isClickable = index <= maxNavigable && index !== currentStep;
            return (
              <button
                key={stepName}
                type="button"
                onClick={() => handleStepClick(index)}
                disabled={!isClickable}
                className={cn(
                  'h-1.5 rounded-full transition-all flex-1',
                  status === 'current' && 'bg-primary',
                  status === 'completed' && 'bg-primary/60',
                  status === 'upcoming' && 'bg-muted',
                  status === 'error' && 'bg-destructive',
                  isClickable && 'cursor-pointer'
                )}
                aria-label={`Go to step ${index + 1}: ${STEP_LABELS[stepName]}`}
              />
            );
          })}
        </div>
      </div>
    </nav>
  );
}

// ============================================================================
// Validation error summary
// ============================================================================

export function WizardValidationErrors({ state }: { state: WizardState }) {
  const currentStepName = getStepFromNumber(state.currentStep);
  const errors = state.validation[currentStepName] || [];
  if (errors.length === 0) return null;

  return (
    <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 p-3">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">
            Fix these before continuing:
          </p>
          <ul className="text-sm text-destructive/90 list-disc list-inside space-y-1">
            {errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Back/Next buttons
// ============================================================================

/**
 * The one sticky navigation bar. Back is offered on every step but the first (including
 * Review); Continue is hidden on Review, where the create button lives in the step itself.
 * The primary button keeps a fixed label so it does not change width every step; the next
 * step's name is exposed to assistive tech and as a hint.
 */
export function WizardNavButtons({ state, dispatch }: WizardCommonProps) {
  const { currentStep } = state;
  const currentStepName = getStepFromNumber(currentStep);
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === WIZARD_STEPS.length - 1;
  const nextStepName = isLastStep ? null : WIZARD_STEPS[currentStep + 1];

  const handleNext = React.useCallback(() => {
    const errors = getStepValidationErrors(state, currentStep);
    if (errors.length > 0) {
      dispatch({
        type: 'SET_VALIDATION_ERRORS',
        payload: { step: currentStepName, errors },
      });
      return;
    }
    dispatch({ type: 'NEXT_STEP' });
  }, [state, currentStep, currentStepName, dispatch]);

  const handlePrev = React.useCallback(() => {
    dispatch({ type: 'PREV_STEP' });
  }, [dispatch]);

  return (
    <div className="flex items-center justify-between gap-3">
      {!isFirstStep ? (
        <Button type="button" variant="outline" onClick={handlePrev} className="gap-2">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      {nextStepName && (
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden sm:inline text-sm text-muted-foreground">Next: {STEP_LABELS[nextStepName]}</span>
          <Button
            type="button"
            onClick={handleNext}
            className="gap-2"
            aria-label={`Continue to ${STEP_LABELS[nextStepName]}`}
          >
            Continue
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
