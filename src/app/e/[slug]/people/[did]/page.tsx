'use client'

/**
 * One member's profile inside one gathering — `/e/[slug]/people/[did]` (design §3.1).
 *
 * Members only, like every gathering page: a private or draft gathering, a DID that is not a
 * member here, and a member who opted out of the directory all render the same "members only"
 * page, because the API answers 404 to all three (`participants/[did]`). Nothing on this page is
 * reachable without a membership, so nothing here needs its own privacy rule — what the route
 * chose to send is what is shown.
 *
 * The profile is per gathering rather than global (owner decision, design §7) so the members-only
 * boundary stays exactly where it already is: the email address and the messaging handle are the
 * ones this person shares in THIS gathering.
 */

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Loader2,
  Lock,
  ArrowLeft,
  AtSign,
  Building2,
  Rocket,
  Compass,
  Hash,
  Send,
  Mail,
  Hexagon,
  CalendarDays,
  Mic,
  Users,
  User,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { ReportButton } from '@/components/ReportButton'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { memberRoleBadge } from '@/lib/labels'
import { sessionStatusBadge } from '@/lib/labels'
import { plural } from '@/lib/format'
import {
  BlueskyLink,
  MemberAvatar,
  messagingLink,
  nameOf,
  peopleHref,
  type MemberCardData,
} from '../shared'

interface HostedSession {
  id: string
  title: string
  status: string
  start_time: string | null
  venue_name: string | null
}

interface SharedGathering {
  slug: string
  name: string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; member: MemberCardData; sessions: HostedSession[] }
  | { kind: 'signed_out' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }

