'use client';

import * as React from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { apiFetch, ApiError } from '@/lib/api/client';
import type { GatheringPolicyThresholds } from '@/lib/events/policy';
import type { Event, EventRoleName } from '@/types/event';
import { canRolePerform, isAdminRole, type Permission } from '@/lib/permissions';
import { hexToHslValues, isValidHexColor, getContrastingForeground, accessiblePrimary } from '@/lib/utils/color';

// Event context value
interface EventContextValue {
  event: Event;
  network: EventNetwork | null;
  /** The viewer can read at least one ready transcript: the sidebar offers "Ask" (design §10.2). */
  hasKnowledge: boolean;
}

/**
 * The gathering's public identity on the network (handle, DID, published records).
 * `null` for visitors before the gathering is published; organizers always get it.
 */
export interface EventNetwork {
  did: string | null;
  handle: string | null;
  gatheringUri: string | null;
  policyUri: string | null;
  publishedAt: string | null;
  thresholds: GatheringPolicyThresholds;
}

// Event role context value
interface EventRoleContextValue {
  role: EventRoleName | null;
  voteCredits: number;
  isLoading: boolean;
  can: (permission: Permission) => boolean;
  isAdmin: boolean;
  isOwner: boolean;
  isMember: boolean;
  /** Re-read the viewer's role from the server (after invitations, role changes). */
  refreshRole: () => Promise<void>;
  /**
   * Whether the signed-in viewer may join by asking (public/unlisted, not archived, no paid
   * ticket). `null` while unknown or signed out. Members are never `joinable`.
   */
  joinable: boolean | null;
  /** Why joining is not offered: a ticket is required, the gathering is archived, … */
  joinBlockedBy: JoinBlockReason | null;
  /**
   * Explicitly join as an attendee (spec §5.5). Membership is never created by viewing a
   * page; call this from a deliberate "Join" action. Resolves with the outcome; never throws.
   */
  join: (opts?: { acceptConduct?: boolean }) => Promise<JoinResult>;
  isJoining: boolean;
  /**
   * Leave this gathering (spec §8). Membership goes, RSVPs are cancelled, pending co-host
   * invites they sent are revoked; their proposals stay, because those are their own records.
   * `null` outcome reasons are written for the person. Never throws.
   */
  leave: () => Promise<LeaveResult>;
  isLeaving: boolean;
  /** False for the last owner: they must hand the gathering over first. `null` while unknown. */
  canLeave: boolean | null;
  /** The gathering's own code of conduct, and whether joining requires accepting it. */
  codeOfConductUrl: string | null;
  conductAcceptanceRequired: boolean;
  conductAcceptedAt: string | null;
}

export type JoinBlockReason = 'hidden' | 'archived' | 'ticket-required';

export type JoinResult =
  | { ok: true; role: EventRoleName }
  | { ok: false; reason: 'signed-out' | 'ticket-required' | 'not-joinable' | 'conduct-required' | 'error'; message: string; ticketsUrl?: string; codeOfConductUrl?: string | null };

export type LeaveResult =
  | { ok: true }
  | { ok: false; reason: 'last-owner' | 'not-a-member' | 'error'; message: string };

const EventContext = React.createContext<EventContextValue | null>(null);
const EventRoleContext = React.createContext<EventRoleContextValue | null>(null);

interface MeResponse {
  role: EventRoleName | null;
  member: boolean;
  voteCredits: number | null;
  joinable?: boolean;
  joinBlockedBy?: JoinBlockReason | null;
  codeOfConductUrl?: string | null;
  conductAcceptanceRequired?: boolean;
  conductAcceptedAt?: string | null;
  canLeave?: boolean;
}

interface EventProviderProps {
  event: Event;
  /** The account the server rendered for (from the session cookie), or null. */
  viewerId: string | null;
  initialRole: EventRoleName | null;
  initialVoteCredits: number | null;
  network: EventNetwork | null;
  hasKnowledge?: boolean;
  children: React.ReactNode;
}

