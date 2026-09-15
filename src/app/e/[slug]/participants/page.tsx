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
  X,
  Hash,
  User,
  AtSign,
  Lock,
  EyeOff,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
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

interface ParticipantsResponse {
  participants: Participant[]
  me: MySettings | null
}

const ORGANIZER_ROLES = ['owner', 'admin', 'moderator']

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  moderator: 'Moderator',
  track_lead: 'Track Lead',
  volunteer: 'Volunteer',
}

function nameOf(p: Participant): string {
  return p.display_name || (p.handle ? `@${p.handle}` : 'Member')
}

export default function ParticipantsPage() {
  return (
    <Suspense fallback={
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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
  // Signed-in visitors of a public gathering are joined by EventContext; reload once that settles.
  const { isMember, isLoading: roleLoading } = useEventRole()
  const searchParams = useSearchParams()
  const highlight = searchParams.get('highlight')

  const [participants, setParticipants] = React.useState<Participant[]>([])
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
        p.building?.toLowerCase().includes(q)
      const matchesInterests =
        selectedInterests.size === 0 || Array.from(selectedInterests).every((i) => p.interests?.includes(i))
      return matchesSearch && matchesInterests
    })
  }, [participants, search, selectedInterests])

  const organizers = filtered.filter((p) => ORGANIZER_ROLES.includes(p.role))
  const others = filtered.filter((p) => !ORGANIZER_ROLES.includes(p.role))

  if (authLoading || roleLoading || state.kind === 'loading') {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  if (state.kind !== 'ready') {
    const copy =
      state.kind === 'signed_out'
        ? { title: 'Sign in to see who is here', body: 'The people directory is visible only to members of this gathering.' }
        : state.kind === 'not_member'
          ? { title: 'Members only', body: 'Join this gathering to see and connect with the people taking part.' }
          : { title: 'Could not load the directory', body: state.message }
    return (
      <DashboardLayout>
        <Card>
          <CardContent className="py-12 text-center">
            <Lock className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h1 className="text-lg font-semibold mb-2">{copy.title}</h1>
            <p className="text-muted-foreground">{copy.body}</p>
            {state.kind === 'signed_out' && (
              <Button asChild className="mt-6">
                <Link href={`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/participants`)}`}>Sign in</Link>
              </Button>
            )}
            {state.kind === 'error' && (
              <Button variant="outline" className="mt-6" onClick={() => { setState({ kind: 'loading' }); void load() }}>
                Try again
              </Button>
            )}
          </CardContent>
        </Card>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">People</h1>
          <p className="text-muted-foreground mt-1">
            {participants.length} {participants.length === 1 ? 'person' : 'people'} listed for {event.name}. Visible only to members.
          </p>
        </div>

        {me && <DirectorySettings slug={event.slug} settings={me} onChange={(next) => { setMe(next); void load() }} />}

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search people"
              placeholder="Search by name, handle, or affiliation"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>

          {allInterests.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-sm text-muted-foreground">Filter by interests:</span>
              {selectedInterests.size > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedInterests(new Set())} className="text-muted-foreground">
                  Clear all
                </Button>
              )}
              {allInterests.map((interest) => (
                <Button
                  key={interest}
                  variant={selectedInterests.has(interest) ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={selectedInterests.has(interest)}
                  onClick={() => {
                    const next = new Set(selectedInterests)
                    if (next.has(interest)) next.delete(interest)
                    else next.add(interest)
                    setSelectedInterests(next)
                  }}
                >
                  {interest}
                </Button>
              ))}
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold mb-2">
                {participants.length === 0 ? 'No one is listed yet' : 'No matches found'}
              </h2>
              <p className="text-muted-foreground">
                {participants.length === 0 ? 'Members appear here once they join.' : 'Try adjusting your search or filters'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {organizers.length > 0 && (
              <section>
                <h2 className="font-semibold mb-3 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" />
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
              <section>
                <h2 className="font-semibold mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
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

      {selected && <ProfileModal participant={selected} onClose={() => setSelected(null)} />}
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
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save that setting' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 space-y-3">
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={settings.directory_listing}
            disabled={busy !== null}
            onChange={(e) => update('directory_listing', e.target.checked)}
          />
          <span>
            <span className="font-medium">List me in this directory</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Other members of this gathering can see your name, photo, affiliation, interests and Telegram.
              Your email is never shown.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={settings.public_role}
            disabled={busy !== null}
            onChange={(e) => update('public_role', e.target.checked)}
          />
          <span>
            <span className="font-medium">Publicly list me as a host of this gathering</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Publishes a public record on the open network saying you hosted at this gathering. It applies only if
              you host a scheduled session and the organizers allow public role listings. Turning this off removes the
              record, though copies may persist elsewhere.
            </span>
          </span>
        </label>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Saving" />}
        {message && (
          <p className={cn('text-xs', message.type === 'success' ? 'text-green-600' : 'text-destructive')} role="status">
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function Avatar({ participant, size }: { participant: Participant; size: 'sm' | 'lg' }) {
  const [failed, setFailed] = React.useState(false)
  const dims = size === 'sm' ? 'h-12 w-12' : 'h-20 w-20 border-2 border-border'
  const organizer = ORGANIZER_ROLES.includes(participant.role)
  return (
    <div className={cn('rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0', dims)}>
      {participant.avatar_url && !failed ? (
        <img
          src={participant.avatar_url}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : size === 'sm' ? (
        <span className={cn('font-medium text-lg', organizer ? 'text-primary' : 'text-muted-foreground')}>
          {nameOf(participant).replace(/^@/, '')[0]?.toUpperCase() ?? '?'}
        </span>
      ) : (
        <User className="h-10 w-10 text-muted-foreground" />
      )}
    </div>
  )
}

function ParticipantCard({ participant, onClick }: { participant: Participant; onClick: () => void }) {
  const roleLabel = ROLE_LABELS[participant.role]
  return (
    <Card className="card-hover cursor-pointer border-border/50 hover:border-primary/30">
      <button type="button" className="w-full text-left" onClick={onClick}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Avatar participant={participant} size="sm" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{nameOf(participant)}</span>
                {roleLabel && (
                  <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border-primary/20">
                    {roleLabel}
                  </Badge>
                )}
                {participant.is_self && <Badge variant="outline" className="text-xs">You</Badge>}
              </div>
              {participant.affiliation && (
                <p className="text-sm text-muted-foreground truncate">{participant.affiliation}</p>
              )}
              {participant.interests && participant.interests.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {participant.interests.slice(0, 3).map((interest) => (
                    <Badge key={interest} variant="outline" className="text-xs">{interest}</Badge>
                  ))}
                  {participant.interests.length > 3 && (
                    <Badge variant="outline" className="text-xs">+{participant.interests.length - 3}</Badge>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </button>
    </Card>
  )
}

function ProfileModal({ participant, onClose }: { participant: Participant; onClose: () => void }) {
  const roleLabel = ROLE_LABELS[participant.role]

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="participant-name"
        className="w-full max-w-md mx-4 bg-card border rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-transparent">
          <Button variant="ghost" size="icon" className="absolute top-4 right-4" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
          <div className="flex items-start gap-4">
            <Avatar participant={participant} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 id="participant-name" className="text-xl font-bold">{nameOf(participant)}</h2>
                {roleLabel && <Badge className="bg-primary/10 text-primary border-primary/20">{roleLabel}</Badge>}
              </div>
              {participant.handle && (
                <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1 truncate">
                  <AtSign className="h-3.5 w-3.5" />
                  {participant.handle}
                </p>
              )}
              {participant.affiliation && (
                <p className="text-muted-foreground flex items-center gap-1 mt-1">
                  <Building2 className="h-4 w-4" />
                  {participant.affiliation}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {participant.bio && <p className="text-foreground whitespace-pre-line">{participant.bio}</p>}

          {participant.building && (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Rocket className="h-4 w-4" />
                What they&apos;re building
              </p>
              <p className="text-foreground whitespace-pre-line">{participant.building}</p>
            </div>
          )}

          {participant.interests && participant.interests.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Hash className="h-4 w-4" />
                Interests
              </p>
              <div className="flex flex-wrap gap-2">
                {participant.interests.map((interest) => (
                  <Badge key={interest} variant="secondary">{interest}</Badge>
                ))}
              </div>
            </div>
          )}

          {(participant.telegram || participant.ens) && (
            <div className="flex flex-col gap-2 pt-4 border-t">
              {participant.telegram && (
                <div className="flex items-center gap-2 text-sm">
                  <Send className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <a
                    href={`https://t.me/${encodeURIComponent(participant.telegram)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    @{participant.telegram}
                  </a>
                </div>
              )}
              {participant.ens && (
                <div className="flex items-center gap-2 text-sm">
                  <Hexagon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <a
                    href={`https://app.ens.domains/${encodeURIComponent(participant.ens)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {participant.ens}
                  </a>
                  <Badge variant="outline" className="text-[10px]">verified</Badge>
                </div>
              )}
            </div>
          )}

          {participant.is_self && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <EyeOff className="h-3.5 w-3.5" />
              This is you. Edit your profile from your account menu.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
