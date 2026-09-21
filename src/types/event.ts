// Event status lifecycle
export type EventStatus =
  | 'draft'
  | 'published'
  | 'proposals_open'
  | 'voting_open'
  | 'scheduling'
  | 'live'
  | 'completed'
  | 'archived';

// Event visibility levels
export type EventVisibility = 'public' | 'unlisted' | 'private';

// Voting mechanisms supported for session selection
export type VotingMechanism = 'quadratic' | 'linear' | 'approval';

// Event role hierarchy
export type EventRoleName =
  | 'owner'
  | 'admin'
  | 'moderator'
  | 'track_lead'
  | 'volunteer'
  | 'attendee';

// Event theme configuration
export interface EventTheme {
  colors?: {
    primary?: string;
    primaryForeground?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    foreground?: string;
    muted?: string;
    destructive?: string;
  };
  fonts?: {
    display?: string;
    body?: string;
  };
  mode?: 'dark' | 'light' | 'system';
  borderRadius?: string;
  style?: 'glassmorphism' | 'flat' | 'neumorphism' | 'minimal';
  social?: {
    twitter?: string;
    telegram?: string;
    discord?: string;
    website?: string;
    /** Any other links the organizer lists (Bluesky, Signal, Luma…); label is typed by them. Max 8. */
    links?: { label: string; url: string }[];
  };
  heroTitle?: string;
  heroSubtitle?: string;
  heroCta?: string;
  footerText?: string;
}

// Database event row
export interface EventRow {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  start_date: string;
  end_date: string;
  timezone: string;
  location_name: string | null;
  location_address: string | null;
  location_geo: { x: number; y: number } | null;
  status: EventStatus;
  vote_credits_per_user: number;
  voting_mechanism: VotingMechanism;
  voting_opens_at: string | null;
  voting_closes_at: string | null;
  proposals_open_at: string | null;
  proposals_close_at: string | null;
  allowed_formats: string[];
  allowed_durations: number[];
  max_proposals_per_user: number;
  require_proposal_approval: boolean;
  max_attendees: number | null;
  theme: EventTheme;
  logo_url: string | null;
  banner_url: string | null;
  favicon_url: string | null;
  created_by: string | null;
  is_featured: boolean;
  visibility: EventVisibility;
  schedule_published_at: string | null;
  last_schedule_change_at: string | null;
  ticketing_enabled: boolean;
  stripe_account_id: string | null;
  suggested_topics: string[] | null;
  transcripts_enabled?: boolean;
  transcripts_visibility?: 'members' | 'organizers';
  /** Migration 0023: organizer-chosen map view, app-side only. */
  map?: EventMapView | null;
  /** Migration 0026: attendance voting (design §11), off by default; fresh credits per member. */
  attendance_voting_enabled?: boolean;
  attendance_credits?: number;
  created_at: string;
  updated_at: string;
}

/** `events.map` (spec §8.1). */
export interface EventMapView {
  center: [number, number];
  zoom: number;
  bounds?: [[number, number], [number, number]];
}

// Transformed event for frontend use (camelCase)
export interface Event {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  startDate: Date;
  endDate: Date;
  timezone: string;
  locationName: string | null;
  locationAddress: string | null;
  status: EventStatus;
  voteCreditsPerUser: number;
  votingMechanism: VotingMechanism;
  votingOpensAt: Date | null;
  votingClosesAt: Date | null;
  proposalsOpenAt: Date | null;
  proposalsClosesAt: Date | null;
  allowedFormats: string[];
  allowedDurations: number[];
  maxProposalsPerUser: number;
  requireProposalApproval: boolean;
  maxAttendees: number | null;
  theme: EventTheme;
  logoUrl: string | null;
  bannerUrl: string | null;
  faviconUrl: string | null;
  isFeatured: boolean;
  visibility: EventVisibility;
  schedulePublishedAt: Date | null;
  lastScheduleChangeAt: Date | null;
  ticketingEnabled: boolean;
  stripeAccountId: string | null;
  suggestedTopics: string[];
  transcriptsEnabled?: boolean;
  transcriptsVisibility?: 'members' | 'organizers';
  /** The organizer's chosen map view (spec §8.1), or null when the map area is not set. */
  map: EventMapView | null;
  /** Attendance voting (design §11): opt-in per gathering, with its own fresh credit budget. */
  attendanceVotingEnabled: boolean;
  attendanceCredits: number;
}

// Event member relationship
export interface EventMember {
  id: string;
  eventId: string;
  userId: string;
  role: EventRoleName;
  voteCredits: number | null;
  joinedAt: Date;
}

// Transform database row to frontend type
export function transformEventRow(row: EventRow): Event {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    startDate: new Date(row.start_date),
    endDate: new Date(row.end_date),
    timezone: row.timezone,
    locationName: row.location_name,
    locationAddress: row.location_address,
    status: row.status,
    voteCreditsPerUser: row.vote_credits_per_user,
    // Default to quadratic for rows created before the column existed.
    votingMechanism: (row.voting_mechanism as VotingMechanism) || 'quadratic',
    votingOpensAt: row.voting_opens_at ? new Date(row.voting_opens_at) : null,
    votingClosesAt: row.voting_closes_at ? new Date(row.voting_closes_at) : null,
    proposalsOpenAt: row.proposals_open_at ? new Date(row.proposals_open_at) : null,
    proposalsClosesAt: row.proposals_close_at ? new Date(row.proposals_close_at) : null,
    allowedFormats: row.allowed_formats,
    allowedDurations: row.allowed_durations,
    maxProposalsPerUser: row.max_proposals_per_user,
    requireProposalApproval: row.require_proposal_approval,
    maxAttendees: row.max_attendees,
    theme: row.theme,
    logoUrl: row.logo_url,
    bannerUrl: row.banner_url,
    faviconUrl: row.favicon_url,
    isFeatured: row.is_featured,
    visibility: row.visibility,
    schedulePublishedAt: row.schedule_published_at ? new Date(row.schedule_published_at) : null,
    lastScheduleChangeAt: row.last_schedule_change_at ? new Date(row.last_schedule_change_at) : null,
    ticketingEnabled: row.ticketing_enabled,
    stripeAccountId: row.stripe_account_id,
    map: row.map ?? null,
    attendanceVotingEnabled: row.attendance_voting_enabled ?? false,
    attendanceCredits: row.attendance_credits ?? 100,
    // No hardcoded fallback — topics are organizer-defined.
    // Events created before organizer topics existed may have legacy defaults in the DB.
    suggestedTopics: row.suggested_topics || [],
    transcriptsEnabled: row.transcripts_enabled ?? true,
    transcriptsVisibility: row.transcripts_visibility ?? 'members',
  };
}
