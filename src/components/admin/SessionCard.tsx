'use client'

import * as React from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import {
  AlertTriangle,
  Check,
  X,
  Calendar,
  MapPin,
  Clock,
  ChevronDown,
  ChevronUp,
  Globe,
  Trash2,
  Mail,
  MailCheck,
  ExternalLink,
  ThumbsUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { sessionStatusBadge } from '@/lib/labels'
import { plural } from '@/lib/format'
import { hostLabel, type AdminSession, type AdminTimeSlot, type AdminVenue, type SessionResult } from './types'

interface SessionCardProps {
  session: AdminSession
  eventSlug: string
  timezone: string
  venues?: Pick<AdminVenue, 'id' | 'name' | 'capacity'>[]
  timeSlots?: Pick<AdminTimeSlot, 'id' | 'venue_id' | 'label' | 'start_time' | 'end_time' | 'is_break' | 'sessions'>[]
  /** Only after the round closes. */
  result?: SessionResult | null
  busy?: boolean
  onApprove?: () => void
  onReject?: () => void
  onSchedule?: (timeSlotId: string) => void
  onUnschedule?: () => void
  onDelete?: () => void
  onNotify?: () => void
}

/** "monday_am" → "Monday AM". */
const formatPref = (pref: string) => pref.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ (Am|Pm)$/, (m) => m.toUpperCase())

