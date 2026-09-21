'use client';

import { validPlatformFeePercent } from '@/lib/payments/format';
import { useReducer, useCallback } from 'react';
import type { EventVisibility } from '@/types/event';
import { DEFAULT_POLICY_THRESHOLDS, type GatheringPolicyThresholds } from '@/lib/events/policy';

// ============================================================================
// Types
// ============================================================================

// Predefined event types. Organizers may also enter a custom string.
export type EventType = 'unconference' | 'hackathon' | 'conference' | 'meetup' | string;
export type LocationType = 'in-person' | 'virtual' | 'hybrid';
export type VotingMechanism = 'quadratic' | 'linear' | 'approval';
export type ThemeMode = 'dark' | 'light' | 'system';

export interface WizardBasics {
  name: string;
  tagline: string;
  description: string;
  slug: string;
  eventType: EventType;
  visibility: EventVisibility;
  /** Admission and platform contribution are edited in the Participation step; the API field names are unchanged. */
  ticketingEnabled?: boolean;
  platformFeePercent?: number;
}

export interface WizardDates {
  startDate: string; // ISO date
  endDate: string; // ISO date
  timezone: string; // IANA format
  locationName: string;
  locationAddress: string;
  locationType: LocationType;
}

export interface WizardVenue {
  id: string; // client-side id, not DB id
  name: string;
  capacity: number | null;
  features: string[];
  address: string;
}

export interface WizardTimeSlot {
  id: string; // client-side id
  venueId: string; // matches venues[].id
  dayDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  label: string;
  isBreak: boolean;
}

export interface WizardSchedule {
  timeSlots: WizardTimeSlot[];
}