export function EventProvider({ event, viewerId, initialRole, initialVoteCredits, network, hasKnowledge = false, children }: EventProviderProps) {
  const { user, isLoading: authLoading } = useAuth();
  const [role, setRole] = React.useState<EventRoleName | null>(initialRole);
  const [voteCredits, setVoteCredits] = React.useState<number>(initialVoteCredits ?? event.voteCreditsPerUser);
  const [isLoading, setIsLoading] = React.useState(false);
  const [joinable, setJoinable] = React.useState<boolean | null>(null);
  const [joinBlockedBy, setJoinBlockedBy] = React.useState<JoinBlockReason | null>(null);
  const [isJoining, setIsJoining] = React.useState(false);
  const [isLeaving, setIsLeaving] = React.useState(false);
  const [canLeave, setCanLeave] = React.useState<boolean | null>(null);
  const [conductAcceptedAt, setConductAcceptedAt] = React.useState<string | null>(null);
  const [conductRequired, setConductRequired] = React.useState(event.requireConductAcceptance);
  const router = useRouter();

  // Server props are authoritative for the account they were rendered for.
  React.useEffect(() => {
    setRole(initialRole);
    setVoteCredits(initialVoteCredits ?? event.voteCreditsPerUser);
  }, [initialRole, initialVoteCredits, event.voteCreditsPerUser]);

  const apply = React.useCallback((me: MeResponse) => {
    setRole(me.role);
    setVoteCredits(me.voteCredits ?? event.voteCreditsPerUser);
    setJoinable(me.member ? false : me.joinable ?? null);
    setJoinBlockedBy(me.member ? null : me.joinBlockedBy ?? null);
    setCanLeave(me.member ? me.canLeave ?? null : false);
    setConductAcceptedAt(me.conductAcceptedAt ?? null);
    if (typeof me.conductAcceptanceRequired === 'boolean') setConductRequired(me.conductAcceptanceRequired);
  }, [event.voteCreditsPerUser]);

  const mePath = `/api/v1/events/${encodeURIComponent(event.slug)}/me`;

  /** Read-only: GET never creates membership. */
  const refreshRole = React.useCallback(async () => {
    try {
      apply(await apiFetch<MeResponse>(mePath, { cache: 'no-store' }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { setRole(null); setJoinable(false); return; }
      console.error('Error fetching event membership:', err);
    }
  }, [apply, mePath]);

  // Keep role and joinability in step with who is signed in. Never joins.
  React.useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    const currentUserId = user?.id ?? null;
    if (!currentUserId) {
      setRole(null); setVoteCredits(event.voteCreditsPerUser); setJoinable(null); setJoinBlockedBy(null);
      return;
    }
    const changedAccount = currentUserId !== viewerId;
    if (changedAccount) setIsLoading(true);
    void refreshRole().finally(() => { if (!cancelled && changedAccount) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [authLoading, user?.id, viewerId, event.voteCreditsPerUser, refreshRole]);

  const join = React.useCallback(async (opts: { acceptConduct?: boolean } = {}): Promise<JoinResult> => {
    if (!user) return { ok: false, reason: 'signed-out', message: 'Sign in to join this gathering.' };
    setIsJoining(true);
    try {
      const me = await apiFetch<MeResponse>(mePath, { method: 'POST', json: { acceptConduct: opts.acceptConduct === true } });
      apply(me);
      // Server-rendered, member-only parts of the page catch up with the new role.
      router.refresh();
      return me.role ? { ok: true, role: me.role } : { ok: false, reason: 'error', message: 'Could not join this gathering.' };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) return { ok: false, reason: 'signed-out', message: 'Sign in to join this gathering.' };
        if (err.code === 'ConductAcceptanceRequired') {
          setConductRequired(true);
          return { ok: false, reason: 'conduct-required', message: err.message, codeOfConductUrl: event.codeOfConductUrl };
        }
        if (err.code === 'TicketRequired') {
          setJoinable(false); setJoinBlockedBy('ticket-required');
          return { ok: false, reason: 'ticket-required', message: err.message, ticketsUrl: `/e/${event.slug}/tickets` };
        }
        if (err.status === 404 || err.status === 409 || err.status === 403) {
          setJoinable(false);
          return { ok: false, reason: 'not-joinable', message: err.message };
        }
        return { ok: false, reason: 'error', message: err.message };
      }
      return { ok: false, reason: 'error', message: 'Could not reach the server. Try again.' };
    } finally {
      setIsJoining(false);
    }
  }, [user, mePath, apply, router, event.slug, event.codeOfConductUrl]);

  const leave = React.useCallback(async (): Promise<LeaveResult> => {
    setIsLeaving(true);
    try {
      await apiFetch<{ left: boolean }>(mePath, { method: 'DELETE' });
      setRole(null);
      setVoteCredits(event.voteCreditsPerUser);
      setJoinable(null);
      setJoinBlockedBy(null);
      setCanLeave(false);
      setConductAcceptedAt(null);
      void refreshRole();
      router.refresh();
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'LastOwner') return { ok: false, reason: 'last-owner', message: err.message };
        if (err.status === 404) return { ok: false, reason: 'not-a-member', message: err.message };
        return { ok: false, reason: 'error', message: err.message };
      }
      return { ok: false, reason: 'error', message: 'Could not reach the server. Try again.' };
    } finally {
      setIsLeaving(false);
    }
  }, [mePath, event.voteCreditsPerUser, refreshRole, router]);

  // Apply event theme colors as CSS custom properties
  React.useEffect(() => {
    const root = document.documentElement;
    const theme = event.theme;
    const appliedProperties: string[] = [];
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const previousMode = root.classList.contains('dark') ? 'dark' : 'light';
    const applyMode = () => {
      const dark = theme?.mode === 'dark' || (theme?.mode === 'system' && media.matches);
      root.classList.toggle('dark', dark);
      root.classList.toggle('light', !dark);
      if (theme?.colors?.primary && isValidHexColor(theme.colors.primary)) {
        const color = accessiblePrimary(theme.colors.primary, dark);
        for (const property of ['--primary', '--signal', '--ring']) root.style.setProperty(property, hexToHslValues(color));
        root.style.setProperty('--primary-foreground', getContrastingForeground(color));
      }
    };

    // Apply primary color
    if (theme?.colors?.primary && isValidHexColor(theme.colors.primary)) {
      const primaryHsl = hexToHslValues(theme.colors.primary);
      root.style.setProperty('--primary', primaryHsl);
      appliedProperties.push('--primary', '--signal', '--ring');
      root.style.setProperty('--signal', primaryHsl);
      root.style.setProperty('--ring', primaryHsl);

      // Auto-calculate primary foreground for contrast
      const primaryForeground = getContrastingForeground(theme.colors.primary);
      root.style.setProperty('--primary-foreground', primaryForeground);
      appliedProperties.push('--primary-foreground');
    }

    // Apply secondary color
    if (theme?.colors?.secondary && isValidHexColor(theme.colors.secondary)) {
      const secondaryHsl = hexToHslValues(theme.colors.secondary);
      root.style.setProperty('--secondary', secondaryHsl);
      appliedProperties.push('--secondary');

      const secondaryForeground = getContrastingForeground(theme.colors.secondary);
      root.style.setProperty('--secondary-foreground', secondaryForeground);
      appliedProperties.push('--secondary-foreground');
    }

    // Apply accent color
    if (theme?.colors?.accent && isValidHexColor(theme.colors.accent)) {
      const accentHsl = hexToHslValues(theme.colors.accent);
      root.style.setProperty('--accent', accentHsl);
      appliedProperties.push('--accent');

      const accentForeground = getContrastingForeground(theme.colors.accent);
      root.style.setProperty('--accent-foreground', accentForeground);
      appliedProperties.push('--accent-foreground');
    }

    applyMode();
    media.addEventListener('change', applyMode);

    // Cleanup: remove applied properties when leaving event pages
    return () => {
      media.removeEventListener('change', applyMode);
      root.classList.toggle('dark', previousMode === 'dark');
      root.classList.toggle('light', previousMode === 'light');
      appliedProperties.forEach((prop) => {
        root.style.removeProperty(prop);
      });
    };
  }, [event.theme]);

  const roleValue = React.useMemo<EventRoleContextValue>(
    () => ({
      role,
      voteCredits,
      isLoading,
      can: (permission: Permission) => (role ? canRolePerform(role, permission) : false),
      isAdmin: role ? isAdminRole(role) : false,
      isOwner: role === 'owner',
      isMember: role !== null,
      refreshRole,
      joinable: role !== null ? false : joinable,
      joinBlockedBy: role !== null ? null : joinBlockedBy,
      join,
      isJoining,
      leave,
      isLeaving,
      canLeave: role !== null ? canLeave : false,
      codeOfConductUrl: event.codeOfConductUrl,
      conductAcceptanceRequired: conductRequired,
      conductAcceptedAt,
    }),
    [role, voteCredits, isLoading, refreshRole, joinable, joinBlockedBy, join, isJoining, leave, isLeaving, canLeave, event.codeOfConductUrl, conductRequired, conductAcceptedAt]
  );

  const eventValue = React.useMemo<EventContextValue>(() => ({ event, network, hasKnowledge }), [event, network, hasKnowledge]);

  return (
    <EventContext.Provider value={eventValue}>
      <EventRoleContext.Provider value={roleValue}>{children}</EventRoleContext.Provider>
    </EventContext.Provider>
  );
}

