'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
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
  AlertTriangle,
  X,
  Send,
  Lock,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DashboardLayout } from '@/components/DashboardLayout'
import { EditSessionModal } from '@/components/EditSessionModal'
import { ManageCohostsSection } from '@/components/ManageCohostsSection'
import { AddToCalendar } from '@/components/AddToCalendar'
import { RSVPButton } from '@/components/RSVPButton'
import { SessionFeedback } from '@/components/SessionFeedback'
import { SessionResources } from '@/components/SessionResources'
import { AtprotoSessionActions } from '@/components/AtprotoSessionActions'
import { VoteControl } from '@/components/VoteControl'
import { setFavorite } from '@/components/SessionCard'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import type { SessionView, PersonView } from '@/app/api/v1/sessions/_lib/read'

const formatIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  talk: Mic,
  workshop: Wrench,
  discussion: MessageSquare,
  panel: Users,
  demo: Monitor,
}

const formatDescriptions: Record<string, string> = {
  talk: 'A presentation by one speaker',
  workshop: 'Hands-on interactive session',
  discussion: 'Facilitated group conversation',
  panel: 'Multiple speakers discuss a topic',
  demo: 'Live demonstration of a project or tool',
}

interface SessionDetailClientProps {
  sessionId: string
  initialSession?: SessionView | null
}

type HostCard = PersonView & { key: string; bio?: string | null; affiliation?: string | null; role: string }

function formatInZone(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString('en-US', { timeZone, ...options })
}

