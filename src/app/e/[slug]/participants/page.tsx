'use client'

import * as React from 'react'
import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Loader2,
  Users,
  Shield,
  Search,
  Building2,
  Rocket,
  Send,
  Mail,
  Hexagon,
  Hash,
  User,
  AtSign,
  Lock,
  EyeOff,
  Compass,
  Sparkles,
  ArrowUpRight,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { FilterChip } from '@/components/ui/filter-chip'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select } from '@/components/ui/select'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'
import { ReportButton } from '@/components/ReportButton'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural, truncate } from '@/lib/format'
import { ORGANIZER_ROLES, memberRoleBadge } from '@/lib/labels'
import { cn } from '@/lib/utils'
import {
  BlueskyLink,
  MemberAvatar,
  ViewProfileLink,
  messagingLink,
  nameOf,
  profileHref,
  type MemberCardData,
} from '../people/shared'
import {
  SORTS,
  defaultSort,
  hasOwnInterests,
  isSortKey,
  overlapCounts,
  sortParticipants,
  type SortKey,
} from '../people/sort'

/** Shape of GET /api/v1/events/[slug]/participants → participants[]. */
type Participant = MemberCardData

interface MySettings {
  role: string
  directory_listing: boolean
  public_role: boolean
  publish_roles?: boolean
  /** Design §3.3: the viewer's per-gathering contact sharing. Older API builds omit them. */
  share_contact?: boolean
  share_email?: boolean
}

interface SharedInterests {
  id: string
  interests: string[]
}

interface ParticipantsResponse {
  participants: Participant[]
  me: MySettings | null
  /** People who share the viewer's interests, computed server-side for the viewer only. */
  sharedInterests?: SharedInterests[]
}

export default function ParticipantsPage() {
  return (
    <Suspense fallback={
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading people">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </DashboardLayout>
    }>
      <ParticipantsContent />
    </Suspense>
  )
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'signed_out' }
  | { kind: 'not_member' }
  | { kind: 'error'; message: string }

