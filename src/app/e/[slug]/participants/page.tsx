'use client'

import * as React from 'react'
import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Loader2,
  Users,
  Shield,
  Search,
  Building2,
  Rocket,
  Send,
  Hexagon,
  Hash,
  User,
  AtSign,
  Lock,
  EyeOff,
  Compass,
  Sparkles,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { FilterChip } from '@/components/ui/filter-chip'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DashboardLayout } from '@/components/DashboardLayout'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole, JoinGatheringButton } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural, truncate } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Shape of GET /api/v1/events/[slug]/participants → participants[]. */
interface Participant {
  id: string
  did: string
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  affiliation: string | null
  bio: string | null
  building: string | null
  interests: string[] | null
  /** "What I'm looking for" (release design §6). */
  looking_for?: string | null
  telegram: string | null
  ens: string | null
  role: string
  is_self: boolean
}

interface MySettings {
  role: string
  directory_listing: boolean
  public_role: boolean
  publish_roles?: boolean
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

const ORGANIZER_ROLES = ['owner', 'admin', 'moderator']

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  moderator: 'Moderator',
  track_lead: 'Track lead',
  volunteer: 'Volunteer',
}

/** Display name → @handle → "Member" (release design §5.3). */
function nameOf(p: Participant): string {
  return p.display_name?.trim() || (p.handle ? `@${p.handle}` : 'Member')
}

/** Avatar fallback: first letter of the name, else of the handle, else "M". */
function initialOf(p: Participant): string {
  return (p.display_name?.trim() || p.handle || 'Member').replace(/^@/, '').charAt(0).toUpperCase() || 'M'
}

/**
 * The messaging handle is free text (Telegram, Signal, Matrix…). It becomes a link only when it
 * parses as a Telegram username or an http(s) URL; otherwise it is shown as plain text.
 */
function messagingLink(value: string): { href: string | null; label: string } {
  const trimmed = value.trim()
  const telegram = /^@?([A-Za-z0-9_]{5,32})$/.exec(trimmed)
  if (telegram) return { href: `https://t.me/${encodeURIComponent(telegram[1])}`, label: `@${telegram[1]}` }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return { href: url.toString(), label: `${url.hostname}${url.pathname === '/' ? '' : url.pathname}` }
    } catch {
      return { href: null, label: trimmed }
    }
  }
  return { href: null, label: trimmed }
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
  const highlight = searchParams.get('highlight')

  const [participants, setParticipants] = React.useState<Participant[]>([])
  const [shared, setShared] = React.useState<SharedInterests[]>([])
  const [me, setMe] = React.useState<MySettings | null>(null)
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [search, setSearch] = React.useState('')
  const [selectedInterests, setSelectedInterests] = React.useState<Set<string>>(new Set())
  const [selected, setSelected] = React.useState<Participant | null>(null)
  const highlightHandledRef = React.useRef(false)

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

  const organizers = filtered.filter((p) => ORGANIZER_ROLES.includes(p.role))
  const others = filtered.filter((p) => !ORGANIZER_ROLES.includes(p.role))
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

        {me && <DirectorySettings slug={event.slug} settings={me} onChange={(next) => { setMe(next); void load() }} />}

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
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="Search people"
              placeholder="Search by name, handle, affiliation or what people are looking for"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>

          {allInterests.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center" role="group" aria-label="Filter by interests">
              <span className="text-sm text-muted-foreground">Filter by interests</span>
              {allInterests.map((interest) => (
                <FilterChip
                  key={interest}
                  pressed={selectedInterests.has(interest)}
                  onClick={() => {
                    const next = new Set(selectedInterests)
                    if (next.has(interest)) next.delete(interest)
                    else next.add(interest)
                    setSelectedInterests(next)
                  }}
                >
                  {interest}
                </FilterChip>
              ))}
              {selectedInterests.size > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedInterests(new Set())} className="text-muted-foreground">
                  Clear all
                </Button>
              )}
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
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
                <Button variant="outline" className="mt-6" onClick={() => { setSearch(''); setSelectedInterests(new Set()) }}>
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
  settings,
  onChange,
}: {
  slug: string
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
              Other members of this gathering can see your name, photo, affiliation, interests, what you’re looking
              for, and your messaging handle. Your email is never shown.
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

function Avatar({ participant, size }: { participant: Participant; size: 'sm' | 'lg' }) {
  const [failed, setFailed] = React.useState(false)
  const dims = size === 'sm' ? 'h-12 w-12 text-lg' : 'h-20 w-20 border-2 border-border text-2xl'
  const organizer = ORGANIZER_ROLES.includes(participant.role)
  return (
    <div className={cn('rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0', dims)} aria-hidden="true">
      {participant.avatar_url && !failed ? (
        <img
          src={participant.avatar_url}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={cn('font-medium', organizer ? 'text-primary' : 'text-muted-foreground')}>{initialOf(participant)}</span>
      )}
    </div>
  )
}

function ParticipantCard({ participant, shared, onClick }: { participant: Participant; shared?: string[]; onClick: () => void }) {
  const roleLabel = ROLE_LABELS[participant.role]
  const showHandle = participant.handle && participant.display_name?.trim()
  return (
    <Card className="card-hover cursor-pointer border-border/50 hover:border-primary/30">
      <button type="button" className="w-full text-left" onClick={onClick}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Avatar participant={participant} size="sm" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium truncate">{nameOf(participant)}</span>
                {roleLabel && <Badge variant="default">{roleLabel}</Badge>}
                {participant.is_self && <Badge variant="outline">You</Badge>}
              </div>
              {showHandle && <p className="text-xs text-muted-foreground truncate">@{participant.handle}</p>}
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
            </div>
          </div>
        </CardContent>
      </button>
    </Card>
  )
}

function ProfileDialog({ participant, onClose }: { participant: Participant | null; onClose: () => void }) {
  const roleLabel = participant ? ROLE_LABELS[participant.role] : undefined
  const messaging = participant?.telegram ? messagingLink(participant.telegram) : null

  return (
    <Dialog open={participant !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="sm" className="p-0 overflow-hidden">
        {participant && (
          <>
            <div className="relative p-6 bg-gradient-to-br from-primary/10 to-transparent">
              <div className="flex items-start gap-4 pr-8">
                <Avatar participant={participant} size="lg" />
                <DialogHeader className="min-w-0 flex-1 pr-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <DialogTitle className="text-xl">{nameOf(participant)}</DialogTitle>
                    {roleLabel && <Badge variant="default">{roleLabel}</Badge>}
                  </div>
                  {participant.handle && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1 truncate">
                      <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
                      {participant.handle}
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

              {(messaging || participant.ens) && (
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

              {participant.is_self && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                  This is you. Edit your profile from Account in the sidebar menu.
                </p>
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
