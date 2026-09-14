import { createClient, createAdminClient, getAccessUser } from '@/lib/supabase/server';
import type { Event, EventRow, EventMember } from '@/types/event';
import { transformEventRow } from '@/types/event';

// Re-export date and timezone utilities
export * from './dates';
export * from './timezone';
export * from './lifecycle';
export * from './templates';

/** Event records are authorized before they enter a server component payload. */
export async function getEventBySlug(slug: string): Promise<Event | null> {
  const supabase = await createAdminClient();

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) {
    console.error('[getEventBySlug] Error fetching event:', error.message, { slug });
    return null;
  }

  if (!data) {
    console.warn('[getEventBySlug] No event found for slug:', slug);
    return null;
  }

  if (!(await canReadEvent(data))) return null;
  return transformEventRow(data as EventRow);
}

/**
 * Get event by ID (server-side)
 */
export async function getEventById(id: string): Promise<Event | null> {
  const supabase = await createAdminClient();

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('[getEventById] Error fetching event:', error.message, { id });
    return null;
  }

  if (!data) {
    return null;
  }

  if (!(await canReadEvent(data))) return null;
  return transformEventRow(data as EventRow);
}

/**
 * Get user's membership for an event
 */
export async function getEventMembership(
  eventId: string,
  userId: string
): Promise<EventMember | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('event_members')
    .select('*')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    id: data.id,
    eventId: data.event_id,
    userId: data.user_id,
    role: data.role,
    voteCredits: data.vote_credits,
    joinedAt: new Date(data.joined_at),
  };
}

/**
 * Get all public/unlisted events (for discovery)
 */
export async function getPublicEvents(): Promise<Event[]> {
  const supabase = await createAdminClient();

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('visibility', 'public')
    .neq('status', 'draft')
    .order('start_date', { ascending: false });

  if (error) {
    console.error('[getPublicEvents] Error fetching events:', error.message);
    return [];
  }

  if (!data) {
    return [];
  }

  return data.map((row) => transformEventRow(row as EventRow));
}

async function canReadEvent(event: EventRow): Promise<boolean> {
  if (event.visibility !== 'private' && event.status !== 'draft') return true;
  // getUser verifies the access token; cookie claims alone never authorize access.
  const user = await getAccessUser();
  if (!user) return false;
  const db = await createAdminClient();
  const { data: membership } = await db.from('event_members').select('role')
    .eq('event_id', event.id).eq('user_id', user.id).maybeSingle();
  return Boolean(membership && (event.status !== 'draft' || ['owner', 'admin'].includes(membership.role)));
}
