import { validateWizardState } from '@/lib/events/validate-creation';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getUserFromRequest } from '@/lib/api/getUser';
import { suggestAlternativeSlugs } from '@/lib/utils/slug';
import { parseTimeInTimezone } from '@/lib/events/timezone';
import type { WizardState, WizardVenue, WizardTrack, WizardTimeSlot } from '@/app/create/useWizardState';
import type { EventRow, EventTheme } from '@/types/event';

// ============================================================================
// Types
// ============================================================================

interface CreateEventRequest {
  wizardState: WizardState;
}

interface CreateEventResponse {
  success: boolean;
  event?: Partial<EventRow>;
  eventSlug?: string;
  error?: string;
  suggestions?: string[];
}

interface VenueIdMapping {
  [clientId: string]: string; // maps client-side ID to database UUID
}

// ============================================================================
// Validation
// ============================================================================

// ============================================================================
// Data Transformations
// ============================================================================

/**
 * Transform wizard state to events table insert
 */
function transformToEventInsert(
  state: WizardState,
  userId: string
): Omit<EventRow, 'id' | 'created_at' | 'updated_at' | 'location_geo'> & { created_by: string } {
  const deadline = (value: string | null) => {
    if (!value) return null;
    // datetime-local represents the event's clock, not the server's timezone.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      return parseTimeInTimezone(value.slice(11), value.slice(0, 10), state.dates.timezone).toISOString();
    }
    return new Date(value).toISOString();
  };
  // Build theme JSON from branding
  const theme: EventTheme = {
    colors: {
      primary: state.branding.theme.primary,
      secondary: state.branding.theme.secondary,
      accent: state.branding.theme.accent,
    },
    mode: state.branding.theme.mode,
    social: {
      twitter: state.branding.social.twitter || undefined,
      telegram: state.branding.social.telegram || undefined,
      discord: state.branding.social.discord || undefined,
      website: state.branding.social.website || undefined,
    },
  };

  return {
    slug: state.basics.slug,
    name: state.basics.name,
    tagline: state.basics.tagline || null,
    description: state.basics.description || null,

    start_date: state.dates.startDate,
    end_date: state.dates.endDate,
    timezone: state.dates.timezone,
    location_name: state.dates.locationName || null,
    location_address: state.dates.locationAddress || null,

    status: 'draft',

    vote_credits_per_user: state.voting.credits,
    voting_mechanism: state.voting.mechanism,
    voting_opens_at: deadline(state.voting.votingOpensAt),
    voting_closes_at: deadline(state.voting.votingClosesAt),
    proposals_open_at: deadline(state.voting.proposalsOpenAt),
    proposals_close_at: deadline(state.voting.proposalsCloseAt),

    allowed_formats: state.voting.allowedFormats,
    allowed_durations: state.voting.allowedDurations,
    max_proposals_per_user: state.voting.maxProposalsPerUser,
    require_proposal_approval: state.voting.requireProposalApproval,

    max_attendees: null,

    theme,
    logo_url: state.branding.logoUrl || null,
    banner_url: state.branding.bannerUrl || null,
    favicon_url: null,

    created_by: userId,
    is_featured: false,
    visibility: state.basics.visibility,
    schedule_published_at: null,
    last_schedule_change_at: null,
    ticketing_enabled: false,
    stripe_account_id: null,
    // Persist organizer-defined topics. If empty, fall back to null so the
    // column default (or frontend fallback) applies.
    suggested_topics:
      Array.isArray(state.suggestedTopics) && state.suggestedTopics.length > 0
        ? state.suggestedTopics
        : null,
  };
}

/**
 * Transform wizard venues to venues table inserts
 */
function transformVenuesToInsert(
  venues: WizardVenue[],
  eventId: string
): Array<{
  name: string;
  capacity: number | null;
  features: string[];
  address: string | null;
  event_id: string;
  slug: string;
}> {
  return venues.map((venue, index) => ({
    name: venue.name,
    capacity: venue.capacity,
    features: venue.features,
    address: venue.address || null,
    event_id: eventId,
    // Generate a slug from the venue name
    slug: venue.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `venue-${index + 1}`,
  }));
}

/**
 * Transform wizard tracks to tracks table inserts
 */
function transformTracksToInsert(
  tracks: WizardTrack[],
  eventId: string
): Array<{
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  event_id: string;
  display_order: number;
  is_active: boolean;
}> {
  return tracks.map((track, index) => ({
    name: track.name,
    slug: track.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `track-${index + 1}`,
    description: track.description || null,
    color: track.color || null,
    event_id: eventId,
    display_order: index,
    is_active: true,
  }));
}