export function SessionCard({
  session,
  eventSlug,
  timezone,
  venues = [],
  timeSlots = [],
  result = null,
  busy = false,
  onApprove,
  onReject,
  onSchedule,
  onUnschedule,
  onDelete,
  onNotify,
}: SessionCardProps) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  const [showScheduler, setShowScheduler] = React.useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false)
  const [selectedVenue, setSelectedVenue] = React.useState('')
  const [selectedTimeSlot, setSelectedTimeSlot] = React.useState('')

  const isPending = session.status === 'pending'
  const isApproved = session.status === 'approved'
  const isScheduled = session.status === 'scheduled'
  const isRejected = session.status === 'rejected'
  const host = hostLabel(session)
  const status = sessionStatusBadge(session.status)

  const formatSlot = (slot: { label: string | null; start_time: string; end_time: string }) => {
    const start = new Date(slot.start_time)
    const end = new Date(slot.end_time)
    const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone })
    const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone })
    return `${day} ${time(start)}–${time(end)}${slot.label ? ` · ${slot.label}` : ''}`
  }

  const freeSlots = timeSlots.filter((t) => t.venue_id === selectedVenue && !t.is_break && t.sessions.length === 0)

  const handleSchedule = () => {
    if (selectedTimeSlot && onSchedule) {
      onSchedule(selectedTimeSlot)
      setShowScheduler(false)
      setSelectedVenue('')
      setSelectedTimeSlot('')
    }
  }

  return (
    <Card className={cn('transition-all', isRejected && 'opacity-60', isScheduled && 'border-success/30 bg-success/5')}>
      <CardContent className="p-4 sm:p-5">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={status.badge}>{status.label}</Badge>
                {session.format && (
                  <Badge variant="secondary" className="capitalize">
                    {session.format}
                  </Badge>
                )}
                {session.duration && <span className="text-xs text-muted-foreground">{session.duration} min</span>}
                {result && (
                  <span className="text-xs font-medium text-primary flex items-center gap-1" title="Votes in the closed round">
                    <ThumbsUp className="h-3 w-3" aria-hidden="true" />
                    {result.votes}
                  </span>
                )}
                {session.network_published && (
                  <Badge variant="outline" className="gap-1"><Globe className="h-3 w-3" aria-hidden="true" />Published</Badge>
                )}
                {isScheduled && session.host_id && (
                  session.host_notified_at ? (
                    <Badge variant="success" className="gap-1">
                      <MailCheck className="h-3 w-3" aria-hidden="true" />
                      Host emailed
                    </Badge>
                  ) : (
                    <Badge variant="amber" className="gap-1">
                      <Mail className="h-3 w-3" aria-hidden="true" />
                      Host not emailed
                    </Badge>
                  )
                )}
              </div>
              <h3 className="font-semibold line-clamp-1">{session.title}</h3>
              {host && <p className="text-sm text-muted-foreground">{session.host_id ? `by ${host}` : host}</p>}
              {session.proposal_withdrawn_at ? (
                <p role="status" className="text-sm text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Withdrawn by the proposer. Cancel the session or fill its slot.
                </p>
              ) : session.proposal_drift_at ? (
                <p role="status" className="text-sm text-signal-amber flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  The proposer edited this session; review and re-publish.
                </p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex-shrink-0"
              aria-label={isExpanded ? `Collapse ${session.title}` : `Expand ${session.title}`}
              aria-expanded={isExpanded}
            >
              {isExpanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>

          {isScheduled && (session.venue || session.time_slot) && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-sm bg-success/10 rounded-lg p-3">
              {session.venue && (
                <div className="flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-success flex-shrink-0" aria-hidden="true" />
                  <span>{session.venue.name}</span>
                </div>
              )}
              {session.time_slot && (
                <div className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4 text-success flex-shrink-0" aria-hidden="true" />
                  <span>{formatSlot(session.time_slot)}</span>
                </div>
              )}
            </div>
          )}

          {isExpanded && (
            <div className="pt-2 space-y-3 border-t">
              {session.description && <p className="text-sm text-muted-foreground">{session.description}</p>}
              {session.listed_host_name && !session.host_id && (
                <p className="text-xs text-muted-foreground">
                  Listed as {session.listed_host_name} (unclaimed). Visible to organizers only; never published.
                </p>
              )}
              {session.rejection_reason && isRejected && (
                <p className="text-sm text-muted-foreground">Reason given: {session.rejection_reason}</p>
              )}
              {session.cohost_count > 0 && (
                <p className="text-xs text-muted-foreground">{plural(session.cohost_count, 'co-host')}</p>
              )}
              {session.topic_tags && session.topic_tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {session.topic_tags.map((tag) => (
                    <Badge key={tag} variant="outline">{tag}</Badge>
                  ))}
                </div>
              )}
              {session.time_preferences && session.time_preferences.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">Prefers:</span>
                  {session.time_preferences.map((pref) => (
                    <Badge key={pref} variant="muted">{formatPref(pref)}</Badge>
                  ))}
                </div>
              )}
              <Link href={`/e/${eventSlug}/sessions/${session.id}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                View full session
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          )}

          {isApproved && showScheduler && (
            <div className="pt-3 border-t space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`venue-${session.id}`}>Room</Label>
                  <Select
                    id={`venue-${session.id}`}
                    value={selectedVenue}
                    onChange={(e) => { setSelectedVenue(e.target.value); setSelectedTimeSlot('') }}
                  >
                    <option value="">Select a room…</option>
                    {venues.map((venue) => (
                      <option key={venue.id} value={venue.id}>
                        {venue.name}{venue.capacity ? ` (${venue.capacity})` : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`slot-${session.id}`}>Free time slot</Label>
                  <Select
                    id={`slot-${session.id}`}
                    value={selectedTimeSlot}
                    onChange={(e) => setSelectedTimeSlot(e.target.value)}
                    disabled={!selectedVenue}
                  >
                    <option value="">{selectedVenue && freeSlots.length === 0 ? 'No free slots in this room' : 'Select a time…'}</option>
                    {freeSlots.map((slot) => (
                      <option key={slot.id} value={slot.id}>{formatSlot(slot)}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowScheduler(false)}>Cancel</Button>
                <Button size="sm" onClick={handleSchedule} disabled={!selectedTimeSlot || busy}>
                  <Check className="h-4 w-4 mr-1" aria-hidden="true" />
                  Schedule
                </Button>
              </div>
            </div>
          )}

          {showDeleteConfirm ? (
            <ConfirmInline
              layout="inline"
              destructive
              message={<>Delete &ldquo;{session.title}&rdquo; permanently?</>}
              confirmLabel="Delete"
              loading={busy}
              onConfirm={() => { onDelete?.(); setShowDeleteConfirm(false) }}
              onCancel={() => setShowDeleteConfirm(false)}
            />
          ) : (
            <div className="flex gap-2 pt-2 border-t flex-wrap">
              {isPending && (
                <>
                  <Button size="sm" variant="outline" onClick={onReject} disabled={busy || !onReject} className="flex-1 sm:flex-none text-destructive hover:text-destructive">
                    <X className="h-4 w-4 mr-1" aria-hidden="true" />
                    Reject
                  </Button>
                  <Button size="sm" onClick={onApprove} disabled={busy || !onApprove} className="flex-1 sm:flex-none">
                    <Check className="h-4 w-4 mr-1" aria-hidden="true" />
                    Approve
                  </Button>
                </>
              )}
              {isApproved && !showScheduler && onSchedule && (
                <Button size="sm" onClick={() => setShowScheduler(true)} disabled={busy} className="flex-1 sm:flex-none">
                  <Calendar className="h-4 w-4 mr-1" aria-hidden="true" />
                  Quick schedule
                </Button>
              )}
              {isScheduled && (
                <>
                  {onUnschedule && !session.network_published && (
                    <Button size="sm" variant="outline" onClick={onUnschedule} disabled={busy} className="flex-1 sm:flex-none">Unschedule</Button>
                  )}
                  {session.network_published && (
                    <Button size="sm" variant="outline" asChild className="flex-1 sm:flex-none">
                      <Link href={`/e/${eventSlug}/admin/schedule`}>Open schedule builder</Link>
                    </Button>
                  )}
                  {!session.host_notified_at && session.host_id && onNotify && (
                    <Button size="sm" variant="outline" onClick={onNotify} disabled={busy} className="flex-1 sm:flex-none">
                      <Mail className="h-4 w-4 mr-1" aria-hidden="true" />
                      Email host
                    </Button>
                  )}
                </>
              )}
              {!isRejected && onDelete && !session.network_published && (
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={busy}
                  aria-label={`Delete ${session.title}`}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 sm:ml-auto"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