/**
 * Hook to access current event
 */
export function useEvent(): Event {
  const context = React.useContext(EventContext);
  if (!context) {
    throw new Error('useEvent must be used within EventProvider');
  }
  return context.event;
}

/**
 * Whether this viewer can read any transcript of this gathering — the server computed it for the
 * account the page was rendered for. Cheap: it drives the sidebar's "Ask" item, nothing else.
 */
export function useEventHasKnowledge(): boolean {
  return React.useContext(EventContext)?.hasKnowledge ?? false;
}

/**
 * Hook to access the gathering's network identity (null before publication for non-organizers)
 */
export function useEventNetwork(): EventNetwork | null {
  const context = React.useContext(EventContext);
  if (!context) {
    throw new Error('useEventNetwork must be used within EventProvider');
  }
  return context.network;
}

/**
 * Hook to access user's role in current event
 */
export function useEventRole(): EventRoleContextValue {
  const context = React.useContext(EventRoleContext);
  if (!context) {
    throw new Error('useEventRole must be used within EventProvider');
  }
  return context;
}


/**
 * "Join this gathering": the explicit action that makes a signed-in visitor an attendee.
 * Renders nothing for members; a sign-in link for visitors; a tickets link when a paid ticket
 * is required. Packages B/C can place it wherever an attendee-only action is gated.
 */