/**
 * Transform wizard time slots to time_slots table inserts
 */
function transformTimeSlotsToInsert(
  timeSlots: WizardTimeSlot[],
  eventId: string,
  venueIdMapping: VenueIdMapping,
  eventTimezone: string
): Array<{
  start_time: string;
  end_time: string;
  label: string | null;
  is_break: boolean;
  event_id: string;
  venue_id: string | null;
  day_date: string;
  slot_type: string;
}> {
  return timeSlots.map((slot) => {
    // Convert local times in event timezone to proper UTC timestamps
    const startDate = parseTimeInTimezone(slot.startTime, slot.dayDate, eventTimezone);
    const endDate = parseTimeInTimezone(slot.endTime, slot.dayDate, eventTimezone);

    return {
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      label: slot.label || null,
      is_break: slot.isBreak,
      event_id: eventId,
      venue_id: venueIdMapping[slot.venueId] || null,
      day_date: slot.dayDate,
      slot_type: slot.isBreak ? 'break' : 'session',
    };
  });
}

// ============================================================================
// POST /api/events/create
// ============================================================================

export async function POST(request: Request): Promise<NextResponse<CreateEventResponse>> {
  try {
    // 1. Authenticate user
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: CreateEventRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    const wizardState = body?.wizardState;
    if (!wizardState) {
      return NextResponse.json(
        { success: false, error: 'wizardState is required' },
        { status: 400 }
      );
    }

    // 3. Validate wizard state
    const validation = validateWizardState(wizardState);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // 4. Check slug uniqueness
    const supabase = await createAdminClient();
    const { data: existingEvent, error: slugCheckError } = await supabase
      .from('events')
      .select('id')
      .eq('slug', wizardState.basics.slug)
      .maybeSingle();

    if (slugCheckError) {
      console.error('Error checking slug:', slugCheckError);
      return NextResponse.json(
        { success: false, error: 'Failed to check slug availability' },
        { status: 500 }
      );
    }

    if (existingEvent) {
      const suggestions = suggestAlternativeSlugs(wizardState.basics.slug);
      // Verify suggestions are available
      const { data: takenSlugs } = await supabase
        .from('events')
        .select('slug')
        .in('slug', suggestions);

      const takenSet = new Set(takenSlugs?.map(e => e.slug) ?? []);
      const availableSuggestions = suggestions.filter(s => !takenSet.has(s));

      return NextResponse.json(
        {
          success: false,
          error: 'This event URL is already taken',
          suggestions: availableSuggestions.slice(0, 3),
        },
        { status: 409 }
      );
    }

    // Prepare every child before writing. UUIDs preserve room identity without
    // relying on the database returning rows in the same order as the input.
    const eventInsert = transformToEventInsert(wizardState, user.id);
    const venueIdMapping: VenueIdMapping = {};
    const venueInserts = transformVenuesToInsert(wizardState.venues, '').map((venue, index) => {
      const id = crypto.randomUUID();
      venueIdMapping[wizardState.venues[index].id] = id;
      return { ...venue, id, slug: `${venue.slug}-${index + 1}` };
    });
    const trackInserts = transformTracksToInsert(wizardState.tracks, '').map((track, index) => ({
      ...track, slug: `${track.slug}-${index + 1}`,
    }));
    const timeSlotInserts = transformTimeSlotsToInsert(
      wizardState.schedule.timeSlots, '', venueIdMapping, wizardState.dates.timezone
    );
    // event_id is assigned inside the transaction, never trusted from the request.
    const withoutEventId = <T extends { event_id: string }>(row: T) => {
      const { event_id, ...rest } = row;
      return rest;
    };
    const { data: createdEvent, error: createError } = await supabase.rpc('create_event_with_program', {
      p_event: eventInsert,
      p_venues: venueInserts.map(withoutEventId),
      p_tracks: trackInserts.map(withoutEventId),
      p_time_slots: timeSlotInserts.map(withoutEventId),
    });
    if (createError || !createdEvent) {
      console.error('Event creation transaction failed:', createError);
      if (createError?.code === '23505') {
        return NextResponse.json({ success: false, error: 'This event URL was just taken. Choose another URL and try again.', suggestions: suggestAlternativeSlugs(wizardState.basics.slug) }, { status: 409 });
      }
      return NextResponse.json({ success: false, error: 'Your event could not be saved. Nothing was created; your draft is safe. Please try again.' }, { status: 500 });
    }
    return NextResponse.json({ success: true, event: createdEvent, eventSlug: createdEvent.slug });

  } catch (error) {
    console.error('Error in event creation:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// Other Methods
// ============================================================================

export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}
