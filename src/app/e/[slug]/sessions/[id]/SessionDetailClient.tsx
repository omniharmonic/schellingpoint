'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  MapPin,
  Users,
  Heart,
  Share2,
  Calendar,
  Mic,
  Wrench,
  MessageSquare,
  Monitor,
  User,
  Loader2,
  Clock,
  ExternalLink,
  Pencil,
  Trash2,
  X,
  MessageCircle,
  Lock,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { WarningBox } from '@/components/WarningBox'
import { DashboardLayout } from '@/components/DashboardLayout'
import { EditSessionModal } from '@/components/EditSessionModal'
import { ManageCohostsSection } from '@/components/ManageCohostsSection'
import { SessionMerge } from '@/components/SessionMerge'
import { AddToCalendar } from '@/components/AddToCalendar'
import { ReportButton } from '@/components/ReportButton'
import { HostSessionAnalytics } from '@/components/HostSessionAnalytics'
import { RSVPButton } from '@/components/RSVPButton'
import { SessionFeedback } from '@/components/SessionFeedback'
import { SessionResources } from '@/components/SessionResources'
import { TranscriptPanel } from '@/components/knowledge/TranscriptPanel'
import { AtprotoSessionActions } from '@/components/AtprotoSessionActions'
import { VoteControl } from '@/components/VoteControl'
import { setFavorite } from '@/components/SessionCard'
import { useAuth } from '@/hooks/useAuth'
import { useVoting } from '@/hooks/useVoting'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { sessionStatusBadge } from '@/lib/labels'
import { EN_DASH, truncate } from '@/lib/format'
import { formatDescription, formatLabel } from '@/lib/sessions/constants'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import { SessionLocationMap } from '@/components/map/StaticVenueMap'
import { directionsHref } from '@/lib/geo/directions'
import type { SessionView, PersonView } from '@/app/api/v1/sessions/_lib/read'
import { cn } from '@/lib/utils'

const formatIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  talk: Mic,
  workshop: Wrench,
  discussion: MessageSquare,
  panel: Users,
  demo: Monitor,
}

interface SessionDetailClientProps {
  sessionId: string
  initialSession?: SessionView | null
}

type HostCard = PersonView & { key: string; bio?: string | null; affiliation?: string | null; role: string }

function formatInZone(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString('en-US', { timeZone, ...options })
}

/** A Bluesky compose intent: the viewer posts from their own account, nothing is written for them. */
function blueskyComposeUrl(title: string, url: string): string {
  return `https://bsky.app/intent/compose?text=${encodeURIComponent(`${title}\n${url}`)}`
}

function Separator() {
  return <span className="text-muted-foreground/50" aria-hidden>·</span>
}

