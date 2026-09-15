'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Building,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit2,
  Globe,
  Loader2,
  MapPin,
  Plus,
  Trash2,
  Users as UsersIcon,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { getEventDayLabel, getEventDays } from '@/lib/events/dates'
import { cn } from '@/lib/utils'
import { BulkSlotGenerator, type GeneratedSlot } from '@/components/admin/BulkSlotGenerator'
import { networkNotice, type AdminTimeSlot, type AdminVenue, type NetworkSync } from '@/components/admin/types'

/** Form values: wall-clock times ("HH:mm") on an event day, in the event timezone. */
interface SlotInput {
  venueId: string
  dayDate: string
  startTime: string
  endTime: string
  label: string
  slotType: string
}

const SLOT_TYPE_OPTIONS = [
  { value: 'session', label: 'Session' },
  { value: 'unconference', label: 'Unconference' },
  { value: 'track', label: 'Track' },
  { value: 'break', label: 'Break' },
  { value: 'checkin', label: 'Check-in' },
]

interface VenueForm {
  name: string
  slug: string
  capacity: string
  features: string
  address: string
  locality: string
  region: string
  postal_code: string
  country: string
  is_private_residence: boolean
  is_primary: boolean
}

const EMPTY_VENUE: VenueForm = {
  name: '', slug: '', capacity: '', features: '', address: '', locality: '', region: '', postal_code: '', country: '',
  is_private_residence: false, is_primary: false,
}