export function JoinGatheringButton({ className, size = 'default', label = 'Join this gathering' }: { className?: string; size?: 'default' | 'sm' | 'lg'; label?: string }) {
  const event = useEvent();
  const { user, isLoading: authLoading } = useAuth();
  const { isMember, isLoading, joinable, joinBlockedBy, join, isJoining, codeOfConductUrl, conductAcceptanceRequired } = useEventRole();
  const [message, setMessage] = React.useState<string | null>(null);
  const [ticketsUrl, setTicketsUrl] = React.useState<string | null>(null);
  const [accepted, setAccepted] = React.useState(false);
  const checkboxId = React.useId();

  if (authLoading || isLoading || isMember) return null;
  if (!user) {
    const here = typeof window === 'undefined' ? `/e/${event.slug}` : `${window.location.pathname}${window.location.search}`;
    return <Button asChild size={size} className={className}><Link href={`/login?returnTo=${encodeURIComponent(here)}`}>Sign in to join</Link></Button>;
  }
  if (joinBlockedBy === 'ticket-required' || ticketsUrl) {
    return <Button asChild size={size} className={className}><Link href={ticketsUrl ?? `/e/${event.slug}/tickets`}>Get a ticket to join</Link></Button>;
  }
  if (joinable === false) return null;

  const onJoin = async () => {
    setMessage(null);
    const result = await join({ acceptConduct: accepted });
    if (!result.ok) {
      if (result.ticketsUrl) setTicketsUrl(result.ticketsUrl);
      setMessage(result.message);
    }
  };

  // The gathering's own code of conduct (MT §12.19). When acceptance is required the tick is
  // the gate, and the link is right next to it: nobody should have to agree to a document they
  // were not shown. When it is not required the link is still offered, because it is still the
  // thing a person is about to walk into.
  const conduct = codeOfConductUrl ? (
    <span className="max-w-sm text-xs text-muted-foreground">
      {conductAcceptanceRequired ? (
        <label htmlFor={checkboxId} className="flex cursor-pointer items-start gap-2">
          <input
            id={checkboxId}
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-[hsl(var(--primary))]"
          />
          <span>
            I have read and accept the{' '}
            <a href={codeOfConductUrl} target="_blank" rel="noopener noreferrer" className="underline">code of conduct</a>{' '}
            for {event.name}.
          </span>
        </label>
      ) : (
        <a href={codeOfConductUrl} target="_blank" rel="noopener noreferrer" className="underline">
          Read the code of conduct for {event.name}
        </a>
      )}
    </span>
  ) : null;

  return <span className="inline-flex flex-col items-start gap-2">
    {conduct}
    <Button type="button" size={size} className={className} onClick={onJoin} loading={isJoining}
      disabled={joinable === null || (conductAcceptanceRequired && Boolean(codeOfConductUrl) && !accepted)}>
      {label}
    </Button>
    {message ? <span role="alert" className="text-xs text-destructive">{message}</span> : null}
  </span>;
}