export interface WizardTrack {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface WizardVoting {
  credits: number; // default 100
  mechanism: VotingMechanism;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  proposalsOpenAt: string | null;
  proposalsCloseAt: string | null;
  maxProposalsPerUser: number;
  requireProposalApproval: boolean;
  allowedFormats: string[];
  allowedDurations: number[];
  /** Written into the gathering's public policy record (spec §8). */
  policyThresholds: GatheringPolicyThresholds;
}

export interface WizardIdentity {
  /** The organizer has read that the gathering gets a public identity and permanent public records. */
  acknowledged: boolean;
  /** Terms and privacy policy accepted on the Review step. Never restored from a draft. */
  termsAccepted: boolean;
}

export interface WizardTheme {
  primary: string;
  secondary: string;
  accent: string;
  mode: ThemeMode;
}

export interface WizardSocialLink {
  label: string;
  url: string;
}

/**
 * Storage shape of `theme.social`: the four legacy keys plus `links` for everything else.
 * The UI edits one list (see `socialToList` / `listToSocial` in the settings constants).
 */
export interface WizardSocial {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  links: WizardSocialLink[];
}

export interface WizardBranding {
  logoUrl: string | null;
  bannerUrl: string | null;
  theme: WizardTheme;
  social: WizardSocial;
}

export interface WizardState {
  currentStep: number;
  basics: WizardBasics;
  dates: WizardDates;
  venues: WizardVenue[];
  schedule: WizardSchedule;
  tracks: WizardTrack[];
  // Suggested interest topics presented to attendees on profile setup and
  // session proposals. Organizer-defined so each event can shape its own taxonomy.
  suggestedTopics: string[];
  voting: WizardVoting;
  branding: WizardBranding;
  identity: WizardIdentity;
  validation: Record<string, string[]>; // step -> error messages
}

// ============================================================================
// Actions
// ============================================================================

export type WizardAction =
  | { type: 'SET_STEP'; payload: number }
  | { type: 'NEXT_STEP' }
  | { type: 'PREV_STEP' }
  | { type: 'UPDATE_BASICS'; payload: Partial<WizardBasics> }
  | { type: 'UPDATE_DATES'; payload: Partial<WizardDates> }
  | { type: 'ADD_VENUE'; payload: WizardVenue }
  | { type: 'UPDATE_VENUE'; payload: { id: string; updates: Partial<WizardVenue> } }
  | { type: 'REMOVE_VENUE'; payload: string }
  | { type: 'ADD_TRACK'; payload: WizardTrack }
  | { type: 'UPDATE_TRACK'; payload: { id: string; updates: Partial<WizardTrack> } }
  | { type: 'REMOVE_TRACK'; payload: string }
  | { type: 'SET_SUGGESTED_TOPICS'; payload: string[] }
  | { type: 'ADD_TIME_SLOT'; payload: WizardTimeSlot }
  | { type: 'UPDATE_TIME_SLOT'; payload: { id: string; updates: Partial<WizardTimeSlot> } }
  | { type: 'REMOVE_TIME_SLOT'; payload: string }
  | { type: 'UPDATE_VOTING'; payload: Partial<WizardVoting> }
  | { type: 'UPDATE_BRANDING'; payload: Partial<WizardBranding> }
  | { type: 'UPDATE_IDENTITY'; payload: Partial<WizardIdentity> }
  | { type: 'SET_VALIDATION_ERRORS'; payload: { step: string; errors: string[] } }
  | { type: 'CLEAR_VALIDATION_ERRORS'; payload: string }
  | { type: 'RESET' }
  | { type: 'LOAD_STATE'; payload: Partial<WizardState> };

// ============================================================================
// Constants
// ============================================================================

/**
 * Step order mirrors the organizer settings IA (Network identity → Basics → Dates → … →
 * Participation → Voting → Branding), so what an organizer meets five minutes later is familiar.
 */
export const WIZARD_STEPS = [
  'identity',
  'basics',
  'dates',
  'venues',
  'schedule',
  'tracks',
  'participation',
  'voting',
  'branding',
  'review',
] as const;

export type WizardStepName = (typeof WIZARD_STEPS)[number];

export const STEP_LABELS: Record<WizardStepName, string> = {
  identity: 'Identity',
  basics: 'Basics',
  dates: 'Dates',
  venues: 'Venues',
  schedule: 'Schedule',
  tracks: 'Tracks',
  participation: 'Participation',
  voting: 'Voting',
  branding: 'Branding',
  review: 'Review',
};

export const INITIAL_STATE: WizardState = {
  currentStep: 0,
  basics: {
    name: '',
    tagline: '',
    description: '',
    slug: '',
    eventType: 'unconference',
    visibility: 'public',
    ticketingEnabled: false,
    platformFeePercent: 1,
  },
  dates: {
    startDate: '',
    endDate: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locationName: '',
    locationAddress: '',
    locationType: 'in-person',
  },
  venues: [],
  schedule: {
    timeSlots: [],
  },
  tracks: [],
  // Empty by default so organizers consciously opt into topics for their event.
  // The create API falls back to no topics when this is empty, deferring any defaults.
  suggestedTopics: [],
  voting: {
    credits: 100,
    mechanism: 'quadratic',
    votingOpensAt: null,
    votingClosesAt: null,
    proposalsOpenAt: null,
    proposalsCloseAt: null,
    maxProposalsPerUser: 3,
    requireProposalApproval: false,
    allowedFormats: ['talk', 'workshop', 'panel', 'discussion'],
    allowedDurations: [15, 30, 45, 60],
    policyThresholds: { ...DEFAULT_POLICY_THRESHOLDS },
  },
  branding: {
    logoUrl: null,
    bannerUrl: null,
    theme: {
      primary: '#246653', // spruce
      secondary: '#E8F1EB', // pale mint
      accent: '#DCD5ED', // lilac
      mode: 'light',
    },
    social: {
      twitter: '',
      telegram: '',
      discord: '',
      website: '',
      links: [],
    },
  },
  identity: {
    acknowledged: false,
    termsAccepted: false,
  },
  validation: {},
};

/** Longest slug that can be a gathering subdomain (`src/lib/auth/handles.ts` GATHERING_LABEL_RE). */
export const MAX_SLUG_LENGTH = 32;
/** Longest slug the PDS accepts as the gathering's own handle label; longer slugs get a generated handle. */
export const HANDLE_LABEL_MAX = 18;
const SLUG_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

/** Longest description we accept in the wizard (the column is unbounded; this keeps the review readable). */
export const MAX_DESCRIPTION_LENGTH = 4000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the step name from a step number
 */
export function getStepFromNumber(stepNumber: number): WizardStepName {
  if (stepNumber < 0 || stepNumber >= WIZARD_STEPS.length) {
    return WIZARD_STEPS[0];
  }
  return WIZARD_STEPS[stepNumber];
}

/**
 * Get the step number from a step name
 */
export function getNumberFromStep(stepName: WizardStepName): number {
  const index = WIZARD_STEPS.indexOf(stepName);
  return index >= 0 ? index : 0;
}

/**
 * `validateWizardState` (src/lib/events/validate-creation.ts) reports the failing area using
 * the original step numbering (basics, dates, venues, schedule, tracks, voting, branding).
 * Map that onto the current order so "Edit" lands on the right step.
 */
const VALIDATION_AREA_TO_STEP: WizardStepName[] = ['basics', 'dates', 'venues', 'schedule', 'tracks', 'voting', 'branding'];

export function stepForValidationArea(area: number | undefined, error?: string): number {
  const name = VALIDATION_AREA_TO_STEP[area ?? 0] ?? 'basics';
  if (name === 'basics') {
    // Name and URL now live on the Identity step; admission on Participation.
    if (error && /name|URL|slug/i.test(error)) return getNumberFromStep('identity');
    if (error && /admission|contribution/i.test(error)) return getNumberFromStep('participation');
  }
  if (name === 'voting' && error && /proposal|format|duration/i.test(error)) return getNumberFromStep('participation');
  return getNumberFromStep(name);
}

/**
 * Basic validation for each step
 * Returns true if the step is valid, false otherwise
 */
export function isStepValid(state: WizardState, step: number): boolean {
  return getStepValidationErrors(state, step).length === 0;
}

/**
 * Get validation errors for a specific step
 */
export function getStepValidationErrors(state: WizardState, step: number): string[] {
  const stepName = getStepFromNumber(step);
  const errors: string[] = [];

  switch (stepName) {
    case 'identity':
      if (!state.basics.name.trim()) {
        errors.push('Give the gathering a name');
      }
      if (!state.basics.slug.trim()) {
        errors.push('Choose an event URL');
      } else if (!/^[a-z0-9-]+$/.test(state.basics.slug)) {
        errors.push('The URL can only contain lowercase letters, numbers and hyphens');
      } else if (!SLUG_LABEL_RE.test(state.basics.slug)) {
        errors.push(`Use 3–${MAX_SLUG_LENGTH} characters that start and end with a letter or number`);
      }
      if (!state.identity.acknowledged) {
        errors.push('Confirm you understand what becomes public before continuing');
      }
      break;

    case 'basics':
      if (!state.basics.eventType.trim()) {
        errors.push('Choose or name an event type');
      }
      break;

    case 'dates':
      if (!state.dates.startDate) {
        errors.push('Choose a start date');
      }
      if (!state.dates.endDate) {
        errors.push('Choose an end date');
      }
      if (
        state.dates.startDate &&
        state.dates.endDate &&
        new Date(state.dates.startDate) > new Date(state.dates.endDate)
      ) {
        errors.push('The end date must be on or after the start date');
      }
      if (!state.dates.timezone) {
        errors.push('Choose a timezone');
      }
      break;

    case 'participation':
      if (!validPlatformFeePercent(state.basics.platformFeePercent ?? 1)) {
        errors.push('Choose a platform contribution between 1% and 100%');
      }
      if (state.voting.maxProposalsPerUser < 0) {
        errors.push('The proposal limit cannot be negative');
      }
      if (!Array.isArray(state.voting.allowedFormats) || state.voting.allowedFormats.length === 0) {
        errors.push('Allow at least one session format');
      }
      if (!Array.isArray(state.voting.allowedDurations) || state.voting.allowedDurations.length === 0) {
        errors.push('Allow at least one session length');
      }
      break;

    case 'voting':
      if (!Number.isInteger(state.voting.credits) || state.voting.credits <= 0) {
        errors.push('Vote credits must be a whole number above 0');
      }
      if (!thresholdsValid(state.voting.policyThresholds)) {
        errors.push('Choose valid approval and privacy thresholds');
      }
      break;

    // Venues, schedule, tracks and branding are optional; defaults are fine.
    default:
      break;
  }

  return errors;
}

function thresholdsValid(t: GatheringPolicyThresholds | undefined): boolean {
  return !!t && Number.isInteger(t.destructiveActionStewards) && t.destructiveActionStewards >= 1 && t.destructiveActionStewards <= 5
    && Number.isInteger(t.feedbackK) && t.feedbackK >= 2 && t.feedbackK <= 10 && typeof t.publishRoles === 'boolean';
}

// ============================================================================
// Reducer
// ============================================================================

function mergeState(base: WizardState, partial: Partial<WizardState> | undefined, options: { restoreIdentity: boolean }): WizardState {
  const p = partial ?? {};
  return {
    ...base,
    ...p,
    basics: { ...base.basics, ...p.basics },
    dates: { ...base.dates, ...p.dates },
    venues: Array.isArray(p.venues) ? p.venues : base.venues,
    tracks: Array.isArray(p.tracks) ? p.tracks : base.tracks,
    schedule: { ...base.schedule, ...p.schedule },
    suggestedTopics: Array.isArray(p.suggestedTopics) ? p.suggestedTopics : base.suggestedTopics,
    voting: {
      ...base.voting,
      ...p.voting,
      policyThresholds: { ...base.voting.policyThresholds, ...p.voting?.policyThresholds },
    },
    identity: options.restoreIdentity
      ? { ...base.identity, ...p.identity, termsAccepted: false }
      : { ...base.identity },
    branding: {
      ...base.branding,
      ...p.branding,
      theme: { ...base.branding.theme, ...p.branding?.theme },
      social: {
        ...base.branding.social,
        ...p.branding?.social,
        links: Array.isArray(p.branding?.social?.links) ? p.branding!.social!.links : base.branding.social.links,
      },
    },
    validation: {},
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_STEP':
      return {
        ...state,
        currentStep: Math.max(0, Math.min(action.payload, WIZARD_STEPS.length - 1)),
      };

    case 'NEXT_STEP': {
      // Validate current step before allowing forward navigation
      const errors = getStepValidationErrors(state, state.currentStep);
      if (errors.length > 0) {
        const stepName = getStepFromNumber(state.currentStep);
        return {
          ...state,
          validation: {
            ...state.validation,
            [stepName]: errors,
          },
        };
      }
      // Clear validation errors for current step and move forward
      const currentStepName = getStepFromNumber(state.currentStep);
      const newValidation = { ...state.validation };
      delete newValidation[currentStepName];
      return {
        ...state,
        currentStep: Math.min(state.currentStep + 1, WIZARD_STEPS.length - 1),
        validation: newValidation,
      };
    }

    case 'PREV_STEP':
      return {
        ...state,
        currentStep: Math.max(state.currentStep - 1, 0),
      };

    case 'UPDATE_BASICS':
      return {
        ...state,
        basics: {
          ...state.basics,
          ...action.payload,
        },
      };

    case 'UPDATE_DATES':
      return {
        ...state,
        dates: {
          ...state.dates,
          ...action.payload,
        },
      };

    case 'ADD_VENUE':
      return {
        ...state,
        venues: [...state.venues, action.payload],
      };

    case 'UPDATE_VENUE':
      return {
        ...state,
        venues: state.venues.map((venue) =>
          venue.id === action.payload.id
            ? { ...venue, ...action.payload.updates }
            : venue
        ),
      };

    case 'REMOVE_VENUE': {
      const venueId = action.payload;
      return {
        ...state,
        venues: state.venues.filter((venue) => venue.id !== venueId),
        // Also remove time slots that reference this venue
        schedule: {
          ...state.schedule,
          timeSlots: state.schedule.timeSlots.filter(
            (slot) => slot.venueId !== venueId
          ),
        },
      };
    }

    case 'ADD_TRACK':
      return {
        ...state,
        tracks: [...state.tracks, action.payload],
      };

    case 'UPDATE_TRACK':
      return {
        ...state,
        tracks: state.tracks.map((track) =>
          track.id === action.payload.id
            ? { ...track, ...action.payload.updates }
            : track
        ),
      };

    case 'REMOVE_TRACK':
      return {
        ...state,
        tracks: state.tracks.filter((track) => track.id !== action.payload),
      };

    case 'SET_SUGGESTED_TOPICS':
      return {
        ...state,
        suggestedTopics: action.payload,
      };

    case 'ADD_TIME_SLOT':
      return {
        ...state,
        schedule: {
          ...state.schedule,
          timeSlots: [...state.schedule.timeSlots, action.payload],
        },
      };

    case 'UPDATE_TIME_SLOT':
      return {
        ...state,
        schedule: {
          ...state.schedule,
          timeSlots: state.schedule.timeSlots.map((slot) =>
            slot.id === action.payload.id
              ? { ...slot, ...action.payload.updates }
              : slot
          ),
        },
      };

    case 'REMOVE_TIME_SLOT':
      return {
        ...state,
        schedule: {
          ...state.schedule,
          timeSlots: state.schedule.timeSlots.filter(
            (slot) => slot.id !== action.payload
          ),
        },
      };

    case 'UPDATE_VOTING':
      return {
        ...state,
        voting: {
          ...state.voting,
          ...action.payload,
        },
      };

    case 'UPDATE_BRANDING': {
      // Handle nested updates for theme and social
      const newBranding = { ...state.branding };

      if (action.payload.theme) {
        newBranding.theme = {
          ...state.branding.theme,
          ...action.payload.theme,
        };
      }

      if (action.payload.social) {
        newBranding.social = {
          ...state.branding.social,
          ...action.payload.social,
        };
      }

      if (action.payload.logoUrl !== undefined) {
        newBranding.logoUrl = action.payload.logoUrl;
      }

      if (action.payload.bannerUrl !== undefined) {
        newBranding.bannerUrl = action.payload.bannerUrl;
      }

      return {
        ...state,
        branding: newBranding,
      };
    }

    case 'UPDATE_IDENTITY':
      return {
        ...state,
        identity: {
          ...state.identity,
          ...action.payload,
        },
      };

    case 'SET_VALIDATION_ERRORS':
      return {
        ...state,
        validation: {
          ...state.validation,
          [action.payload.step]: action.payload.errors,
        },
      };

    case 'CLEAR_VALIDATION_ERRORS': {
      const newValidation = { ...state.validation };
      delete newValidation[action.payload];
      return {
        ...state,
        validation: newValidation,
      };
    }

    case 'RESET':
      return INITIAL_STATE;

    case 'LOAD_STATE':
      // The identity acknowledgement is the first step, so a resumed draft keeps it; the terms
      // acceptance is given right before creating and is never restored.
      return mergeState(INITIAL_STATE, action.payload, { restoreIdentity: true });

    default:
      return state;
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useWizardState(initialState?: Partial<WizardState>) {
  const [state, dispatch] = useReducer(
    wizardReducer,
    initialState ? mergeState(INITIAL_STATE, initialState, { restoreIdentity: true }) : INITIAL_STATE
  );

  // Convenience methods
  const goToStep = useCallback((step: number) => {
    dispatch({ type: 'SET_STEP', payload: step });
  }, []);

  const nextStep = useCallback(() => {
    dispatch({ type: 'NEXT_STEP' });
  }, []);

  const prevStep = useCallback(() => {
    dispatch({ type: 'PREV_STEP' });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const loadState = useCallback((newState: Partial<WizardState>) => {
    dispatch({ type: 'LOAD_STATE', payload: newState });
  }, []);

  return {
    state,
    dispatch,
    // Convenience methods
    goToStep,
    nextStep,
    prevStep,
    reset,
    loadState,
    // Computed values
    currentStepName: getStepFromNumber(state.currentStep),
    isFirstStep: state.currentStep === 0,
    isLastStep: state.currentStep === WIZARD_STEPS.length - 1,
    isCurrentStepValid: isStepValid(state, state.currentStep),
    currentStepErrors: state.validation[getStepFromNumber(state.currentStep)] || [],
  };
}

// Re-export visibility type for convenience
export type { EventVisibility };