export function SessionDetailClient({ sessionId, initialSession }: SessionDetailClientProps) {
  const router = useRouter()
  const { user } = useAuth()
  const event = useEvent()
  const votingOpen = isParticipationOpen(event, 'vote')

  const [session, setSession] = React.useState<SessionView | null>(initialSession ?? null)
  const [isLoading, setIsLoading] = React.useState(!initialSession)
  const [error, setError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [showShareToast, setShowShareToast] = React.useState(false)
  const [showHostCard, setShowHostCard] = React.useState<string | null>(null)
  const [showEditModal, setShowEditModal] = React.useState(false)
  const [showWithdrawConfirm, setShowWithdrawConfirm] = React.useState(false)
  const [isWithdrawing, setIsWithdrawing] = React.useState(false)
  const hostCardRef = React.useRef<HTMLDivElement>(null)

  const endpoint = `/api/v1/events/${encodeURIComponent(event.slug)}/sessions/${sessionId}`

  const refresh = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ session: SessionView }>(endpoint, { cache: 'no-store' })
      setSession(data.session)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session')
    } finally {
      setIsLoading(false)
    }
  }, [endpoint])

  // The server render saw the viewer's cookie; refresh once the client knows who is signed in.
  React.useEffect(() => {
    refresh()
  }, [refresh, user?.id])

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
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Your saved schedule could not be updated. Please try again.')
      setSession((s) => (s ? { ...s, is_favorite: !next } : s))
    }
  }

  const handleShare = async () => {
    const shareUrl = window.location.href
    const shareTitle = session?.title || 'Check out this session'
    const shareText = session?.description ? `${shareTitle} - ${session.description.substring(0, 100)}...` : shareTitle
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
      setShowShareToast(true)
      setTimeout(() => setShowShareToast(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleWithdraw = async () => {
    setIsWithdrawing(true)
    setActionError(null)
    try {
      const result = await apiFetch<{ deleted: boolean }>(`/api/v1/sessions/${sessionId}`, { method: 'DELETE' })
      setShowWithdrawConfirm(false)
      if (result.deleted) router.push(`/e/${event.slug}/sessions?filter=mine`)
      else await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Your proposal could not be withdrawn. Please try again.')
      setShowWithdrawConfirm(false)
    } finally {
      setIsWithdrawing(false)
    }
  }

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  if (error || !session) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Button variant="ghost" onClick={() => router.back()} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <div className="text-center py-12">
            <p className="text-destructive mb-4">{error || 'Session not found'}</p>
            <Button onClick={() => router.push(`/e/${event.slug}/sessions`)}>View All Sessions</Button>
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
  const confirmed = session.my_rsvp?.status === 'confirmed'

  return (
    <DashboardLayout>
      <div className="space-y-6 overflow-hidden">
        {actionError && <p role="alert" className="rounded-xl border p-4 text-sm text-destructive">{actionError}</p>}
        <Button variant="ghost" onClick={() => router.back()} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Sessions
        </Button>

        {viewer.is_organizer && session.proposal_withdrawn && (
          <Card className="p-4 border-amber-500/40 bg-amber-500/5 text-sm">
            The proposer withdrew this proposal from their repository. Review it on the schedule.
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Card className="p-6 relative">
              <div className="absolute top-4 right-4 flex gap-2">
                {viewer.can_edit && (
                  <Button variant="ghost" size="icon" onClick={() => setShowEditModal(true)} title="Edit session" aria-label="Edit session">
                    <Pencil className="h-5 w-5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleToggleFavorite}
                  className={session.is_favorite ? 'text-red-500' : ''}
                  aria-label={session.is_favorite ? 'Remove from my schedule' : 'Save to my schedule'}
                  aria-pressed={session.is_favorite}
                >
                  <Heart className={session.is_favorite ? 'fill-current' : ''} />
                </Button>
                <Button variant="ghost" size="icon" onClick={handleShare} aria-label="Share session">
                  <Share2 className="h-5 w-5" />
                </Button>
              </div>

              <div className="mb-4">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground mb-3 pr-28">
                  <FormatIcon className="h-4 w-4 flex-shrink-0" />
                  <span className="capitalize">{session.format}</span>
                  <span className="text-muted-foreground/50 hidden sm:inline">-</span>
                  <Clock className="h-4 w-4 flex-shrink-0" />
                  <span>{session.duration} min</span>
                  <span className="text-muted-foreground/50 hidden sm:inline">-</span>
                  <Badge variant={session.status === 'scheduled' ? 'default' : 'secondary'}>{session.status}</Badge>
                  {session.track && (
                    <>
                      <span className="text-muted-foreground/50 hidden sm:inline">-</span>
                      <span className="flex items-center gap-1.5">
                        {session.track.color && <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: session.track.color }} />}
                        <span>{session.track.name}</span>
                      </span>
                    </>
                  )}
                </div>

                <h1 className="text-2xl sm:text-3xl font-bold mb-4 break-words pr-28">{session.title}</h1>

                {hosts.length === 0 ? (
                  <p className="text-muted-foreground italic">{hostByline(session)}</p>
                ) : (
                  <div className="relative" ref={hostCardRef}>
                    <button
                      onClick={() => setShowHostCard(showHostCard ? null : hosts[0].key)}
                      className="flex items-center gap-2 hover:opacity-80 transition-opacity group text-left"
                    >
                      <div className="flex -space-x-2">
                        {hosts.map((host) => (
                          <div key={host.key} className="h-8 w-8 rounded-full bg-muted flex items-center justify-center overflow-hidden ring-2 ring-background">
                            {host.avatar_url ? (
                              <img src={host.avatar_url} alt={host.display_name || ''} className="h-full w-full object-cover" />
                            ) : (
                              <User className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        ))}
                      </div>
                      <span className="text-muted-foreground">
                        {session.host ? `Hosted by ${hostByline(session)}` : hostByline(session)}
                      </span>
                    </button>

                    {showHostCard && (() => {
                      const active = hosts.find((h) => h.key === showHostCard) || hosts[0]
                      return (
                        <>
                          <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setShowHostCard(null)} />
                          <div className="fixed md:absolute inset-x-4 bottom-4 md:inset-x-auto md:bottom-auto md:left-0 md:top-full md:mt-2 md:w-80 bg-card border rounded-xl shadow-xl z-50 overflow-hidden">
                            <button onClick={() => setShowHostCard(null)} className="absolute top-2 right-2 p-1.5 rounded-full hover:bg-muted transition-colors hidden md:flex" aria-label="Close">
                              <X className="h-4 w-4 text-muted-foreground" />
                            </button>
                            {hosts.length > 1 && (
                              <div className="flex border-b">
                                {hosts.map((host) => (
                                  <button
                                    key={host.key}
                                    onClick={() => setShowHostCard(host.key)}
                                    className={`flex-1 px-3 py-2 text-sm truncate transition-colors ${showHostCard === host.key ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                                  >
                                    {host.display_name || host.role}
                                  </button>
                                ))}
                              </div>
                            )}
                            <div className="p-4 pr-10">
                              <div className="flex items-start gap-3 mb-3">
                                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center overflow-hidden shrink-0">
                                  {active.avatar_url ? (
                                    <img src={active.avatar_url} alt={active.display_name || ''} className="h-full w-full object-cover" />
                                  ) : (
                                    <User className="h-6 w-6 text-muted-foreground" />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <h4 className="font-semibold truncate">{active.display_name || 'A participant'}</h4>
                                  {active.handle && <p className="text-xs text-muted-foreground truncate">@{active.handle}</p>}
                                  {active.affiliation && <p className="text-sm text-muted-foreground truncate">{active.affiliation}</p>}
                                </div>
                              </div>
                              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">{active.role}</p>
                              {active.bio && <p className="text-sm text-muted-foreground mb-3 line-clamp-3">{active.bio}</p>}
                            </div>
                            <button onClick={() => setShowHostCard(null)} className="md:hidden w-full py-3 border-t text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">Close</button>
                          </div>
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>

              {session.topic_tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {session.topic_tags.map((tag) => (
                    <Badge key={tag} variant="secondary">{tag}</Badge>
                  ))}
                </div>
              )}
            </Card>

            {(session.venue || session.time_slot || session.is_self_hosted) && (
              <Card className="p-6 bg-primary/5 border-primary/20">
                <div className="grid sm:grid-cols-2 gap-6">
                  {session.is_self_hosted ? (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <MapPin className="h-5 w-5 text-primary" />
                        <h3 className="font-semibold">Self-Hosted Location</h3>
                      </div>
                      <Badge variant="secondary" className="mb-2">Self-Hosted</Badge>
                      {session.self_hosted_start_time && (
                        <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-1">
                          <Clock className="h-4 w-4" />
                          <span>
                            {formatInZone(session.self_hosted_start_time, event.timezone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            {session.self_hosted_end_time && <> - {formatInZone(session.self_hosted_end_time, event.timezone, { hour: 'numeric', minute: '2-digit' })}</>}
                          </span>
                        </div>
                      )}
                      {session.custom_location ? (
                        <>
                          <p className="text-muted-foreground whitespace-pre-wrap">{session.custom_location}</p>
                          <a
                            href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(session.custom_location)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 text-sm font-medium rounded-md border hover:bg-accent transition-colors"
                          >
                            <MapPin className="h-3.5 w-3.5" />
                            Get Directions
                          </a>
                        </>
                      ) : session.has_private_location ? (
                        <div className="space-y-1">
                          {session.public_place && <p className="text-muted-foreground">{session.public_place}</p>}
                          <p className="text-sm text-muted-foreground flex items-start gap-1.5">
                            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
                            The exact location is shared with confirmed attendees.
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">Location details will be provided by the host</p>
                      )}
                    </div>
                  ) : session.venue && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <MapPin className="h-5 w-5 text-primary" />
                        <h3 className="font-semibold">Location</h3>
                      </div>
                      <p className="text-lg font-medium">{session.venue.name}</p>
                      {session.venue.capacity && <p className="text-sm text-muted-foreground">Capacity: {session.venue.capacity} people</p>}
                      {session.venue.address && (
                        <a
                          href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(session.venue.address)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 text-sm font-medium rounded-md border hover:bg-accent transition-colors"
                        >
                          <MapPin className="h-3.5 w-3.5" />
                          Get Directions
                        </a>
                      )}
                      {session.venue.features.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {session.venue.features.map((feature) => (
                            <Badge key={feature} variant="outline" className="text-xs">{feature}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {session.time_slot && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar className="h-5 w-5 text-primary" />
                        <h3 className="font-semibold">Schedule</h3>
                      </div>
                      <p className="text-lg font-medium">
                        {formatInZone(session.time_slot.start_time, event.timezone, { weekday: 'long', month: 'long', day: 'numeric' })}
                      </p>
                      <p className="text-muted-foreground">
                        {formatInZone(session.time_slot.start_time, event.timezone, { hour: 'numeric', minute: '2-digit' })}
                        {' - '}
                        {formatInZone(session.time_slot.end_time, event.timezone, { hour: 'numeric', minute: '2-digit' })}
                      </p>
                      {session.time_slot.label && <Badge variant="outline" className="mt-2">{session.time_slot.label}</Badge>}
                    </div>
                  )}
                </div>
              </Card>
            )}

            {session.telegram_group_url ? (
              <Card className="p-4">
                <a
                  href={session.telegram_group_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#0088cc] hover:bg-[#006699] text-white rounded-lg transition-colors text-sm font-medium"
                >
                  <Send className="h-4 w-4" />
                  Join Telegram Group
                  <ExternalLink className="h-3.5 w-3.5 ml-auto" />
                </a>
              </Card>
            ) : session.has_telegram_group && !confirmed ? (
              <Card className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                <Lock className="h-4 w-4 shrink-0" />
                This session has a Telegram group for confirmed attendees.
              </Card>
            ) : null}

            <Card className="p-6 overflow-hidden">
              <h2 className="text-xl font-semibold mb-4">About This Session</h2>
              <div className="prose prose-sm max-w-none break-words">
                {session.description ? (
                  session.description.split('\n').map((paragraph, i) => (
                    <p key={i} className="text-muted-foreground mb-3">{paragraph}</p>
                  ))
                ) : (
                  <p className="text-muted-foreground italic">No description provided.</p>
                )}
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">Session Format</h2>
              <div className="flex items-start gap-4">
                <div className="p-3 rounded-lg bg-primary/10">
                  <FormatIcon className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-medium capitalize">{session.format}</h3>
                  <p className="text-sm text-muted-foreground">{formatDescriptions[session.format ?? ''] || 'Interactive session'}</p>
                </div>
              </div>
            </Card>

            {sessionHasStarted && <SessionFeedback sessionId={sessionId} eventSlug={event.slug} />}
          </div>

          <div className="space-y-6">
            {votingOpen && session.status !== 'rejected' && session.status !== 'pending' && (
              <Card className="p-6">
                <h3 className="font-semibold mb-4">Your votes</h3>
                <VoteControl eventSlug={event.slug} sessionId={sessionId} sessionTitle={session.title} />
              </Card>
            )}

            <Card className="p-6">
              <h3 className="font-semibold mb-4">Quick Actions</h3>
              <div className="space-y-2">
                {viewer.can_edit && (
                  <Button className="w-full justify-start" variant="outline" onClick={() => setShowEditModal(true)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit Session
                  </Button>
                )}
                <Button className="w-full justify-start" variant={session.is_favorite ? 'default' : 'outline'} onClick={handleToggleFavorite}>
                  <Heart className={`h-4 w-4 mr-2 ${session.is_favorite ? 'fill-current' : ''}`} />
                  {session.is_favorite ? 'Saved to My Schedule' : 'Add to My Schedule'}
                </Button>
                <Button className="w-full justify-start" variant="outline" onClick={handleShare}>
                  <Share2 className="h-4 w-4 mr-2" />
                  Share Session
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
                  />
                )}
                {session.status === 'scheduled' && (
                  <RSVPButton
                    sessionId={sessionId}
                    rsvpCount={session.rsvp_count}
                    waitlistCount={session.waitlist_count}
                    capacity={session.venue?.capacity ?? null}
                    initialStatus={session.my_rsvp?.status ?? null}
                    initialWaitlistPosition={session.my_rsvp?.waitlist_position ?? null}
                    variant="outline"
                    showCapacity
                    onRSVPChange={() => refresh()}
                  />
                )}
                {viewer.can_edit && !session.telegram_group_url && (
                  <Button className="w-full justify-start gap-2" variant="outline" onClick={() => setShowEditModal(true)}>
                    <Send className="h-4 w-4" />
                    Add Telegram Group
                  </Button>
                )}
                {viewer.is_host && (
                  <Button
                    className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
                    variant="outline"
                    onClick={() => setShowWithdrawConfirm(true)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Withdraw Proposal
                  </Button>
                )}
              </div>
            </Card>

            <SessionResources sessionId={sessionId} eventSlug={event.slug} canManage={viewer.can_manage} />

            <AtprotoSessionActions
              sessionId={sessionId}
              eventSlug={event.slug}
              signedIn={!!user}
              userRsvpStatus={session.my_rsvp?.status ?? null}
            />

            {(viewer.is_host || viewer.is_cohost || viewer.is_organizer) && (
              <ManageCohostsSection
                sessionId={sessionId}
                cohosts={session.cohosts}
                isHost={viewer.is_host}
                isOrganizer={viewer.is_organizer}
                onCohostsChange={refresh}
              />
            )}

            {showWithdrawConfirm && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4" onClick={() => setShowWithdrawConfirm(false)}>
                <div role="dialog" aria-modal="true" aria-labelledby="withdraw-title" className="w-full max-w-md bg-card border rounded-xl shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-3 rounded-full bg-destructive/10">
                      <AlertTriangle className="h-6 w-6 text-destructive" />
                    </div>
                    <div>
                      <h3 id="withdraw-title" className="font-semibold text-lg">Withdraw proposal</h3>
                      <p className="text-sm text-muted-foreground">This cannot be undone</p>
                    </div>
                  </div>
                  <p className="text-muted-foreground mb-6">
                    Withdraw &ldquo;<span className="font-medium text-foreground">{session.title}</span>&rdquo;? Its public record is deleted
                    from your repository (copies may persist on the network).{' '}
                    {session.status === 'scheduled'
                      ? 'It is already on the schedule, so the organizers will decide what happens to its slot.'
                      : 'The session, its favorites and RSVPs are removed from this gathering.'}
                  </p>
                  <div className="flex gap-3">
                    <Button variant="outline" className="flex-1" onClick={() => setShowWithdrawConfirm(false)} disabled={isWithdrawing}>Cancel</Button>
                    <Button variant="destructive" className="flex-1" onClick={handleWithdraw} disabled={isWithdrawing}>
                      {isWithdrawing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                      Withdraw
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {showShareToast && (
              <div className="fixed bottom-4 right-4 bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-lg text-sm">
                Link copied to clipboard!
              </div>
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