export default function MemberProfilePage() {
  const params = useParams<{ did: string }>()
  // Next has already decoded the segment; decoding again would mangle a DID that legitimately
  // contains a percent (did:web allows them). The API's `decodeDidParam` handles the one case
  // this cannot — a client that double-encoded the segment.
  const did = typeof params?.did === 'string' ? params.did : ''
  const event = useEvent()
  const { user, isLoading: authLoading } = useAuth()
  const { isMember, isLoading: roleLoading } = useEventRole()
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [gatherings, setGatherings] = React.useState<SharedGathering[]>([])

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ member: MemberCardData; sessions: HostedSession[] }>(
        `/api/v1/events/${encodeURIComponent(event.slug)}/participants/${encodeURIComponent(did)}`,
        { cache: 'no-store' },
      )
      setState({ kind: 'ready', member: res.member, sessions: res.sessions ?? [] })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState({ kind: 'signed_out' })
      else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setState({ kind: 'not_found' })
      else setState({ kind: 'error', message: err instanceof Error ? err.message : 'Could not load this profile' })
    }
  }, [event.slug, did])

  React.useEffect(() => {
    if (authLoading || roleLoading) return
    if (!user?.id) {
      setState({ kind: 'signed_out' })
      return
    }
    setState({ kind: 'loading' })
    void load()
  }, [authLoading, roleLoading, user?.id, isMember, load])

  // The gatherings both people belong to (design §3.1: "shared gatherings from the members API").
  // Cleared whenever the DID changes, so a client-side navigation between two profiles never
  // shows the previous person's list while this one loads.
  React.useEffect(() => {
    setGatherings([])
  }, [did])

  React.useEffect(() => {
    if (state.kind !== 'ready') return
    let cancelled = false
    apiFetch<{ gatherings: SharedGathering[] }>(`/api/v1/members/${encodeURIComponent(did)}`, { cache: 'no-store' })
      .then((res) => {
        if (!cancelled) setGatherings(res.gatherings ?? [])
      })
      .catch(() => {
        // The card is already on the page; a failure here just means no "also at" list.
        if (!cancelled) setGatherings([])
      })
    return () => {
      cancelled = true
    }
  }, [state.kind, did])

  if (authLoading || roleLoading || state.kind === 'loading') {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading this profile">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </DashboardLayout>
    )
  }

  if (state.kind !== 'ready') {
    const copy =
      state.kind === 'signed_out'
        ? { title: 'Sign in to see this profile', body: 'Profiles are visible only to members of this gathering.' }
        : state.kind === 'not_found'
          ? {
              title: 'Members only',
              body: 'This profile is not available. Join this gathering to see the people taking part, or they may have chosen not to be listed.',
            }
          : { title: 'Could not load this profile', body: state.message }
    return (
      <DashboardLayout>
        <PageHeader title="Profile" />
        <Card>
          <CardContent className="py-12 text-center">
            <Lock className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold mb-2">{copy.title}</h2>
            <p className="text-muted-foreground">{copy.body}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {state.kind === 'signed_out' && (
                <Button asChild>
                  <Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/people/${did}`)}`}>Sign in</Link>
                </Button>
              )}
              {state.kind === 'not_found' && !isMember && <JoinGatheringButton />}
              {state.kind === 'not_found' && isMember && (
                <Button asChild variant="outline">
                  <Link href={peopleHref(event.slug)}>Back to People</Link>
                </Button>
              )}
              {state.kind === 'error' && (
                <Button variant="outline" onClick={() => { setState({ kind: 'loading' }); void load() }}>
                  Try again
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </DashboardLayout>
    )
  }

  const { member, sessions } = state
  const roleLabel = memberRoleBadge(member.role)
  const messaging = member.telegram ? messagingLink(member.telegram) : null
  const name = nameOf(member)
  const elsewhere = gatherings.filter((g) => g.slug !== event.slug)
  const emptyProfile =
    !member.bio && !member.building && !member.looking_for && !member.interests?.length && !member.affiliation

  return (
    <DashboardLayout>
      <div className="space-y-6" data-testid="member-profile">
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link href={peopleHref(event.slug)}>
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
            People
          </Link>
        </Button>

        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <MemberAvatar person={member} size="lg" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-2xl font-semibold">{name}</h1>
                  {roleLabel && <Badge variant="default">{roleLabel}</Badge>}
                  {member.is_self && <Badge variant="outline">You</Badge>}
                </div>
                {member.handle && (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="truncate">{member.handle}</span>
                    <BlueskyLink person={member} />
                  </p>
                )}
                {member.affiliation && (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Building2 className="h-4 w-4" aria-hidden="true" />
                    {member.affiliation}
                  </p>
                )}
              </div>
            </div>

            {member.bio && <p className="mt-5 whitespace-pre-line text-foreground">{member.bio}</p>}

            {member.building && (
              <div className="mt-5 space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Rocket className="h-4 w-4" aria-hidden="true" />
                  What they’re building
                </h2>
                <p className="whitespace-pre-line text-foreground">{member.building}</p>
              </div>
            )}

            {member.looking_for && (
              <div className="mt-5 space-y-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Compass className="h-4 w-4" aria-hidden="true" />
                  Looking for
                </h2>
                <p className="whitespace-pre-line text-foreground">{member.looking_for}</p>
              </div>
            )}

            {member.interests && member.interests.length > 0 && (
              <div className="mt-5 space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Hash className="h-4 w-4" aria-hidden="true" />
                  Interests
                </h2>
                <div className="flex flex-wrap gap-2" data-testid="profile-interests">
                  {member.interests.map((interest) => (
                    // Each interest leads back to People, filtered to it (design §3.1).
                    <Link
                      key={interest}
                      href={peopleHref(event.slug, { interest })}
                      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <Badge variant="secondary" className="cursor-pointer hover:bg-secondary/70">{interest}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {(messaging || member.email || member.ens) && (
              <div className="mt-5 flex flex-col gap-2 border-t pt-4" data-testid="profile-contact">
                {messaging && (
                  <div className="flex items-center gap-2 text-sm">
                    <Send className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                    {messaging.href ? (
                      <a href={messaging.href} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">
                        {messaging.label}
                      </a>
                    ) : (
                      <span className="break-all">{messaging.label}</span>
                    )}
                  </div>
                )}
                {member.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                    <a href={`mailto:${member.email}`} className="break-all text-primary hover:underline">
                      {member.email}
                    </a>
                    <span className="text-xs text-muted-foreground">shared with members here</span>
                  </div>
                )}
                {member.ens && (
                  <div className="flex items-center gap-2 text-sm">
                    <Hexagon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                    <a
                      href={`https://app.ens.domains/${encodeURIComponent(member.ens)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {member.ens}
                    </a>
                    <Badge variant="success">Verified</Badge>
                  </div>
                )}
              </div>
            )}

            {emptyProfile && !member.is_self && (
              <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" aria-hidden="true" />
                This member hasn’t filled in their profile yet.
              </p>
            )}
            {member.is_self && (
              <p className="mt-5 text-xs text-muted-foreground">
                This is how fellow members of {event.name} see you. Edit it from Account in the sidebar menu.
              </p>
            )}
          </CardContent>
        </Card>

        <section aria-labelledby="profile-sessions-heading" className="space-y-3">
          <h2 id="profile-sessions-heading" className="flex items-center gap-2 font-semibold">
            <Mic className="h-4 w-4 text-primary" aria-hidden="true" />
            Sessions they host here
          </h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions at {event.name} yet.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => {
                const status = sessionStatusBadge(s.status)
                return (
                  <Card key={s.id} className="card-hover">
                    <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4">
                      <Link href={`/e/${event.slug}/sessions/${s.id}`} className="font-medium hover:text-primary">
                        {s.title}
                      </Link>
                      <Badge variant={status.badge}>{status.label}</Badge>
                      {s.start_time && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                          {new Date(s.start_time).toLocaleString('en-US', {
                            timeZone: event.timezone,
                            weekday: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                      {s.venue_name && <span className="text-xs text-muted-foreground">{s.venue_name}</span>}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </section>

        {elsewhere.length > 0 && (
          <section aria-labelledby="profile-gatherings-heading" className="space-y-3">
            <h2 id="profile-gatherings-heading" className="flex items-center gap-2 font-semibold">
              <Users className="h-4 w-4" aria-hidden="true" />
              Also with you at
            </h2>
            <p className="text-sm text-muted-foreground">
              {plural(elsewhere.length, 'gathering', 'gatherings')} you both belong to. Only you see this.
            </p>
            <div className="flex flex-wrap gap-2">
              {elsewhere.map((g) => (
                <Button key={g.slug} asChild variant="outline" size="sm">
                  <Link href={`/e/${g.slug}`}>{g.name}</Link>
                </Button>
              ))}
            </div>
          </section>
        )}

        {!member.is_self && (
          <div className="border-t pt-4">
            {/* Reports go to this gathering's organizers by account id — never a DID. */}
            <ReportButton
              eventSlug={event.slug}
              subjectKind="profile"
              accountId={member.id}
              subjectLabel={name}
              className="text-muted-foreground"
            />
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
