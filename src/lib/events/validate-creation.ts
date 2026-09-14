import { parseTimeInTimezone } from './timezone';
import type { WizardState } from '@/app/create/useWizardState';
import { isValidSlugFormat } from '@/lib/utils/slug';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const date = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

/** Validate the untrusted API payload before any database writes. Also used by review. */
export function validateWizardState(input: unknown): { valid: boolean; error?: string; step?: number } {
  const fail = (error: string, step = 0) => ({ valid: false, error, step });
  if (!record(input) || !record(input.basics) || !record(input.dates) || !record(input.voting) || !record(input.branding) || !record(input.branding.theme) || !record(input.branding.social) || !record(input.schedule) || !Array.isArray(input.schedule.timeSlots) || !Array.isArray(input.venues) || !Array.isArray(input.tracks)) return fail('Your draft is incomplete. Please review the event details.');
  const state = input as unknown as WizardState;
  if (!text(state.basics.name) || !state.basics.name.trim()) return fail('Event name is required');
  if (!text(state.basics.slug)) return fail('Event URL is required');
  const slug = isValidSlugFormat(state.basics.slug);
  if (!slug.valid) return fail(slug.error || 'Choose a valid event URL');
  if (!['public', 'private', 'unlisted'].includes(state.basics.visibility)) return fail('Choose an event visibility');
  if (!date(state.dates.startDate) || !date(state.dates.endDate)) return fail('Choose valid start and end dates', 1);
  if (state.dates.endDate < state.dates.startDate) return fail('End date must be on or after the start date', 1);
  try { if (!text(state.dates.timezone) || !state.dates.timezone) throw Error(); new Intl.DateTimeFormat('en', { timeZone: state.dates.timezone }); } catch { return fail('Choose a valid timezone', 1); }
  const roomIds = new Set<string>();
  for (const room of state.venues) {
    if (!record(room) || !text(room.id) || !room.id || roomIds.has(room.id) || !text(room.name) || !room.name.trim() || !strings(room.features) || (room.capacity !== null && (!Number.isInteger(room.capacity) || room.capacity <= 0))) return fail('Each room needs a name and a positive whole-number capacity (or no capacity)', 2);
    roomIds.add(room.id);
  }
  const slots = state.schedule.timeSlots;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!record(slot) || !roomIds.has(slot.venueId)) return fail('A schedule slot refers to a removed room. Assign it to an available room.', 3);
    if (!date(slot.dayDate) || slot.dayDate < state.dates.startDate || slot.dayDate > state.dates.endDate) return fail('All schedule slots must fall within your event dates', 3);
    if (![slot.startTime, slot.endTime].every(t => text(t) && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || slot.endTime <= slot.startTime) return fail('Each schedule slot must end after it starts on the same day', 3);
    try {
      parseTimeInTimezone(slot.startTime, slot.dayDate, state.dates.timezone);
      parseTimeInTimezone(slot.endTime, slot.dayDate, state.dates.timezone);
    } catch { return fail('A schedule time does not exist because of a clock change. Choose another time.', 3); }
    if (slots.slice(0, i).some(other => other.venueId === slot.venueId && other.dayDate === slot.dayDate && other.startTime < slot.endTime && slot.startTime < other.endTime)) return fail('Schedule slots overlap in the same room. Adjust their times before continuing.', 3);
  }
  if (state.tracks.some(track => !record(track) || !text(track.name) || !track.name.trim())) return fail('Each track needs a name', 4);
  if (state.suggestedTopics !== undefined && !strings(state.suggestedTopics)) return fail('Topics must be a list of names', 4);
  const voting = state.voting;
  if (!Number.isInteger(voting.credits) || voting.credits <= 0 || voting.credits > 2147483647) return fail('Vote credits must be a positive whole number', 5);
  if (!Number.isInteger(voting.maxProposalsPerUser) || voting.maxProposalsPerUser < 0) return fail('Proposal limit must be a whole number; use 0 for unlimited', 5);
  if (!['quadratic', 'linear', 'approval'].includes(voting.mechanism)) return fail('Choose a voting method', 5);
  if (!strings(voting.allowedFormats) || !voting.allowedFormats.length || voting.allowedFormats.some(f => !['talk','workshop','panel','discussion','demo','fireside','ceremony'].includes(f))) return fail('Choose at least one supported session format', 5);
  if (!Array.isArray(voting.allowedDurations) || !voting.allowedDurations.length || voting.allowedDurations.some(d => !Number.isInteger(d) || d <= 0)) return fail('Choose positive whole-number session durations', 5);
  for (const [opens, closes] of [[voting.votingOpensAt, voting.votingClosesAt], [voting.proposalsOpenAt, voting.proposalsCloseAt]]) {
    if ([opens, closes].some(t => t !== null && t !== '' && (!text(t) || !Number.isFinite(Date.parse(t))))) return fail('Choose valid proposal and voting deadlines', 5);
    try {
      for (const value of [opens, closes]) if (value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) parseTimeInTimezone(value.slice(11), value.slice(0,10), state.dates.timezone);
    } catch { return fail('A deadline falls in a clock change. Choose another time.', 5); }
    if (opens && closes && Date.parse(closes) <= Date.parse(opens)) return fail('Each closing deadline must follow its opening time', 5);
  }
  const theme = state.branding.theme;
  if (![theme.primary,theme.secondary,theme.accent].every(c => text(c) && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(c)) || !['light','dark','system'].includes(theme.mode)) return fail('Choose valid theme colors and appearance', 6);
  return { valid: true };
}