export function SessionDetailClient({ sessionId, initialSession }: SessionDetailClientProps) {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()
  const { toast } = useToast()
  const votingOpen = isParticipationOpen(event, 'vote')
  // The attendance round (design §11): open only while the gathering is live and opted in.
  const attendance = useVoting(event.slug, 'attendance')

  const [session, setSession] = React.useState<SessionView | null>(initialSession ?? null)
  const [isLoading, setIsLoading] = React.useState(!initialSession)
  const [error, setError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [showHostCard, setShowHostCard] = React.useState<string | null>(null)
  const [showEditModal, setShowEditModal] = React.useState(false)
  const [showWithdrawConfirm, setShowWithdrawConfirm] = React.useState(false)
  const [isWithdrawing, setIsWithdrawing] = React.useState(false)
  const [pageUrl, setPageUrl] = React.useState('')
  const hostCardRef = React.useRef<HTMLDivElement>(null)
  const rsvpRef = React.useRef<HTMLDivElement>(null)

  const endpoint = `/api/v1/events/${encodeURIComponent(event.slug)}/sessions/${sessionId}`

  const refresh = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ session: SessionView }>(endpoint, { cache: 'no-store' })
      setSession(data.session)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This session could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [endpoint])

  // The server render saw the viewer's cookie; refresh once the client knows who is signed in.
  React.useEffect(() => {
    refresh()
  }, [refresh, user?.id])

  React.useEffect(() => {
    setPageUrl(window.location.href)
  }, [])

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (hostCardRef.current && !hostCardRef.current.contains(e.target as Node)) setShowHostCard(null)
    }
    if (showHostCard) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showHostCard])

  const goToLogin = () => router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/sessions/${sessionId}`)}`)

  const handleToggleFavorite = async () => {
    if (!session) return
    if (!user) return goToLogin()
    const next = !session.is_favorite
    setActionError(null)
    setSession({ ...session, is_favorite: next })
    try {
      await setFavorite(event.slug, sessionId, next)
      toast({
        title: next ? 'Saved to my schedule' : 'Removed from my schedule',
        variant: 'success',
        action: next ? { label: 'View my schedule', onClick: () => router.push(`/e/${event.slug}/my-schedule`) } : undefined,
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Your saved schedule could not be updated. Please try again.')
      setSession((s) => (s ? { ...s, is_favorite: !next } : s))
    }
  }

  const handleShare = async () => {
    const shareUrl = window.location.href
    const shareTitle = session?.title || 'A session worth seeing'
    const shareText = session?.description ? `${shareTitle} · ${truncate(session.description, 100)}` : shareTitle
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, text: shareText, url: shareUrl })
        return
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast({ title: 'Link copied', description: 'Paste it anywhere to share this session.', variant: 'success' })
    } catch {
      toast({ title: 'The link could not be copied', description: shareUrl, variant: 'destructive' })
    }
  }

  const handleWithdraw = async () => {
    setIsWithdrawing(true)
    setActionError(null)
    try {
      const result = await apiFetch<{ deleted: boolean }>(`/api/v1/sessions/${sessionId}`, { method: 'DELETE' })
      setShowWithdrawConfirm(false)
      toast({ title: 'Proposal withdrawn', variant: 'success' })
      if (result.deleted) router.push(`/e/${event.slug}/sessions?filter=mine`)
      else await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Your proposal could not be withdrawn. Please try again.')
      setShowWithdrawConfirm(false)
    } finally {
      setIsWithdrawing(false)
    }
  }

  const focusRsvp = () => {
    rsvpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    rsvpRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading session">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  if (error || !session) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Button variant="ghost" asChild className="gap-2">
            <Link href={`/e/${event.slug}/sessions`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to sessions
            </Link>
          </Button>
          <div className="py-12 text-center">
            <p role="alert" className="mb-4 text-destructive">{error || 'This session could not be found.'}</p>
            <Button asChild><Link href={`/e/${event.slug}/sessions`}>View all sessions</Link></Button>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  const FormatIcon = formatIcons[session.format ?? ''] || Mic
  const { viewer } = session
  const startsAt = session.time_slot?.start_time ?? (session.is_self_hosted ? session.self_hosted_start_time : null)
  const sessionHasStarted = session.status === 'scheduled' && !!startsAt && new Date(startsAt).getTime() <= Date.now()
  const hosts: HostCard[] = [
    ...(session.host ? [{ ...session.host, key: 'host', role: 'Host' }] : []),
    ...session.cohosts.map((c) => ({ ...c, key: c.id, role: 'Co-host' })),
  ]
  // Handles are optional on both hosts and co-hosts; only render the ones present.
  const hostHandles = hosts.map((h) => h.handle).filter((h): h is string => !!h)
  const confirmed = session.my_rsvp?.status === 'confirmed'
  const status = sessionStatusBadge(session.status)
  const shareUrl = pageUrl || `/e/${event.slug}/sessions/${session.id}`

  const iconAction = (label: string, onClick: () => void, icon: React.ReactNode, extra?: { pressed?: boolean; className?: string }) => (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={extra?.pressed}
      className={extra?.className}
    >
      {icon}
    </Button>
  )

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <Button variant="ghost" asChild className="gap-2">
          <Link href={`/e/${event.slug}/sessions`}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to sessions
          </Link>
        </Button>

        {actionError && (
          <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{actionError}</p>
        )}

        {viewer.is_organizer && session.proposal_withdrawn && (
          <WarningBox title="Withdrawn by its proposer">
            The proposer withdrew this proposal from their repository. Review it on the schedule.
          </WarningBox>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5" title={formatDescription(session.format)}>
                      <FormatIcon className="h-4 w-4 shrink-0" aria-hidden />
                      {formatLabel(session.format)}
                    </span>
                    {session.duration != null && (
                      <>
                        <Separator />
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-4 w-4 shrink-0" aria-hidden />
                          {session.duration} min
                        </span>
                      </>
                    )}
                    <Separator />
                    <Badge variant={status.badge}>{status.label}</Badge>
                    {session.track && (
                      <>
                        <Separator />
                        <span className="flex items-center gap-1.5">
                          {session.track.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: session.track.color }} aria-hidden />}
                          <span>{session.track.name}</span>
                        </span>
                      </>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {viewer.can_edit && iconAction('Edit session', () => setShowEditModal(true), <Pencil className="h-5 w-5" aria-hidden />)}
                    {iconAction(
                      session.is_favorite ? 'Remove from my schedule' : 'Save to my schedule',
                      handleToggleFavorite,
                      <Heart className={cn('h-5 w-5', session.is_favorite && 'fill-favorite')} aria-hidden />,
                      { pressed: session.is_favorite, className: session.is_favorite ? 'text-favorite' : undefined }
                    )}
                    {iconAction('Share session', handleShare, <Share2 className="h-5 w-5" aria-hidden />)}
                  </div>
                </div>

                <h1 className="page-title mb-4 break-words">{session.title}</h1>

                {hosts.length === 0 ? (
                  <p className="italic text-muted-foreground">{hostByline(session)}</p>
                ) : (
                  <div className="relative" ref={hostCardRef}>
                    <button
                      type="button"
                      onClick={() => setShowHostCard(showHostCard ? null : hosts[0].key)}
                      aria-expanded={!!showHostCard}
                      className="group flex items-center gap-3 rounded-lg text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <div className="flex -space-x-2">
                        {hosts.map((host) => (
                          <div key={host.key} className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-muted ring-2 ring-background">
                            {host.avatar_url ? (
                              <img src={host.avatar_url} alt="" className="h-full w-full object-cover" />
                            ) : host.handle ? (
                              <span className="text-sm font-medium uppercase text-muted-foreground">{host.handle.charAt(0)}</span>
                            ) : (
                              <User className="h-4 w-4 text-muted-foreground" aria-hidden />
                            )}
                          </div>
                        ))}
                      </div>
                      <span className="min-w-0">
                        <span className="block text-foreground">
                          {session.host ? `Hosted by ${hostByline(session)}` : hostByline(session)}
                        </span>
                        {hostHandles.length > 0 && (
                          <span className="block truncate text-sm text-muted-foreground">
                            {hostHandles.map((h) => `@${h}`).join(' · ')}
                          </span>
                        )}
                      </span>
                    </button>

                    {showHostCard && (() => {
                      const active = hosts.find((h) => h.key === showHostCard) || hosts[0]
                      return (
                        <>
                          <div className="fixed inset-0 z-40 bg-foreground/40 md:hidden" onClick={() => setShowHostCard(null)} />
                          <div className="fixed inset-x-4 bottom-4 z-50 overflow-hidden rounded-xl border bg-card shadow-xl md:absolute md:inset-x-auto md:bottom-auto md:left-0 md:top-full md:mt-2 md:w-80">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setShowHostCard(null)}
                              className="absolute right-1 top-1 hidden md:inline-flex"
                              aria-label="Close"
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </Button>
                            {hosts.length > 1 && (
                              <div className="flex border-b pr-10">
                                {hosts.map((host) => (
                                  <button
                                    key={host.key}
                                    type="button"
                                    onClick={() => setShowHostCard(host.key)}
                                    className={cn(
                                      'flex-1 truncate px-3 py-2 text-sm transition-colors',
                                      showHostCard === host.key ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground'
                                    )}
                                  >
                                    {host.display_name || (host.handle ? `@${host.handle}` : host.role)}
                                  </button>
                                ))}
                              </div>
                            )}
                            <div className="p-4 pr-10">
                              <div className="mb-3 flex items-start gap-3">
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                                  {active.avatar_url ? (
                                    <img src={active.avatar_url} alt="" className="h-full w-full object-cover" />
                                  ) : active.handle ? (
                                    <span className="text-lg font-medium uppercase text-muted-foreground">{active.handle.charAt(0)}</span>
                                  ) : (
                                    <User className="h-6 w-6 text-muted-foreground" aria-hidden />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <h4 className="truncate font-semibold">{active.display_name || (active.handle ? `@${active.handle}` : 'Member')}</h4>
                                  {active.handle && <p className="truncate text-xs text-muted-foreground">@{active.handle}</p>}
                                  {active.affiliation && <p className="truncate text-sm text-muted-foreground">{active.affiliation}</p>}
                                </div>
                              </div>
                              <Badge variant="muted" className="mb-2">{active.role}</Badge>
                              {active.bio && <p className="mb-1 line-clamp-3 text-sm text-muted-foreground">{active.bio}</p>}
                            </div>
                            <button
                              type="button"
                              onClick={() => setShowHostCard(null)}
                              className="w-full border-t py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted md:hidden"
                            >
                              Close
                            </button>
                          </div>
                        </>
                      )
                    })()}
                  </div>
                )}

                {session.topic_tags.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {session.topic_tags.map((tag) => (
                      <Badge key={tag} variant="muted">{tag}</Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {(session.venue || session.time_slot || session.is_self_hosted) && (
              <Card className="border-primary/20 bg-primary/5">
                <CardContent className="p-4 pt-4 sm:p-6 sm:pt-6">
                  <SessionLocationMap session={session} className="mb-4" />
                  <div className="grid gap-6 sm:grid-cols-2">
                    {session.is_self_hosted ? (
                      <div>
                        <div className="mb-2 flex items-center gap-2">
                          <MapPin className="h-5 w-5 text-primary" aria-hidden />
                          <h3 className="font-semibold">Self-hosted location</h3>
                        </div>
                        <Badge variant="amber" className="mb-2">Self-hosted</Badge>
                        {session.self_hosted_start_time && (
                          <div className="mb-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Clock className="h-4 w-4" aria-hidden />
                            <span>
                              {formatInZone(session.self_hosted_start_time, event.timezone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              {session.self_hosted_end_time && <> {EN_DASH} {formatInZone(session.self_hosted_end_time, event.timezone, { hour: 'numeric', minute: '2-digit' })}</>}
                            </span>
                          </div>
                        )}
                        {session.custom_location ? (
                          <>
                            <p className="whitespace-pre-wrap text-muted-foreground">{session.custom_location}</p>
                            <Button asChild variant="outline" size="sm" className="mt-2">
                              <a
                                href={directionsHref({ lat: session.location_geo?.exact ? session.location_geo.lat : null, lng: session.location_geo?.exact ? session.location_geo.lng : null, query: session.custom_location }) ?? '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <MapPin className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                                Get directions
                              </a>
                            </Button>
                          </>
                        ) : session.has_private_location ? (
                          <div className="space-y-1">
                            {session.public_place && <p className="text-muted-foreground">{session.public_place}</p>}
                            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                              The exact location is shared with confirmed attendees.
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm italic text-muted-foreground">The host will share location details.</p>
                        )}
                      </div>
                    ) : session.venue && (
                      <div>
                        <div className="mb-2 flex items-center gap-2">
                          <MapPin className="h-5 w-5 text-primary" aria-hidden />
                          <h3 className="font-semibold">Location</h3>
                        </div>
                        <p className="text-lg font-medium">{session.venue.name}</p>
                        {session.venue.capacity && <p className="text-sm text-muted-foreground">Capacity: {session.venue.capacity} people</p>}
                        {session.venue.address && (
                          <Button asChild variant="outline" size="sm" className="mt-2">
                            <a
                              href={directionsHref({ lat: session.venue.geo?.lat, lng: session.venue.geo?.lng, query: session.venue.address }) ?? '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <MapPin className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                              Get directions
                            </a>
                          </Button>
                        )}
                        {session.venue.features.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {session.venue.features.map((feature) => (
                              <Badge key={feature} variant="outline">{feature}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {session.time_slot && (
                      <div>
                        <div className="mb-2 flex items-center gap-2">
                          <Calendar className="h-5 w-5 text-primary" aria-hidden />
                          <h3 className="font-semibold">Schedule</h3>
                        </div>
                        <p className="text-lg font-medium">
                          {formatInZone(session.time_slot.start_time, event.timezone, { weekday: 'long', month: 'long', day: 'numeric' })}
                        </p>
                        <p className="text-muted-foreground">
                          {formatInZone(session.time_slot.start_time, event.timezone, { hour: 'numeric', minute: '2-digit' })}
                          {` ${EN_DASH} `}
                          {formatInZone(session.time_slot.end_time, event.timezone, { hour: 'numeric', minute: '2-digit' })}
                        </p>
                        {session.time_slot.label && <Badge variant="outline" className="mt-2">{session.time_slot.label}</Badge>}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {session.telegram_group_url ? (
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 pt-4">
                  <p className="text-sm text-muted-foreground">This session has a chat group for confirmed attendees.</p>
                  <Button asChild variant="outline">
                    <a href={session.telegram_group_url} target="_blank" rel="noopener noreferrer">
                      <MessageCircle className="mr-2 h-4 w-4" aria-hidden />
                      Join the chat group
                      <ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden />
                    </a>
                  </Button>
                </CardContent>
              </Card>
            ) : session.has_telegram_group && !confirmed ? (
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 pt-4">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Lock className="h-4 w-4 shrink-0" aria-hidden />
                    This session has a chat group for confirmed attendees.
                  </p>
                  {session.status === 'scheduled' && (
                    <Button variant="outline" size="sm" onClick={focusRsvp}>
                      RSVP to get the link
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : null}

            <Card className="overflow-hidden">
              <CardHeader className="pb-2">
                <CardTitle className="text-xl">About this session</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="prose prose-sm max-w-none break-words">
                  {session.description ? (
                    session.description.split('\n').map((paragraph, i) => (
                      <p key={i} className="mb-3 text-muted-foreground">{paragraph}</p>
                    ))
                  ) : (
                    <p className="italic text-muted-foreground">No description yet.</p>
                  )}
                </div>
                {session.required_features.length > 0 && (
                  <div className="mt-4 border-t pt-4" data-testid="session-required-features">
                    <p className="text-xs font-medium text-muted-foreground">What the room needs</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {session.required_features.map((feature) => (
                        <Badge key={feature} variant="muted">{feature}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {(viewer.is_host || viewer.is_cohost || viewer.is_organizer) && (
              <HostSessionAnalytics eventSlug={event.slug} sessionId={sessionId} />
            )}

            {sessionHasStarted && <SessionFeedback sessionId={sessionId} eventSlug={event.slug} />}
          </div>

          <div className="space-y-6">
            {votingOpen && session.status !== 'rejected' && session.status !== 'pending' && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Your votes</CardTitle>
                </CardHeader>
                <CardContent>
                  <VoteControl eventSlug={event.slug} sessionId={sessionId} sessionTitle={session.title} />
                </CardContent>
              </Card>
            )}
            {attendance.signedIn && attendance.attendanceOpen && attendance.status === 'open' && session.status === 'scheduled' && (
              <Card className={cn(attendance.votableNow.has(sessionId) && 'border-primary/40')}>
                <CardHeader className="pb-3">
                  <CardTitle>{attendance.votableNow.has(sessionId) ? 'Happening now' : 'Attendance votes'}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {attendance.votableNow.has(sessionId)
                      ? 'You are here: spend fresh attendance credits on this session while it runs.'
                      : 'Attendance votes open 15 minutes before this session starts and close 15 minutes after it ends.'}
                  </p>
                  <VoteControl eventSlug={event.slug} sessionId={sessionId} sessionTitle={session.title} round="attendance" />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Quick actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {viewer.can_edit && (
                  <Button className="w-full justify-start" variant="outline" onClick={() => setShowEditModal(true)}>
                    <Pencil className="mr-2 h-4 w-4" aria-hidden />
                    Edit session
                  </Button>
                )}
                <Button
                  className={cn('w-full justify-start', session.is_favorite && 'text-favorite hover:text-favorite')}
                  variant="outline"
                  onClick={handleToggleFavorite}
                  aria-pressed={session.is_favorite}
                >
                  <Heart className={cn('mr-2 h-4 w-4', session.is_favorite && 'fill-favorite')} aria-hidden />
                  {session.is_favorite ? 'Saved to my schedule' : 'Save to my schedule'}
                </Button>
                <Button className="w-full justify-start" variant="outline" onClick={handleShare}>
                  <Share2 className="mr-2 h-4 w-4" aria-hidden />
                  Share
                </Button>
                <Button asChild className="w-full justify-start" variant="outline">
                  <a href={blueskyComposeUrl(session.title, shareUrl)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" aria-hidden />
                    Share on Bluesky
                  </a>
                </Button>
                {session.status === 'scheduled' && startsAt && (
                  <AddToCalendar
                    session={{
                      id: session.id,
                      title: session.title,
                      description: session.description,
                      hostLabel: session.host?.display_name ?? null,
                      is_self_hosted: session.is_self_hosted,
                      self_hosted_start_time: session.self_hosted_start_time,
                      self_hosted_end_time: session.self_hosted_end_time,
                      time_slot: session.time_slot,
                      venue: session.venue,
                    }}
                    eventSlug={event.slug}
                    eventLocation={event.locationName}
                    variant="outline"
                    size="default"
                    className="w-full justify-start"
                  />
                )}
                {session.status === 'scheduled' && (
                  <div ref={rsvpRef} id="rsvp" className="pt-1">
                    <RSVPButton
                      sessionId={sessionId}
                      rsvpCount={session.rsvp_count}
                      waitlistCount={session.waitlist_count}
                      capacity={session.venue?.capacity ?? null}
                      initialStatus={session.my_rsvp?.status ?? null}
                      initialWaitlistPosition={session.my_rsvp?.waitlist_position ?? null}
                      variant="default"
                      className="w-full"
                      showCapacity
                      onRSVPChange={() => refresh()}
                    />
                  </div>
                )}
                {!viewer.is_host && (
                  <ReportButton
                    eventSlug={event.slug}
                    subjectKind="session"
                    sessionId={sessionId}
                    subjectLabel="this session"
                    variant="outline"
                    className="w-full justify-start text-muted-foreground"
                  />
                )}
                {viewer.is_host && !showWithdrawConfirm && (
                  <Button
                    className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                    variant="outline"
                    onClick={() => setShowWithdrawConfirm(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                    Withdraw proposal
                  </Button>
                )}
                {viewer.is_host && showWithdrawConfirm && (
                  <ConfirmInline
                    destructive
                    confirmLabel="Withdraw"
                    loading={isWithdrawing}
                    onConfirm={handleWithdraw}
                    onCancel={() => setShowWithdrawConfirm(false)}
                    message={
                      <>
                        Withdraw “{session.title}”? Its public record is deleted from your repository (copies may persist on the network).{' '}
                        {session.status === 'scheduled'
                          ? 'It is already on the schedule, so the organizers will decide what happens to its slot.'
                          : 'The session, its favorites and RSVPs are removed from this gathering.'}
                      </>
                    }
                  />
                )}
              </CardContent>
            </Card>

            <SessionResources sessionId={sessionId} eventSlug={event.slug} canManage={viewer.can_manage} />
            <TranscriptPanel sessionId={sessionId} eventSlug={event.slug} sessionTitle={session.title} canManage={viewer.can_manage} />

            <AtprotoSessionActions
              sessionId={sessionId}
              eventSlug={event.slug}
              signedIn={!!user}
              userRsvpStatus={session.my_rsvp?.status ?? null}
            />

            {(viewer.is_host || viewer.is_cohost || viewer.is_organizer || session.merged_into) && (
              <SessionMerge
                eventSlug={event.slug}
                sessionId={sessionId}
                sessionTitle={session.title}
                isHost={viewer.is_host}
                canRead={viewer.is_host || viewer.is_cohost || viewer.is_organizer}
                mergedInto={session.merged_into}
              />
            )}

            {(viewer.is_host || viewer.is_cohost || viewer.is_organizer) && (
              <ManageCohostsSection
                sessionId={sessionId}
                cohosts={session.cohosts}
                isHost={viewer.is_host}
                isOrganizer={viewer.is_organizer}
                onCohostsChange={refresh}
              />
            )}

            {viewer.can_edit && (
              <EditSessionModal
                isOpen={showEditModal}
                onClose={() => setShowEditModal(false)}
                session={session}
                onSave={(updated) => setSession(updated)}
              />
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