function ParticipantsContent() {
  const { user, isLoading: authLoading } = useAuth()
  const userId = user?.id ?? null
  const event = useEvent()
  // Membership is explicit (Join); reload once the role settles.
  const { isMember, isLoading: roleLoading } = useEventRole()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const highlight = searchParams.get('highlight')

  const [participants, setParticipants] = React.useState<Participant[]>([])
  const [shared, setShared] = React.useState<SharedInterests[]>([])
  const [me, setMe] = React.useState<MySettings | null>(null)
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [search, setSearch] = React.useState('')
  const [selected, setSelected] = React.useState<Participant | null>(null)
  const highlightHandledRef = React.useRef(false)

  // Sort and interest filters live in the URL so a filtered view is a link someone can send
  // (design §3.4). `?interest=` may repeat; the chips are AND, as they were.
  const sortParam = searchParams.get('sort')
  const interestParams = React.useMemo(() => searchParams.getAll('interest').filter(Boolean), [searchParams])
  const selectedInterests = React.useMemo(() => new Set(interestParams), [interestParams])

  const setQuery = React.useCallback(
    (next: { sort?: SortKey | null; interests?: string[] }) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next.sort !== undefined) {
        if (next.sort) params.set('sort', next.sort)
        else params.delete('sort')
      }
      if (next.interests !== undefined) {
        params.delete('interest')
        for (const i of next.interests) params.append('interest', i)
      }
      // `?highlight=` is a one-shot: it has opened its card by now, and keeping it would reopen
      // the dialog on every filter change.
      params.delete('highlight')
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<ParticipantsResponse>(
        `/api/v1/events/${encodeURIComponent(event.slug)}/participants`,
        { cache: 'no-store' },
      )
      setParticipants(res.participants)
      setShared(res.sharedInterests ?? [])
      setMe(res.me)
      setState({ kind: 'ready' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState({ kind: 'signed_out' })
      else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setState({ kind: 'not_member' })
      else setState({ kind: 'error', message: err instanceof Error ? err.message : 'Could not load the directory' })
    }
  }, [event.slug])

  React.useEffect(() => {
    if (authLoading || roleLoading) return
    if (!userId) {
      setState({ kind: 'signed_out' })
      return
    }
    setState({ kind: 'loading' })
    void load()
  }, [authLoading, roleLoading, userId, isMember, load])

  // Open a profile from ?highlight=<account id or DID> once the list has loaded.
  React.useEffect(() => {
    if (!highlight || highlightHandledRef.current || participants.length === 0) return
    const found = participants.find((p) => p.id === highlight || p.did === highlight)
    if (found) {
      setSelected(found)
      highlightHandledRef.current = true
    }
  }, [highlight, participants])

  const allInterests = React.useMemo(() => {
    const set = new Set<string>()
    participants.forEach((p) => p.interests?.forEach((i) => set.add(i)))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [participants])

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return participants.filter((p) => {
      const matchesSearch =
        !q ||
        p.display_name?.toLowerCase().includes(q) ||
        p.handle?.toLowerCase().includes(q) ||
        p.affiliation?.toLowerCase().includes(q) ||
        p.building?.toLowerCase().includes(q) ||
        p.looking_for?.toLowerCase().includes(q)
      const matchesInterests =
        selectedInterests.size === 0 || Array.from(selectedInterests).every((i) => p.interests?.includes(i))
      return matchesSearch && matchesInterests
    })
  }, [participants, search, selectedInterests])

  // Interest overlap with the viewer, over the WHOLE roster. The route's `sharedInterests` is
  // capped at the six people it suggests on the card strip, so it cannot order a directory.
  const sharedCounts = React.useMemo(() => overlapCounts(participants), [participants])
  const viewerHasInterests = React.useMemo(() => hasOwnInterests(participants), [participants])
  // A `?sort=shared` link is only meaningful to a viewer with interests of their own; for anyone
  // else the option is disabled, so the URL falls back rather than selecting a dead option.
  const requested = isSortKey(sortParam) ? sortParam : null
  const sort: SortKey =
    requested && (requested !== 'shared' || viewerHasInterests) ? requested : defaultSort(viewerHasInterests)
  const sorted = React.useMemo(() => sortParticipants(filtered, sort, sharedCounts), [filtered, sort, sharedCounts])

  const organizers = sorted.filter((p) => ORGANIZER_ROLES.includes(p.role))
  const others = sorted.filter((p) => !ORGANIZER_ROLES.includes(p.role))
  const byId = React.useMemo(() => new Map(participants.map((p) => [p.id, p])), [participants])
  const sharedPeople = shared
    .map((s) => ({ person: byId.get(s.id), interests: s.interests }))
    .filter((s): s is { person: Participant; interests: string[] } => Boolean(s.person))
  const filtering = search.trim().length > 0 || selectedInterests.size > 0

  if (authLoading || roleLoading || state.kind === 'loading') {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading people">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </DashboardLayout>
    )
  }

  if (state.kind !== 'ready') {
    const copy =
      state.kind === 'signed_out'
        ? { title: 'Sign in to see who is here', body: 'The people directory is visible only to members of this gathering.' }
        : state.kind === 'not_member'
          ? { title: 'Members only', body: 'Join this gathering to see and connect with the people taking part. Joining is never published.' }
          : { title: 'Could not load the directory', body: state.message }
    return (
      <DashboardLayout>
        <PageHeader title="People" />
        <Card>
          <CardContent className="py-12 text-center">
            <Lock className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold mb-2">{copy.title}</h2>
            <p className="text-muted-foreground">{copy.body}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {state.kind === 'signed_out' && (
                <Button asChild>
                  <Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/participants`)}`}>Sign in</Link>
                </Button>
              )}
              {state.kind === 'not_member' && <JoinGatheringButton />}
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

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="People"
          subtitle={`${plural(participants.length, 'person', 'people')} listed for ${event.name}. Visible only to members.`}
        />

        {me && (
          <DirectorySettings
            slug={event.slug}
            name={event.name}
            settings={me}
            onChange={(next) => { setMe(next); void load() }}
          />
        )}

        {sharedPeople.length > 0 && !filtering && (
          <section aria-labelledby="shared-heading">
            <h2 id="shared-heading" className="font-semibold mb-1 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              People who share your interests
            </h2>
            <p className="text-sm text-muted-foreground mb-3">Matched on the interests in your profile. Only you see this.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sharedPeople.map(({ person, interests }) => (
                <ParticipantCard key={person.did} participant={person} shared={interests} onClick={() => setSelected(person)} />
              ))}
            </div>
          </section>
        )}

        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                aria-label="Search people"
                placeholder="Search by name, handle, affiliation or what people are looking for"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select
              aria-label="Sort people"
              value={sort}
              onChange={(e) => setQuery({ sort: e.target.value as SortKey })}
              wrapperClassName="sm:w-72"
            >
              {(Object.entries(SORTS) as [SortKey, string][]).map(([value, label]) => (
                <option key={value} value={value} disabled={value === 'shared' && !viewerHasInterests}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          {allInterests.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center" role="group" aria-label="Filter by interests">
              <span className="text-sm text-muted-foreground">Filter by interests</span>
              {allInterests.map((interest) => (
                <FilterChip
                  key={interest}
                  pressed={selectedInterests.has(interest)}
                  onClick={() =>
                    setQuery({
                      interests: selectedInterests.has(interest)
                        ? interestParams.filter((i) => i !== interest)
                        : [...interestParams, interest],
                    })
                  }
                >
                  {interest}
                </FilterChip>
              ))}
              {selectedInterests.size > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setQuery({ interests: [] })} className="text-muted-foreground">
                  Clear all
                </Button>
              )}
            </div>
          )}
        </div>

        {sorted.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-lg font-semibold mb-2">
                {participants.length === 0 ? 'No one is listed yet' : 'No matches found'}
              </h2>
              <p className="text-muted-foreground">
                {participants.length === 0 ? 'Members appear here once they join.' : 'Try adjusting your search or filters.'}
              </p>
              {filtering && (
                <Button variant="outline" className="mt-6" onClick={() => { setSearch(''); setQuery({ interests: [] }) }}>
                  Clear filters
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {organizers.length > 0 && (
              <section aria-labelledby="organizers-heading">
                <h2 id="organizers-heading" className="font-semibold mb-3 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" aria-hidden="true" />
                  Organizers ({organizers.length})
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {organizers.map((p) => (
                    <ParticipantCard key={p.did} participant={p} onClick={() => setSelected(p)} />
                  ))}
                </div>
              </section>
            )}
            {others.length > 0 && (
              <section aria-labelledby="participants-heading">
                <h2 id="participants-heading" className="font-semibold mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" aria-hidden="true" />
                  Participants ({others.length})
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {others.map((p) => (
                    <ParticipantCard key={p.did} participant={p} onClick={() => setSelected(p)} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <ProfileDialog participant={selected} onClose={() => setSelected(null)} />
    </DashboardLayout>
  )
}

function DirectorySettings({
  slug,
  name,
  settings,
  onChange,
}: {
  slug: string
  name: string
  settings: MySettings
  onChange: (next: MySettings) => void
}) {
  const id = React.useId()
  const [busy, setBusy] = React.useState<'directory_listing' | 'public_role' | null>(null)
  const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const update = async (field: 'directory_listing' | 'public_role', value: boolean) => {
    setBusy(field)
    setMessage(null)
    try {
      const res = await apiFetch<MySettings & { role_claim?: { status: string; error?: string } }>(
        `/api/v1/events/${encodeURIComponent(slug)}/participants/me`,
        { method: 'PATCH', json: { [field]: value } },
      )
      onChange(res)
      const claim = res.role_claim
      const claimMessages: Record<string, string> = {
        published: 'You are now publicly listed as a host of this gathering.',
        retracted: 'Your public host listing was removed.',
        'role-too-low': 'Saved. You will be listed once you host a scheduled session.',
        'policy-off': 'Saved. The organizers have not turned on public role listings.',
        'not-linked': 'Saved. This gathering is not on the network yet; you will be listed when it is.',
      }
      if (claim?.status === 'error') setMessage({ type: 'error', text: claim.error || 'Saved, but the public listing could not be updated yet.' })
      else setMessage({ type: 'success', text: (claim && claimMessages[claim.status]) || 'Saved.' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save that setting.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3 text-sm">
          <Checkbox
            id={`${id}-listing`}
            className="mt-0.5"
            checked={settings.directory_listing}
            disabled={busy !== null}
            onCheckedChange={(checked) => update('directory_listing', checked === true)}
          />
          <label htmlFor={`${id}-listing`} className="cursor-pointer">
            <span className="font-medium">List me in this directory</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Other members of this gathering can see your name, photo, affiliation, interests and what you’re
              looking for. Your messaging handle and your email address have their own switches under
              “What you share at {name}” in Account → Profile; your email is off unless you turn it on.
            </span>
          </label>
        </div>
        <div className="flex items-start gap-3 text-sm">
          <Checkbox
            id={`${id}-public-role`}
            className="mt-0.5"
            checked={settings.public_role}
            disabled={busy !== null}
            onCheckedChange={(checked) => update('public_role', checked === true)}
          />
          <label htmlFor={`${id}-public-role`} className="cursor-pointer">
            <span className="font-medium">Publicly list me as a host of this gathering</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Publishes a public record on the open network saying you hosted at this gathering. It applies only if
              you host a scheduled session and the organizers allow public role listings. Turning this off removes the
              record, though copies may persist elsewhere.
            </span>
          </label>
        </div>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Saving" />}
        {message && (
          <p className={cn('text-xs', message.type === 'success' ? 'text-success' : 'text-destructive')} role={message.type === 'success' ? 'status' : 'alert'}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function ParticipantCard({ participant, shared, onClick }: { participant: Participant; shared?: string[]; onClick: () => void }) {
  const event = useEvent()
  const roleLabel = memberRoleBadge(participant.role)
  const showHandle = participant.handle && participant.display_name?.trim()
  return (
    <Card className="card-hover border-border/50 hover:border-primary/30">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <button type="button" className="text-left" onClick={onClick} aria-label={`Open ${nameOf(participant)}’s card`}>
            <MemberAvatar person={participant} size="sm" />
          </button>
          <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {/* The name is the link to the profile page (design §3.2); the card itself still
                    opens the quick-look dialog the directory has always had. */}
                <Link href={profileHref(event.slug, participant.did)} className="font-medium truncate hover:text-primary hover:underline">
                  {nameOf(participant)}
                </Link>
                {roleLabel && <Badge variant="default">{roleLabel}</Badge>}
                {participant.is_self && <Badge variant="outline">You</Badge>}
              </div>
              {showHandle && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
                  <span className="truncate">@{participant.handle}</span>
                  <BlueskyLink person={participant} />
                </p>
              )}
              {participant.affiliation && (
                <p className="text-sm text-muted-foreground truncate">{participant.affiliation}</p>
              )}
              {participant.looking_for && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-foreground/80">
                  <Compass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span><span className="text-muted-foreground">Looking for:</span> {truncate(participant.looking_for, 90)}</span>
                </p>
              )}
              {shared && shared.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-2" aria-label="Interests you share">
                  {shared.slice(0, 3).map((interest) => (
                    <Badge key={interest} variant="success">{interest}</Badge>
                  ))}
                  {shared.length > 3 && <Badge variant="success">+{shared.length - 3}</Badge>}
                </div>
              ) : participant.interests && participant.interests.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {participant.interests.slice(0, 3).map((interest) => (
                    <Badge key={interest} variant="outline">{interest}</Badge>
                  ))}
                  {participant.interests.length > 3 && (
                    <Badge variant="outline">+{participant.interests.length - 3}</Badge>
                  )}
                </div>
              ) : null}
            <button
              type="button"
              onClick={onClick}
              className="mt-2 text-xs font-medium text-muted-foreground hover:text-primary"
            >
              Quick look
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ProfileDialog({ participant, onClose }: { participant: Participant | null; onClose: () => void }) {
  const event = useEvent()
  const roleLabel = participant ? memberRoleBadge(participant.role) : undefined
  const messaging = participant?.telegram ? messagingLink(participant.telegram) : null

  return (
    <Dialog open={participant !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="sm" className="p-0 overflow-hidden">
        {participant && (
          <>
            <div className="relative p-6 bg-gradient-to-br from-primary/10 to-transparent">
              <div className="flex items-start gap-4 pr-8">
                <MemberAvatar person={participant} size="lg" />
                <DialogHeader className="min-w-0 flex-1 pr-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* The card header links to the profile page; the dialog stays the quick look. */}
                    <DialogTitle className="text-xl">
                      <Link href={profileHref(event.slug, participant.did)} className="hover:text-primary hover:underline">
                        {nameOf(participant)}
                      </Link>
                    </DialogTitle>
                    {roleLabel && <Badge variant="default">{roleLabel}</Badge>}
                  </div>
                  {participant.handle && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1 truncate">
                      <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="truncate">{participant.handle}</span>
                      <BlueskyLink person={participant} />
                    </p>
                  )}
                  {participant.affiliation && (
                    <DialogDescription className="flex items-center gap-1">
                      <Building2 className="h-4 w-4" aria-hidden="true" />
                      {participant.affiliation}
                    </DialogDescription>
                  )}
                  {!participant.affiliation && <DialogDescription className="sr-only">Member profile</DialogDescription>}
                </DialogHeader>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {participant.bio && <p className="text-foreground whitespace-pre-line">{participant.bio}</p>}

              {participant.building && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Rocket className="h-4 w-4" aria-hidden="true" />
                    What they’re building
                  </p>
                  <p className="text-foreground whitespace-pre-line">{participant.building}</p>
                </div>
              )}

              {participant.looking_for && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Compass className="h-4 w-4" aria-hidden="true" />
                    Looking for
                  </p>
                  <p className="text-foreground whitespace-pre-line">{participant.looking_for}</p>
                </div>
              )}

              {participant.interests && participant.interests.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Hash className="h-4 w-4" aria-hidden="true" />
                    Interests
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {participant.interests.map((interest) => (
                      <Badge key={interest} variant="secondary">{interest}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {(messaging || participant.email || participant.ens) && (
                <div className="flex flex-col gap-2 pt-4 border-t">
                  {messaging && (
                    <div className="flex items-center gap-2 text-sm">
                      <Send className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                      {messaging.href ? (
                        <a href={messaging.href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                          {messaging.label}
                        </a>
                      ) : (
                        <span className="break-all">{messaging.label}</span>
                      )}
                    </div>
                  )}
                  {participant.email && (
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                      <a href={`mailto:${participant.email}`} className="text-primary hover:underline break-all">
                        {participant.email}
                      </a>
                    </div>
                  )}
                  {participant.ens && (
                    <div className="flex items-center gap-2 text-sm">
                      <Hexagon className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                      <a
                        href={`https://app.ens.domains/${encodeURIComponent(participant.ens)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {participant.ens}
                      </a>
                      <Badge variant="success">Verified</Badge>
                    </div>
                  )}
                </div>
              )}

              <p className="pt-1">
                <ViewProfileLink slug={event.slug} did={participant.did} className="inline-flex items-center gap-1">
                  View full profile
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </ViewProfileLink>
              </p>
              {participant.is_self && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                  This is you. Edit your profile from Account in the sidebar menu.
                </p>
              )}
              {!participant.is_self && (
                <div className="border-t pt-4">
                  {/* Reports go to this gathering's organizers by account id — never a DID. */}
                  <ReportButton
                    eventSlug={event.slug}
                    subjectKind="profile"
                    accountId={participant.id}
                    subjectLabel={nameOf(participant)}
                    className="text-muted-foreground"
                  />
                </div>
              )}
              {!participant.is_self && !participant.bio && !participant.building && !participant.looking_for && !participant.interests?.length && (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <User className="h-4 w-4" aria-hidden="true" />
                  This member hasn’t filled in their profile yet.
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