/** Wall-clock parts of an instant in the event timezone. */
function toEventLocalParts(iso: string, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

const slotBody = (slot: SlotInput) => ({
  venue_id: slot.venueId,
  day_date: slot.dayDate,
  start: slot.startTime,
  end: slot.endTime,
  label: slot.label || null,
  slot_type: slot.slotType,
})

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export default function AdminSetupPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const canManage = can('manageVenues')
  const base = `/api/v1/events/${event.slug}/admin`

  const eventDays = React.useMemo(
    () => getEventDays(event.startDate, event.endDate).map((date) => ({ date, label: getEventDayLabel(date, event.timezone) })),
    [event.startDate, event.endDate, event.timezone],
  )

  const [venues, setVenues] = React.useState<AdminVenue[]>([])
  const [timeSlots, setTimeSlots] = React.useState<AdminTimeSlot[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [isSaving, setIsSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)

  const [showVenueForm, setShowVenueForm] = React.useState(false)
  const [editingVenue, setEditingVenue] = React.useState<AdminVenue | null>(null)
  const [venueForm, setVenueForm] = React.useState<VenueForm>(EMPTY_VENUE)
  const [venueError, setVenueError] = React.useState<string | null>(null)
  const [confirmDeleteVenue, setConfirmDeleteVenue] = React.useState<string | null>(null)
  const [expandedVenues, setExpandedVenues] = React.useState<Set<string>>(new Set())
  const [showBulkGenerator, setShowBulkGenerator] = React.useState(false)

  React.useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 5000)
    return () => window.clearTimeout(timer)
  }, [status])

  const reportNetwork = (sync: NetworkSync | undefined, success: string) => {
    const warning = networkNotice(sync)
    if (warning) setError(warning)
    else setStatus(success)
  }

  const load = React.useCallback(async () => {
    try {
      const [v, t] = await Promise.all([
        apiFetch<{ venues: AdminVenue[] }>(`${base}/venues`),
        apiFetch<{ timeSlots: AdminTimeSlot[] }>(`${base}/time-slots`),
      ])
      setVenues(v.venues)
      setTimeSlots(t.timeSlots)
    } catch (e) {
      setError(errorText(e, 'Could not load rooms and availability. Refresh to try again.'))
    } finally {
      setIsLoading(false)
    }
  }, [base])

  React.useEffect(() => { void load() }, [load])

  const refreshVenues = async () => {
    const v = await apiFetch<{ venues: AdminVenue[] }>(`${base}/venues`)
    setVenues(v.venues)
  }

  const resetVenueForm = () => {
    setShowVenueForm(false)
    setEditingVenue(null)
    setVenueForm(EMPTY_VENUE)
    setVenueError(null)
  }

  const startEditVenue = (venue: AdminVenue) => {
    setEditingVenue(venue)
    setVenueForm({
      name: venue.name,
      slug: venue.slug ?? '',
      capacity: venue.capacity?.toString() ?? '',
      features: venue.features.join(', '),
      address: venue.address ?? '',
      locality: venue.locality ?? '',
      region: venue.region ?? '',
      postal_code: venue.postal_code ?? '',
      country: venue.country ?? '',
      is_private_residence: venue.is_private_residence,
      is_primary: venue.is_primary,
    })
    setVenueError(null)
    setShowVenueForm(true)
  }

  const saveVenue = async () => {
    if (isSaving) return
    setVenueError(null)
    if (!venueForm.name.trim()) { setVenueError('Enter a room name.'); return }
    if (venueForm.capacity && (!Number.isInteger(Number(venueForm.capacity)) || Number(venueForm.capacity) <= 0)) {
      setVenueError('Capacity must be a positive whole number.')
      return
    }
    setIsSaving(true)
    const body = {
      name: venueForm.name.trim(),
      slug: venueForm.slug.trim() || null,
      capacity: venueForm.capacity ? Number(venueForm.capacity) : null,
      features: venueForm.features.split(',').map((f) => f.trim()).filter(Boolean),
      address: venueForm.address.trim() || null,
      locality: venueForm.locality.trim() || null,
      region: venueForm.region.trim() || null,
      postal_code: venueForm.postal_code.trim() || null,
      country: venueForm.country.trim() || null,
      is_private_residence: venueForm.is_private_residence,
      is_primary: venueForm.is_primary,
    }
    try {
      const res = editingVenue
        ? await apiFetch<{ venue: AdminVenue; network: NetworkSync }>(`${base}/venues/${editingVenue.id}`, { method: 'PATCH', json: body })
        : await apiFetch<{ venue: AdminVenue; network: NetworkSync }>(`${base}/venues`, { method: 'POST', json: body })
      await refreshVenues()
      resetVenueForm()
      reportNetwork(res.network, editingVenue ? 'Room updated.' : 'Room added.')
    } catch (e) {
      setVenueError(errorText(e, 'Could not save this room.'))
    } finally {
      setIsSaving(false)
    }
  }

  const deleteVenue = async (id: string) => {
    setConfirmDeleteVenue(null)
    setIsSaving(true)
    setError(null)
    try {
      const res = await apiFetch<{ unscheduled: number; network: { venues: NetworkSync; grids: NetworkSync } }>(`${base}/venues/${id}`, { method: 'DELETE' })
      setVenues((prev) => prev.filter((v) => v.id !== id))
      setTimeSlots((prev) => prev.filter((t) => t.venue_id !== id))
      reportNetwork(res.network.venues.error ? res.network.venues : res.network.grids, res.unscheduled
        ? `Room removed. ${res.unscheduled} session${res.unscheduled === 1 ? '' : 's'} went back to the unscheduled tray.`
        : 'Room removed.')
    } catch (e) {
      setError(errorText(e, 'Could not remove this room.'))
    } finally {
      setIsSaving(false)
    }
  }

  const createSlots = async (slots: SlotInput[]): Promise<string | null> => {
    if (isSaving) return 'Another change is still saving.'
    setIsSaving(true)
    setError(null)
    try {
      const res = await apiFetch<{ timeSlots: AdminTimeSlot[]; network: NetworkSync }>(`${base}/time-slots`, {
        method: 'POST',
        json: { slots: slots.map(slotBody) },
      })
      setTimeSlots((prev) => [...prev, ...res.timeSlots].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time)))
      await refreshVenues()
      reportNetwork(res.network, `Saved ${res.timeSlots.length} time slot${res.timeSlots.length === 1 ? '' : 's'}.`)
      return null
    } catch (e) {
      return errorText(e, 'Could not save this availability.')
    } finally {
      setIsSaving(false)
    }
  }

  /** Resolves to null on success, or a message; `needsConfirm` carries the sessions that would move. */
  const updateSlot = async (id: string, slot: SlotInput, confirmAssigned: boolean): Promise<{ error: string | null; needsConfirm?: boolean }> => {
    if (isSaving) return { error: 'Another change is still saving.' }
    setIsSaving(true)
    try {
      const res = await apiFetch<{ timeSlot: AdminTimeSlot; network: NetworkSync }>(`${base}/time-slots/${id}`, {
        method: 'PATCH',
        json: { ...slotBody(slot), confirm_assigned: confirmAssigned },
      })
      setTimeSlots((prev) => prev.map((t) => (t.id === id ? res.timeSlot : t)).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time)))
      await refreshVenues()
      reportNetwork(res.network, 'Time slot updated.')
      return { error: null }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SlotHasSessions') return { error: e.message, needsConfirm: true }
      return { error: errorText(e, 'Could not update this availability.') }
    } finally {
      setIsSaving(false)
    }
  }

  const deleteSlot = async (id: string, confirmed: boolean): Promise<{ error: string | null; needsConfirm?: boolean }> => {
    if (isSaving) return { error: 'Another change is still saving.' }
    setIsSaving(true)
    try {
      const res = await apiFetch<{ unscheduled: number; network: NetworkSync }>(`${base}/time-slots/${id}${confirmed ? '?confirm=1' : ''}`, { method: 'DELETE' })
      setTimeSlots((prev) => prev.filter((t) => t.id !== id))
      await refreshVenues()
      reportNetwork(res.network, res.unscheduled ? `Slot removed; ${res.unscheduled} session${res.unscheduled === 1 ? '' : 's'} went back to the tray.` : 'Slot removed.')
      return { error: null }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SlotHasSessions') return { error: e.message, needsConfirm: true }
      return { error: errorText(e, 'Could not remove this availability.') }
    } finally {
      setIsSaving(false)
    }
  }

  const handleBulkGenerate = async (slots: GeneratedSlot[]) => {
    const message = await createSlots(slots.map((s) => ({ venueId: s.venueId, dayDate: s.dayDate, startTime: s.startTime, endTime: s.endTime, label: s.label, slotType: s.isBreak ? 'break' : 'session' })))
    if (message) setError(message)
    else setShowBulkGenerator(false)
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-12" role="status" aria-label="Loading"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  const field = (key: keyof VenueForm, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-2">
      <label htmlFor={`venue-${key}`} className="text-sm font-medium">{label}</label>
      <Input
        id={`venue-${key}`}
        value={venueForm[key] as string}
        onChange={(e) => setVenueForm((f) => ({ ...f, [key]: e.target.value }))}
        {...props}
      />
    </div>
  )

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}
      {status && <div role="status" className="rounded-xl border border-primary/30 bg-card p-4 text-sm">{status}</div>}

      <div>
        <h1 className="font-semibold">Spaces &amp; times</h1>
        <p className="text-muted-foreground mt-2">Give your gathering a place to happen.</p>
      </div>

      <Card className="bg-muted/30">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            Add rooms and their availability. Times are in the event&rsquo;s timezone ({event.timezone}). Then use the{' '}
            <Link href={`/e/${event.slug}/admin/schedule`} className="text-primary hover:underline font-medium">Schedule builder</Link> to place sessions.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2"><MapPin className="h-5 w-5" />Rooms &amp; availability</h2>
        {canManage && (
          <div className="flex gap-2">
            <Button onClick={() => { resetVenueForm(); setShowVenueForm(true) }} disabled={showVenueForm} className="flex-1 sm:flex-none"><Plus className="h-4 w-4 mr-2" />Add room</Button>
            {venues.length > 0 && (
              <Button variant="outline" onClick={() => setShowBulkGenerator(true)} disabled={showBulkGenerator} className="flex-1 sm:flex-none">
                <Zap className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Generate slots</span>
                <span className="sm:hidden">Slots</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {showBulkGenerator && venues.length > 0 && (
        <Card className="border-primary/50">
          <CardHeader><CardTitle className="text-lg">Generate time slots</CardTitle></CardHeader>
          <CardContent>
            <BulkSlotGenerator
              venues={venues.map((v) => ({ id: v.id, name: v.name, capacity: v.capacity }))}
              eventDays={eventDays}
              existingSlots={timeSlots.filter(slot => slot.venue_id).map(slot => ({
                venueId: slot.venue_id!, dayDate: toEventLocalParts(slot.start_time, event.timezone).date,
                startTime: toEventLocalParts(slot.start_time, event.timezone).time,
                endTime: toEventLocalParts(slot.end_time, event.timezone).time,
              }))}
              onGenerate={handleBulkGenerate}
              isSaving={isSaving}
              onCancel={() => setShowBulkGenerator(false)}
            />
          </CardContent>
        </Card>
      )}

      {showVenueForm && (
        <Card className="border-primary/50">
          <CardHeader><CardTitle className="text-lg">{editingVenue ? 'Edit room' : 'New room'}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {field('name', 'Name *', { placeholder: 'e.g., Main Hall', maxLength: 100 })}
              {field('slug', 'Short name', { placeholder: 'Generated from the name if empty', maxLength: 60 })}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {field('capacity', 'Capacity', { type: 'number', min: 1, placeholder: 'e.g., 100' })}
              <div className="space-y-2">
                <span className="text-sm font-medium">Type</span>
                <label className="flex items-center gap-2 h-10 cursor-pointer">
                  <input type="checkbox" checked={venueForm.is_primary} onChange={(e) => setVenueForm((f) => ({ ...f, is_primary: e.target.checked }))} className="rounded" />
                  <span className="text-sm">Primary room (main stage)</span>
                </label>
              </div>
            </div>
            {field('address', 'Street address', { placeholder: 'e.g., 1600 Walnut St', maxLength: 300 })}
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
              {field('locality', 'City or neighbourhood', { maxLength: 100 })}
              {field('region', 'Region', { maxLength: 100 })}
              {field('postal_code', 'Postal code', { maxLength: 20 })}
              {field('country', 'Country (2 letters)', { maxLength: 2, placeholder: 'US' })}
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={venueForm.is_private_residence} onChange={(e) => setVenueForm((f) => ({ ...f, is_private_residence: e.target.checked }))} className="rounded mt-0.5" />
              <span>This is a private home. <span className="text-muted-foreground">The public calendar shows only the city or neighbourhood, never the street address.</span></span>
            </label>
            {field('features', 'Features (comma-separated)', { placeholder: 'e.g., projector, whiteboard, round tables' })}
            {venueError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{venueError}</p>}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={resetVenueForm} disabled={isSaving}>Cancel</Button>
              <Button onClick={() => void saveVenue()} disabled={!venueForm.name.trim() || isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                {editingVenue ? 'Update' : 'Create'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {venues.map((venue) => {
          const venueSlots = timeSlots.filter((t) => t.venue_id === venue.id)
          const isExpanded = expandedVenues.has(venue.id)
          return (
            <Card key={venue.id}>
              <CardContent className="p-4">
                <div className="space-y-3">
                  <div className="space-y-2 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Building className="h-5 w-5 text-primary flex-shrink-0" aria-hidden />
                      <h3 className="font-semibold">{venue.name}</h3>
                      {venue.is_primary && <Badge variant="default" className="text-xs">Primary</Badge>}
                      {venue.is_private_residence && <Badge variant="outline" className="text-xs">Private home</Badge>}
                      {venue.network_published && <Badge variant="outline" className="text-xs gap-1"><Globe className="h-3 w-3" />On the network</Badge>}
                    </div>
                    <div className="flex items-center gap-3 sm:gap-4 text-sm text-muted-foreground flex-wrap">
                      {venue.capacity && <span className="flex items-center gap-1"><UsersIcon className="h-4 w-4" />{venue.capacity} cap</span>}
                      <span className="flex items-center gap-1"><Clock className="h-4 w-4" />{venue.slot_count} slots</span>
                      <span>{venue.scheduled_count} scheduled</span>
                    </div>
                    {venue.features.length > 0 && (
                      <div className="flex flex-wrap gap-1">{venue.features.map((feature) => <Badge key={feature} variant="secondary" className="text-xs">{feature}</Badge>)}</div>
                    )}
                  </div>
                  {confirmDeleteVenue === venue.id ? (
                    <div role="alertdialog" aria-label={`Remove ${venue.name}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      <span>Remove {venue.name} and its {venue.slot_count} time slot{venue.slot_count === 1 ? '' : 's'}?{venue.scheduled_count ? ` ${venue.scheduled_count} scheduled session${venue.scheduled_count === 1 ? '' : 's'} will go back to the tray.` : ''}</span>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setConfirmDeleteVenue(null)}>Keep</Button>
                        <Button size="sm" variant="destructive" onClick={() => void deleteVenue(venue.id)} disabled={isSaving}>Remove</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1 flex-wrap sm:flex-nowrap pt-2 border-t">
                      <Button size="sm" variant="ghost" onClick={() => setExpandedVenues((prev) => { const next = new Set(prev); if (next.has(venue.id)) next.delete(venue.id); else next.add(venue.id); return next })} className="flex-1 sm:flex-none" aria-expanded={isExpanded}>
                        <Calendar className="h-4 w-4 mr-1" />
                        Availability
                        {isExpanded ? <ChevronUp className="h-4 w-4 ml-1" /> : <ChevronDown className="h-4 w-4 ml-1" />}
                      </Button>
                      {canManage && (
                        <>
                          <Button size="icon" variant="ghost" onClick={() => startEditVenue(venue)} className="h-9 w-9" aria-label={`Edit ${venue.name}`}><Edit2 className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive h-9 w-9" onClick={() => setConfirmDeleteVenue(venue.id)} aria-label={`Remove ${venue.name}`}><Trash2 className="h-4 w-4" /></Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {isExpanded && (
                  <div className="mt-4 pt-4 border-t">
                    <VenueAvailabilityEditor
                      venue={venue}
                      venues={venues}
                      slots={venueSlots}
                      eventDays={eventDays}
                      timezone={event.timezone}
                      canManage={canManage}
                      isSaving={isSaving}
                      onCreate={createSlots}
                      onUpdate={updateSlot}
                      onDelete={deleteSlot}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {venues.length === 0 && !showVenueForm && (
        <Card>
          <CardContent className="py-12 text-center">
            <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" aria-hidden />
            <h3 className="font-semibold mb-2">No rooms yet</h3>
            <p className="text-muted-foreground mb-4">Add your first room to start building the schedule</p>
            {canManage && <Button onClick={() => setShowVenueForm(true)}><Plus className="h-4 w-4 mr-2" />Add room</Button>}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function VenueAvailabilityEditor({
  venue,
  venues,
  slots,
  eventDays,
  timezone,
  canManage,
  isSaving,
  onCreate,
  onUpdate,
  onDelete,
}: {
  venue: AdminVenue
  venues: AdminVenue[]
  slots: AdminTimeSlot[]
  eventDays: { date: string; label: string }[]
  timezone: string
  canManage: boolean
  isSaving: boolean
  onCreate: (slots: SlotInput[]) => Promise<string | null>
  onUpdate: (id: string, slot: SlotInput, confirmAssigned: boolean) => Promise<{ error: string | null; needsConfirm?: boolean }>
  onDelete: (id: string, confirmed: boolean) => Promise<{ error: string | null; needsConfirm?: boolean }>
}) {
  const [selectedDay, setSelectedDay] = React.useState(eventDays[0]?.date || '')
  const [showAddForm, setShowAddForm] = React.useState(false)
  const [addError, setAddError] = React.useState<string | null>(null)
  const [editingSlot, setEditingSlot] = React.useState<AdminTimeSlot | null>(null)
  const [editError, setEditError] = React.useState<string | null>(null)
  const [editNeedsConfirm, setEditNeedsConfirm] = React.useState(false)
  const [deleting, setDeleting] = React.useState<{ id: string; message: string | null; needsConfirm: boolean } | null>(null)

  const daySlots = slots.filter((s) => s.day_date === selectedDay).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone })

  const editingInitial = React.useMemo<SlotInput | null>(() => {
    if (!editingSlot) return null
    const start = toEventLocalParts(editingSlot.start_time, timezone)
    const end = toEventLocalParts(editingSlot.end_time, timezone)
    return {
      venueId: editingSlot.venue_id || venue.id,
      dayDate: editingSlot.day_date || start.date,
      startTime: start.time,
      endTime: end.time,
      label: editingSlot.label || '',
      slotType: editingSlot.slot_type || (editingSlot.is_break ? 'break' : 'session'),
    }
  }, [editingSlot, timezone, venue.id])

  const cancelEdit = () => {
    setEditingSlot(null)
    setEditError(null)
    setEditNeedsConfirm(false)
  }

  const submitEdit = async (input: SlotInput) => {
    if (!editingSlot) return
    const res = await onUpdate(editingSlot.id, input, editNeedsConfirm)
    if (res.error) {
      setEditError(res.error)
      setEditNeedsConfirm(Boolean(res.needsConfirm))
      return
    }
    cancelEdit()
  }

  const submitAdd = async (input: SlotInput) => {
    setAddError(null)
    const message = await onCreate([input])
    if (message) setAddError(message)
    else setShowAddForm(false)
  }

  const requestDelete = async (slot: AdminTimeSlot, confirmed: boolean) => {
    if (!confirmed) {
      setDeleting({
        id: slot.id,
        needsConfirm: slot.sessions.length > 0,
        message: slot.sessions.length > 0
          ? `${slot.sessions.length} session${slot.sessions.length === 1 ? ' is' : 's are'} scheduled here (${slot.sessions.map((s) => s.title).join(', ')}) and will go back to the tray.`
          : null,
      })
      return
    }
    const res = await onDelete(slot.id, deleting?.needsConfirm ?? false)
    if (res.error) setDeleting({ id: slot.id, message: res.error, needsConfirm: Boolean(res.needsConfirm) })
    else setDeleting(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {eventDays.map((day) => (
          <Button key={day.date} variant={selectedDay === day.date ? 'default' : 'outline'} size="sm" onClick={() => setSelectedDay(day.date)} aria-pressed={selectedDay === day.date} className="whitespace-nowrap flex-shrink-0">{day.label}</Button>
        ))}
      </div>

      <div className="space-y-2">
        {daySlots.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No time slots for this day. Add availability below.</p>
        ) : (
          daySlots.map((slot) =>
            editingSlot?.id === slot.id && editingInitial ? (
              <SlotForm key={slot.id} mode="edit" initial={editingInitial} venues={venues} eventDays={eventDays} isSaving={isSaving} error={editError} confirmLabel={editNeedsConfirm ? 'Confirm and save' : undefined} sessionTitles={slot.sessions.map((s) => s.title)} onSubmit={submitEdit} onCancel={cancelEdit} />
            ) : (
              <div key={slot.id} className={cn('rounded-lg border p-3 space-y-2', slot.is_break ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800' : 'bg-muted/30')}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap flex-1 min-w-0">
                    <div className="text-sm whitespace-nowrap">{formatTime(slot.start_time)} - {formatTime(slot.end_time)}</div>
                    <Badge variant={slot.is_break ? 'secondary' : 'outline'} className="text-xs capitalize">{slot.is_break ? 'Break' : slot.slot_type || 'session'}</Badge>
                    {slot.label && <span className="text-sm text-muted-foreground truncate">{slot.label}</span>}
                    {slot.sessions.length > 0 && <span className="text-xs text-muted-foreground truncate">· {slot.sessions.map((s) => s.title).join(', ')}</span>}
                  </div>
                  {canManage && (
                    <div className="flex gap-1 flex-shrink-0">
                      <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => { setShowAddForm(false); setDeleting(null); setEditError(null); setEditNeedsConfirm(false); setEditingSlot(slot) }} disabled={isSaving} aria-label={`Edit ${formatTime(slot.start_time)} slot`}><Edit2 className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" className="h-9 w-9 text-destructive hover:text-destructive" onClick={() => void requestDelete(slot, false)} disabled={isSaving} aria-label={`Remove ${formatTime(slot.start_time)} slot`}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  )}
                </div>
                {deleting?.id === slot.id && (
                  <div role="alertdialog" aria-label="Remove time slot" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
                    <span>{deleting.message ?? 'Remove this time slot?'}</span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setDeleting(null)}>Keep</Button>
                      <Button size="sm" variant="destructive" onClick={() => void requestDelete(slot, true)} disabled={isSaving}>Remove</Button>
                    </div>
                  </div>
                )}
              </div>
            ),
          )
        )}
      </div>

      {canManage && (showAddForm ? (
        <SlotForm
          mode="add"
          initial={(() => {
            // Start where the day's availability ends, so the suggestion does not overlap.
            const last = daySlots[daySlots.length - 1]
            const start = last ? toEventLocalParts(last.end_time, timezone).time : '09:00'
            const [h, m] = start.split(':').map(Number)
            const endMinutes = Math.min(h * 60 + m + 60, 23 * 60 + 59)
            const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
            return { venueId: venue.id, dayDate: selectedDay, startTime: start, endTime: end, label: '', slotType: 'session' }
          })()}
          venues={venues}
          eventDays={eventDays}
          isSaving={isSaving}
          error={addError}
          sessionTitles={[]}
          onSubmit={submitAdd}
          onCancel={() => { setShowAddForm(false); setAddError(null) }}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => { cancelEdit(); setShowAddForm(true) }} className="w-full">
          <Plus className="h-4 w-4 mr-2" />
          Add a time slot for {eventDays.find((d) => d.date === selectedDay)?.label}
        </Button>
      ))}
    </div>
  )
}

function SlotForm({
  mode,
  initial,
  venues,
  eventDays,
  isSaving,
  error,
  confirmLabel,
  sessionTitles,
  onSubmit,
  onCancel,
}: {
  mode: 'add' | 'edit'
  initial: SlotInput
  venues: AdminVenue[]
  eventDays: { date: string; label: string }[]
  isSaving: boolean
  error: string | null
  confirmLabel?: string
  sessionTitles: string[]
  onSubmit: (input: SlotInput) => void
  onCancel: () => void
}) {
  const id = React.useId()
  const [form, setForm] = React.useState<SlotInput>(initial)
  const isEdit = mode === 'edit'
  const selectClass = 'w-full min-h-[44px] rounded-md border bg-background px-3 text-sm'
  const set = (key: keyof SlotInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))

  return (
    <Card className={cn(isEdit ? 'border-primary/50' : 'border-dashed')} role="group" aria-labelledby={`${id}-title`}>
      <CardContent className="p-4 space-y-4">
        <h4 id={`${id}-title`} className="text-sm font-semibold">{isEdit ? 'Edit time slot' : 'New time slot'}</h4>
        {isEdit && sessionTitles.length > 0 && (
          <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
            Scheduled here: {sessionTitles.join(', ')}. Changing the time or room moves {sessionTitles.length === 1 ? 'it' : 'them'} and notifies the host{sessionTitles.length === 1 ? '' : 's'}.
          </p>
        )}
        {isEdit && (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`${id}-venue`} className="text-xs font-medium">Room</label>
              <select id={`${id}-venue`} value={form.venueId} onChange={set('venueId')} className={selectClass}>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-day`} className="text-xs font-medium">Day</label>
              <select id={`${id}-day`} value={form.dayDate} onChange={set('dayDate')} className={selectClass}>
                {eventDays.map((day) => <option key={day.date} value={day.date}>{day.label}</option>)}
              </select>
            </div>
          </div>
        )}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <div className="space-y-2">
            <label htmlFor={`${id}-start`} className="text-xs font-medium">Start</label>
            <Input id={`${id}-start`} type="time" value={form.startTime} onChange={set('startTime')} className="min-h-[44px]" />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-end`} className="text-xs font-medium">End</label>
            <Input id={`${id}-end`} type="time" value={form.endTime} onChange={set('endTime')} className="min-h-[44px]" />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-type`} className="text-xs font-medium">Type</label>
            <select id={`${id}-type`} value={form.slotType} onChange={set('slotType')} className={selectClass}>
              {SLOT_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor={`${id}-label`} className="text-xs font-medium">Label</label>
            <Input id={`${id}-label`} placeholder="Optional" value={form.label} onChange={set('label')} maxLength={80} className="min-h-[44px]" />
          </div>
        </div>
        {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onCancel} disabled={isSaving} className="flex-1 sm:flex-none">Cancel</Button>
          <Button size="sm" onClick={() => onSubmit(form)} disabled={isSaving || form.endTime <= form.startTime} className="flex-1 sm:flex-none">
            {isEdit ? <Check className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
            {confirmLabel ?? (isEdit ? 'Update' : 'Add')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
