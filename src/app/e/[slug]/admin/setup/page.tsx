'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  Building,
  Calendar,
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
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { getEventDayLabel, getEventDays } from '@/lib/events/dates'
import { EN_DASH, plural } from '@/lib/format'
import { SESSION_FORMATS } from '@/lib/sessions/constants'
import { cn } from '@/lib/utils'
import { BulkSlotGenerator, type GeneratedSlot } from '@/components/admin/BulkSlotGenerator'
import type { SlotTemplate } from '@/lib/scheduling/slot-blocks'
import { VenueMapCard } from './VenueMapCard'
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
  /** Formats this room may host; empty = all. */
  allowed_formats: string[]
}

const EMPTY_VENUE: VenueForm = {
  name: '', slug: '', capacity: '', features: '', address: '', locality: '', region: '', postal_code: '', country: '',
  is_private_residence: false, is_primary: false, allowed_formats: [],
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
  const { toast } = useToast()
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

  const [showVenueForm, setShowVenueForm] = React.useState(false)
  const [editingVenue, setEditingVenue] = React.useState<AdminVenue | null>(null)
  const [venueForm, setVenueForm] = React.useState<VenueForm>(EMPTY_VENUE)
  const [venueError, setVenueError] = React.useState<string | null>(null)
  const [confirmDeleteVenue, setConfirmDeleteVenue] = React.useState<string | null>(null)
  const [expandedVenues, setExpandedVenues] = React.useState<Set<string>>(new Set())
  const [showBulkGenerator, setShowBulkGenerator] = React.useState(false)
  const [slotTemplates, setSlotTemplates] = React.useState<SlotTemplate[]>([])
  const [savingTemplates, setSavingTemplates] = React.useState(false)
  const venueNameRef = React.useRef<HTMLInputElement>(null)

  const reportNetwork = (sync: NetworkSync | undefined, success: string) => {
    const warning = networkNotice(sync)
    if (warning) setError(warning)
    else toast({ title: success, variant: 'success' })
  }

  const load = React.useCallback(async () => {
    try {
      const [v, t, tpl] = await Promise.all([
        apiFetch<{ venues: AdminVenue[] }>(`${base}/venues`),
        apiFetch<{ timeSlots: AdminTimeSlot[] }>(`${base}/time-slots`),
        // Saved bulk-block shapes (design §4). Organizer-only, and only the generator uses them,
        // so a reader without `manageVenues` simply gets none.
        apiFetch<{ templates: SlotTemplate[] }>(`${base}/slot-templates`).catch(() => ({ templates: [] })),
      ])
      setVenues(v.venues)
      setTimeSlots(t.timeSlots)
      setSlotTemplates(tpl.templates)
    } catch (e) {
      setError(errorText(e, 'Rooms and availability could not be loaded. Refresh to try again.'))
    } finally {
      setIsLoading(false)
    }
  }, [base])

  React.useEffect(() => { void load() }, [load])

  // Stable identity: the map card polls on this while a background geocode is in flight, and a new
  // function every render would restart that effect (and its attempt counter) forever.
  const refreshVenues = React.useCallback(async () => {
    const v = await apiFetch<{ venues: AdminVenue[] }>(`${base}/venues`)
    setVenues(v.venues)
  }, [base])

  const resetVenueForm = () => {
    setShowVenueForm(false)
    setEditingVenue(null)
    setVenueForm(EMPTY_VENUE)
    setVenueError(null)
  }

  const openVenueForm = () => {
    resetVenueForm()
    setShowVenueForm(true)
    window.requestAnimationFrame(() => venueNameRef.current?.focus())
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
      allowed_formats: venue.allowed_formats ?? [],
    })
    setVenueError(null)
    setShowVenueForm(true)
    window.requestAnimationFrame(() => venueNameRef.current?.focus())
  }

  const saveVenue = async () => {
    if (isSaving) return
    setVenueError(null)
    if (!venueForm.name.trim()) { setVenueError('Enter a room name.'); venueNameRef.current?.focus(); return }
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
      allowed_formats: venueForm.allowed_formats,
    }
    try {
      const res = editingVenue
        ? await apiFetch<{ venue: AdminVenue; network: NetworkSync }>(`${base}/venues/${editingVenue.id}`, { method: 'PATCH', json: body })
        : await apiFetch<{ venue: AdminVenue; network: NetworkSync }>(`${base}/venues`, { method: 'POST', json: body })
      await refreshVenues()
      resetVenueForm()
      reportNetwork(res.network, editingVenue ? 'Room updated.' : 'Room added.')
    } catch (e) {
      setVenueError(errorText(e, 'The room could not be saved.'))
    } finally {
      setIsSaving(false)
    }
  }

  const deleteVenue = async (id: string) => {
    setIsSaving(true)
    setError(null)
    try {
      const res = await apiFetch<{ unscheduled: number; network: { venues: NetworkSync; grids: NetworkSync } }>(`${base}/venues/${id}`, { method: 'DELETE' })
      setVenues((prev) => prev.filter((v) => v.id !== id))
      setTimeSlots((prev) => prev.filter((t) => t.venue_id !== id))
      setConfirmDeleteVenue(null)
      reportNetwork(res.network.venues.error ? res.network.venues : res.network.grids, res.unscheduled
        ? `Room removed. ${plural(res.unscheduled, 'session')} went back to the unscheduled tray.`
        : 'Room removed.')
    } catch (e) {
      setError(errorText(e, 'The room could not be removed.'))
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
      reportNetwork(res.network, `Saved ${plural(res.timeSlots.length, 'time slot')}.`)
      return null
    } catch (e) {
      return errorText(e, 'The availability could not be saved.')
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
      return { error: errorText(e, 'The availability could not be updated.') }
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
      reportNetwork(res.network, res.unscheduled ? `Slot removed; ${plural(res.unscheduled, 'session')} went back to the tray.` : 'Slot removed.')
      return { error: null }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SlotHasSessions') return { error: e.message, needsConfirm: true }
      return { error: errorText(e, 'The availability could not be removed.') }
    } finally {
      setIsSaving(false)
    }
  }

  /** The editor holds the whole list; PUT replaces it (save, apply and delete are all one list). */
  const saveTemplates = async (next: SlotTemplate[]) => {
    setSavingTemplates(true)
    try {
      const res = await apiFetch<{ templates: SlotTemplate[] }>(`${base}/slot-templates`, { method: 'PUT', json: { templates: next } })
      setSlotTemplates(res.templates)
      toast({ title: 'Templates saved.', variant: 'success' })
    } finally {
      setSavingTemplates(false)
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

  const field = (key: keyof VenueForm, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, ref?: React.RefObject<HTMLInputElement | null>) => (
    <div className="space-y-2">
      <Label htmlFor={`venue-${key}`}>{label}</Label>
      <Input
        ref={ref}
        id={`venue-${key}`}
        value={venueForm[key] as string}
        onChange={(e) => setVenueForm((f) => ({ ...f, [key]: e.target.value }))}
        {...props}
      />
    </div>
  )

  const sessionSlotCount = timeSlots.filter((t) => !t.is_break).length
  const roomsWithoutSlots = venues.length > 0 && timeSlots.length === 0

  return (
    <div>
      <PageHeader
        title="Spaces & times"
        subtitle={<>Add rooms and when each one is free. Times are in the gathering’s timezone ({event.timezone}).</>}
        actions={canManage && (
          <>
            {venues.length > 0 && (
              <Button variant="outline" onClick={() => setShowBulkGenerator(true)} disabled={showBulkGenerator}>
                <Zap className="h-4 w-4 mr-2" aria-hidden="true" />
                Generate slots
              </Button>
            )}
            <Button onClick={openVenueForm} disabled={showVenueForm}><Plus className="h-4 w-4 mr-2" aria-hidden="true" />Add room</Button>
          </>
        )}
      />

      <div className="space-y-6">
        {error && (
          <Alert variant="destructive" className="flex items-start justify-between gap-3 [&>svg~*]:pl-0">
            <AlertDescription role="alert">{error}</AlertDescription>
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>
          </Alert>
        )}

        {showBulkGenerator && venues.length > 0 && (
          <Card className="border-primary/50">
            <CardHeader><CardTitle className="text-lg">Generate time slots</CardTitle></CardHeader>
            <CardContent>
              <BulkSlotGenerator
                venues={venues.map((v) => ({ id: v.id, name: v.name, capacity: v.capacity }))}
                eventDays={eventDays}
                timezone={event.timezone}
                existingSlots={timeSlots.filter(slot => slot.venue_id).map(slot => ({
                  venueId: slot.venue_id!, dayDate: toEventLocalParts(slot.start_time, event.timezone).date,
                  startTime: toEventLocalParts(slot.start_time, event.timezone).time,
                  endTime: toEventLocalParts(slot.end_time, event.timezone).time,
                }))}
                onGenerate={handleBulkGenerate}
                isSaving={isSaving}
                templates={slotTemplates}
                onTemplatesChange={saveTemplates}
                templatesBusy={savingTemplates}
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
                {field('name', 'Name', { placeholder: 'e.g. Main hall', maxLength: 100, 'aria-invalid': venueError && !venueForm.name.trim() ? true : undefined }, venueNameRef)}
                {field('slug', 'Short name (optional)', { placeholder: 'Generated from the name if empty', maxLength: 60 })}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('capacity', 'Capacity (optional)', { type: 'number', min: 1, placeholder: 'e.g. 100', inputMode: 'numeric' })}
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Type</legend>
                  <div className="flex h-11 items-center gap-2">
                    <Checkbox id="venue-is-primary" checked={venueForm.is_primary} onCheckedChange={(checked) => setVenueForm((f) => ({ ...f, is_primary: checked === true }))} />
                    <Label htmlFor="venue-is-primary" className="font-normal">Primary room (main stage)</Label>
                  </div>
                </fieldset>
              </div>
              {field('address', 'Street address (optional)', { placeholder: 'e.g. 1600 Walnut St', maxLength: 300 })}
              <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
                {field('locality', 'City or neighborhood (optional)', { maxLength: 100 })}
                {field('region', 'Region (optional)', { maxLength: 100 })}
                {field('postal_code', 'Postal code (optional)', { maxLength: 20 })}
                {field('country', 'Country (optional)', { maxLength: 2, placeholder: 'US' })}
              </div>
              <div className="flex items-start gap-2 text-sm">
                <Checkbox id="venue-private" className="mt-0.5" checked={venueForm.is_private_residence} onCheckedChange={(checked) => setVenueForm((f) => ({ ...f, is_private_residence: checked === true }))} />
                <Label htmlFor="venue-private" className="font-normal leading-snug">This is a private home. <span className="text-muted-foreground">The public calendar shows only the city or neighborhood, never the street address.</span></Label>
              </div>
              {field('features', 'Features (optional, comma-separated)', { placeholder: 'e.g. projector, whiteboard, round tables' })}
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Allowed formats (optional)</legend>
                <p className="text-xs text-muted-foreground">Leave every box empty to allow any format. Auto-schedule only places matching sessions here.</p>
                <div className="flex flex-wrap gap-2">
                  {SESSION_FORMATS.map((f) => {
                    const checked = venueForm.allowed_formats.includes(f.value)
                    return (
                      <label
                        key={f.value}
                        htmlFor={`venue-format-${f.value}`}
                        className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm transition-colors', checked ? 'border-primary bg-primary/10' : 'border-input bg-background hover:bg-muted')}
                      >
                        <Checkbox
                          id={`venue-format-${f.value}`}
                          checked={checked}
                          onCheckedChange={(next) => setVenueForm((v) => ({
                            ...v,
                            allowed_formats: next === true ? [...v.allowed_formats, f.value] : v.allowed_formats.filter((x) => x !== f.value),
                          }))}
                        />
                        {f.label}
                      </label>
                    )
                  })}
                </div>
              </fieldset>
              {venueError && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{venueError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={resetVenueForm} disabled={isSaving}>Cancel</Button>
                <Button onClick={() => void saveVenue()} loading={isSaving} disabled={!venueForm.name.trim()}>
                  {editingVenue ? 'Save changes' : 'Add room'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {roomsWithoutSlots && !showBulkGenerator && (
          <Card className="border-primary/25 bg-secondary/40">
            <CardContent className="py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold">Rooms are ready — now add times</h2>
                <p className="mt-1 text-sm text-muted-foreground">Sessions can only be placed where a room has a free slot. Generate every room’s day in one pass — each room can keep its own hours, or be closed — or add slots one at a time.</p>
              </div>
              {canManage && (
                <Button onClick={() => setShowBulkGenerator(true)} className="shrink-0"><Zap className="h-4 w-4 mr-2" aria-hidden="true" />Generate slots</Button>
              )}
            </CardContent>
          </Card>
        )}

        <section aria-labelledby="rooms-heading" className="space-y-4">
          <h2 id="rooms-heading" className="text-lg font-semibold flex items-center gap-2"><MapPin className="h-5 w-5" aria-hidden="true" />Rooms & availability</h2>
          {venues.map((venue) => {
            const venueSlots = timeSlots.filter((t) => t.venue_id === venue.id)
            const isExpanded = expandedVenues.has(venue.id)
            return (
              <Card key={venue.id}>
                <CardContent className="p-4">
                  <div className="space-y-3">
                    <div className="space-y-2 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Building className="h-5 w-5 text-primary flex-shrink-0" aria-hidden="true" />
                        <h3 className="font-semibold">{venue.name}</h3>
                        {venue.is_primary && <Badge variant="default">Primary</Badge>}
                        {venue.is_private_residence && <Badge variant="outline">Private home</Badge>}
                        {venue.network_published && <Badge variant="outline" className="gap-1"><Globe className="h-3 w-3" aria-hidden="true" />On the network</Badge>}
                      </div>
                      <div className="flex items-center gap-3 sm:gap-4 text-sm text-muted-foreground flex-wrap">
                        {venue.capacity && <span className="flex items-center gap-1"><UsersIcon className="h-4 w-4" aria-hidden="true" />{plural(venue.capacity, 'seat')}</span>}
                        <span className="flex items-center gap-1"><Clock className="h-4 w-4" aria-hidden="true" />{plural(venue.slot_count, 'slot')}</span>
                        <span>{venue.scheduled_count} scheduled</span>
                      </div>
                      {venue.features.length > 0 && (
                        <div className="flex flex-wrap gap-1">{venue.features.map((feature) => <Badge key={feature} variant="secondary">{feature}</Badge>)}</div>
                      )}
                    </div>
                    {confirmDeleteVenue === venue.id ? (
                      <ConfirmInline
                        layout="inline"
                        destructive
                        message={`Remove ${venue.name} and its ${plural(venue.slot_count, 'time slot')}?${venue.scheduled_count ? ` ${plural(venue.scheduled_count, 'scheduled session')} will go back to the tray.` : ''}`}
                        confirmLabel="Remove"
                        loading={isSaving}
                        onConfirm={() => void deleteVenue(venue.id)}
                        onCancel={() => setConfirmDeleteVenue(null)}
                      />
                    ) : (
                      <div className="flex items-center gap-1 flex-wrap pt-2 border-t">
                        <Button size="sm" variant="outline" onClick={() => setExpandedVenues((prev) => { const next = new Set(prev); if (next.has(venue.id)) next.delete(venue.id); else next.add(venue.id); return next })} aria-expanded={isExpanded} aria-controls={`availability-${venue.id}`}>
                          <Calendar className="h-4 w-4 mr-1" aria-hidden="true" />
                          Availability
                          {isExpanded ? <ChevronUp className="h-4 w-4 ml-1" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 ml-1" aria-hidden="true" />}
                        </Button>
                        {canManage && (
                          <span className="ml-auto flex gap-1">
                            <Button size="icon-sm" variant="ghost" onClick={() => startEditVenue(venue)} aria-label={`Edit ${venue.name}`}><Edit2 className="h-4 w-4" aria-hidden="true" /></Button>
                            <Button size="icon-sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDeleteVenue(venue.id)} aria-label={`Remove ${venue.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {isExpanded && (
                    <div id={`availability-${venue.id}`} className="mt-4 pt-4 border-t">
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

          {venues.length === 0 && !showVenueForm && (
            <Card>
              <CardContent className="py-12 text-center">
                <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" aria-hidden="true" />
                <h3 className="font-semibold mb-2">No rooms yet</h3>
                <p className="text-muted-foreground mb-4">Add your first room to start building the schedule.</p>
                {canManage && <Button onClick={openVenueForm}><Plus className="h-4 w-4 mr-2" aria-hidden="true" />Add room</Button>}
              </CardContent>
            </Card>
          )}
          <VenueMapCard venues={venues} base={base} canManage={canManage} onChanged={refreshVenues} />
        </section>

        {venues.length > 0 && sessionSlotCount > 0 && can('manageSchedule') && (
          <Card className="border-primary/25">
            <CardContent className="py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="font-medium">Next: place sessions</p>
                <p className="text-sm text-muted-foreground">{plural(venues.length, 'room')} and {plural(sessionSlotCount, 'session slot')} are ready for the schedule builder.</p>
              </div>
              <Button asChild className="shrink-0"><Link href={`/e/${event.slug}/admin/schedule`}>Open schedule builder<ArrowRight className="h-4 w-4 ml-2" aria-hidden="true" /></Link></Button>
            </CardContent>
          </Card>
        )}
      </div>
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
          ? `${plural(slot.sessions.length, 'session')} ${slot.sessions.length === 1 ? 'is' : 'are'} scheduled here (${slot.sessions.map((s) => s.title).join(', ')}) and will go back to the tray. Remove the slot?`
          : null,
      })
      return
    }
    const res = await onDelete(slot.id, deleting?.needsConfirm ?? false)
    if (res.error) setDeleting({ id: slot.id, message: res.error, needsConfirm: Boolean(res.needsConfirm) })
    else setDeleting(null)
  }

  const dayLabel = eventDays.find((d) => d.date === selectedDay)?.label

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Day" className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {eventDays.map((day) => (
          <Button key={day.date} variant={selectedDay === day.date ? 'default' : 'outline'} size="sm" onClick={() => setSelectedDay(day.date)} aria-pressed={selectedDay === day.date} className="whitespace-nowrap flex-shrink-0">{day.label}</Button>
        ))}
      </div>

      <div className="space-y-2">
        {daySlots.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No time slots on {dayLabel ?? 'this day'} yet.{canManage ? ' Add one below.' : ''}</p>
        ) : (
          daySlots.map((slot) =>
            editingSlot?.id === slot.id && editingInitial ? (
              <SlotForm key={slot.id} mode="edit" initial={editingInitial} venues={venues} eventDays={eventDays} isSaving={isSaving} error={editError} confirmLabel={editNeedsConfirm ? 'Confirm and save' : undefined} sessionTitles={slot.sessions.map((s) => s.title)} onSubmit={submitEdit} onCancel={cancelEdit} />
            ) : (
              <div key={slot.id} className={cn('rounded-xl border p-3 space-y-2', slot.is_break ? 'border-signal-amber/30 bg-signal-amber/10' : 'bg-muted/30')}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap flex-1 min-w-0">
                    <div className="text-sm whitespace-nowrap tabular-nums">{formatTime(slot.start_time)}{EN_DASH}{formatTime(slot.end_time)}</div>
                    <Badge variant={slot.is_break ? 'amber' : 'outline'} className="capitalize">{slot.is_break ? 'Break' : slot.slot_type || 'session'}</Badge>
                    {slot.label && <span className="text-sm text-muted-foreground truncate">{slot.label}</span>}
                    {slot.sessions.length > 0 && <span className="text-xs text-muted-foreground truncate">· {slot.sessions.map((s) => s.title).join(', ')}</span>}
                  </div>
                  {canManage && deleting?.id !== slot.id && (
                    <div className="flex gap-1 flex-shrink-0">
                      <Button size="icon-sm" variant="ghost" onClick={() => { setShowAddForm(false); setDeleting(null); setEditError(null); setEditNeedsConfirm(false); setEditingSlot(slot) }} disabled={isSaving} aria-label={`Edit the ${formatTime(slot.start_time)} slot`}><Edit2 className="h-4 w-4" aria-hidden="true" /></Button>
                      <Button size="icon-sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void requestDelete(slot, false)} disabled={isSaving} aria-label={`Remove the ${formatTime(slot.start_time)} slot`}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
                    </div>
                  )}
                </div>
                {deleting?.id === slot.id && (
                  <ConfirmInline
                    layout="inline"
                    destructive
                    message={deleting.message ?? 'Remove this time slot?'}
                    confirmLabel="Remove"
                    loading={isSaving}
                    onConfirm={() => void requestDelete(slot, true)}
                    onCancel={() => setDeleting(null)}
                  />
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
          <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
          Add a time slot for {dayLabel}
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
  const set = (key: keyof SlotInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const invalidRange = form.endTime <= form.startTime

  return (
    <Card className={cn(isEdit ? 'border-primary/50' : 'border-dashed')} role="group" aria-labelledby={`${id}-title`}>
      <CardContent className="p-4 space-y-4">
        <h4 id={`${id}-title`} className="text-sm font-semibold">{isEdit ? 'Edit time slot' : 'New time slot'}</h4>
        {isEdit && sessionTitles.length > 0 && (
          <Alert variant="warning" role="status">
            <AlertDescription>
              Scheduled here: {sessionTitles.join(', ')}. Changing the time or room moves {sessionTitles.length === 1 ? 'it' : 'them'} and notifies the host{sessionTitles.length === 1 ? '' : 's'}.
            </AlertDescription>
          </Alert>
        )}
        {isEdit && (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-venue`}>Room</Label>
              <Select id={`${id}-venue`} value={form.venueId} onChange={set('venueId')}>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-day`}>Day</Label>
              <Select id={`${id}-day`} value={form.dayDate} onChange={set('dayDate')}>
                {eventDays.map((day) => <option key={day.date} value={day.date}>{day.label}</option>)}
              </Select>
            </div>
          </div>
        )}
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-start`}>Start</Label>
            <Input id={`${id}-start`} type="time" value={form.startTime} onChange={set('startTime')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-end`}>End</Label>
            <Input id={`${id}-end`} type="time" value={form.endTime} onChange={set('endTime')} aria-invalid={invalidRange ? true : undefined} aria-describedby={invalidRange ? `${id}-range` : undefined} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-type`}>Type</Label>
            <Select id={`${id}-type`} value={form.slotType} onChange={set('slotType')}>
              {SLOT_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-label`}>Label (optional)</Label>
            <Input id={`${id}-label`} placeholder="e.g. Lunch" value={form.label} onChange={set('label')} maxLength={80} />
          </div>
        </div>
        {invalidRange && <p id={`${id}-range`} className="text-sm text-destructive">The end time must be after the start time.</p>}
        {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel} disabled={isSaving}>Cancel</Button>
          <Button size="sm" onClick={() => onSubmit(form)} loading={isSaving} disabled={invalidRange}>
            {confirmLabel ?? (isEdit ? 'Save changes' : 'Add slot')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
