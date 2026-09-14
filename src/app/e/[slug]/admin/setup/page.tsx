'use client'

import { parseTimeInTimezone } from '@/lib/events/timezone'
import { requireSavedRows } from '@/lib/api/saved-rows'
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Loader2,
  MapPin,
  Clock,
  Plus,
  Trash2,
  Edit2,
  Check,
  Building,
  Users as UsersIcon,
  ChevronDown,
  ChevronUp,
  Calendar,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { getEventDays, getEventDayLabel } from '@/lib/events/dates'
import { cn } from '@/lib/utils'
import { BulkSlotGenerator, type GeneratedSlot } from '@/components/admin/BulkSlotGenerator'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function getAccessToken(): string | null {
  const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  const stored = localStorage.getItem(storageKey)
  if (stored) {
    try {
      const session = JSON.parse(stored)
      return session?.access_token || null
    } catch {
      return null
    }
  }
  return null
}

interface Venue {
  id: string
  name: string
  slug: string | null
  capacity: number | null
  features: string[] | null
  style: string | null
  address: string | null
  is_primary: boolean
}

interface TimeSlot {
  id: string
  label: string | null
  start_time: string
  end_time: string
  is_break: boolean
  venue_id: string | null
  day_date: string | null
  slot_type: string | null
}

export default function AdminSetupPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { isAdmin, isLoading: roleLoading, can } = useEventRole()

  // Generate event days dynamically from event dates
  const eventDays = React.useMemo(() => {
    return getEventDays(event.startDate, event.endDate).map((date) => ({
      date,
      label: getEventDayLabel(date, event.timezone),
    }))
  }, [event.startDate, event.endDate, event.timezone])

  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const [venues, setVenues] = React.useState<Venue[]>([])
  const [timeSlots, setTimeSlots] = React.useState<TimeSlot[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  // New venue form state
  const [showVenueForm, setShowVenueForm] = React.useState(false)
  const [editingVenue, setEditingVenue] = React.useState<Venue | null>(null)
  const [venueName, setVenueName] = React.useState('')
  const [venueSlug, setVenueSlug] = React.useState('')
  const [venueCapacity, setVenueCapacity] = React.useState('')
  const [venueFeatures, setVenueFeatures] = React.useState('')
  const [venueAddress, setVenueAddress] = React.useState('')
  const [venueIsPrimary, setVenueIsPrimary] = React.useState(false)

  // Expanded venues for availability editing
  const [expandedVenues, setExpandedVenues] = React.useState<Set<string>>(new Set())

  // Bulk slot generator
  const [showBulkGenerator, setShowBulkGenerator] = React.useState(false)

  // Redirect if not admin
  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !isAdmin)) {
      router.push(`/e/${event.slug}/sessions`)
    }
  }, [user, isAdmin, authLoading, roleLoading, router, event.slug])

  // Fetch data
  React.useEffect(() => {
    const fetchData = async () => {
      const token = getAccessToken()
      const authHeader = token ? `Bearer ${token}` : `Bearer ${SUPABASE_KEY}`

      try {
        const [venuesRes, timeSlotsRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/venues?event_id=eq.${event.id}&select=*&order=is_primary.desc,name`, {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': authHeader,
            },
          }),
          fetch(`${SUPABASE_URL}/rest/v1/time_slots?event_id=eq.${event.id}&select=*&order=start_time`, {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': authHeader,
            },
          }),
        ])

        if (!venuesRes.ok || !timeSlotsRes.ok) throw new Error('Could not load rooms and availability. Refresh to try again.')
        if (venuesRes.ok) {
          setVenues(await venuesRes.json())
        }
        if (timeSlotsRes.ok) {
          setTimeSlots(await timeSlotsRes.json())
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Could not load rooms and availability.')
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
  }, [event.id])

  // Get time slots for a venue
  const getVenueSlots = (venueId: string) => {
    return timeSlots.filter((slot) => slot.venue_id === venueId)
  }

  // Venue CRUD operations
  const handleSaveVenue = async () => {
    const token = getAccessToken()
    if (!token) { setSaveError('Please sign in again to save changes.'); return false }

    if (isSaving) return
    if (!venueName.trim() || (venueCapacity && (!Number.isInteger(Number(venueCapacity)) || Number(venueCapacity) <= 0))) { setSaveError('Enter a room name and a positive whole-number capacity.'); return }
    setIsSaving(true)
    setSaveError(null)
    const features = venueFeatures
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)

    const slug = venueSlug || venueName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

    const venueData = {
      name: venueName,
      slug,
      capacity: venueCapacity ? parseInt(venueCapacity) : null,
      features: features.length > 0 ? features : null,
      address: venueAddress || null,
      is_primary: venueIsPrimary,
      event_id: event.id,
    }

    try {
      if (editingVenue) {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/venues?id=eq.${editingVenue.id}&event_id=eq.${event.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify(venueData),
        })

        const [updated] = await requireSavedRows<Venue>(response)
        setVenues((prev) => prev.map((v) => (v.id === editingVenue.id ? updated : v)))
      } else {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/venues`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify(venueData),
        })

        const [created] = await requireSavedRows<Venue>(response)
        setVenues((prev) => [...prev, created])
      }

      resetVenueForm()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this room.')
    } finally { setIsSaving(false) }
  }

  const handleDeleteVenue = async (id: string) => {
    const token = getAccessToken()
    if (!token) { setSaveError('Please sign in again to save changes.'); return false }

    if (!confirm('Delete this venue? All time slots and scheduled sessions will be affected.')) return

    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/venues?id=eq.${id}&event_id=eq.${event.id}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Prefer': 'return=representation',
        },
      })

      await requireSavedRows<Venue>(response)
      {
        setVenues((prev) => prev.filter((v) => v.id !== id))
        setTimeSlots((prev) => prev.filter((s) => s.venue_id !== id))
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not remove this room.')
    }
  }

  const startEditVenue = (venue: Venue) => {
    setEditingVenue(venue)
    setVenueName(venue.name)
    setVenueSlug(venue.slug || '')
    setVenueCapacity(venue.capacity?.toString() || '')
    setVenueFeatures(venue.features?.join(', ') || '')
    setVenueAddress(venue.address || '')
    setVenueIsPrimary(venue.is_primary)
    setShowVenueForm(true)
  }

  const resetVenueForm = () => {
    setShowVenueForm(false)
    setEditingVenue(null)
    setVenueName('')
    setVenueSlug('')
    setVenueCapacity('')
    setVenueFeatures('')
    setVenueAddress('')
    setVenueIsPrimary(false)
  }

  // Time Slot CRUD operations
  const handleSaveTimeSlots = async (slots: (GeneratedSlot & {slotType?: string})[]) => {
    const token = getAccessToken()
    if (!token) { setSaveError('Please sign in again to save changes.'); return false }
    if (isSaving) return false
    setIsSaving(true)
    setSaveError(null)
    try {
      const rows = slots.map(slot => {
        if (!venues.some(v => v.id === slot.venueId) || !eventDays.some(day => day.date === slot.dayDate) || !slot.startTime || !slot.endTime || slot.endTime <= slot.startTime) throw new Error('Choose a room, an event day, and an end time after the start time.')
        const start = parseTimeInTimezone(slot.startTime, slot.dayDate, event.timezone)
        const end = parseTimeInTimezone(slot.endTime, slot.dayDate, event.timezone)
        return { venue_id: slot.venueId, event_id: event.id, day_date: slot.dayDate, label: slot.label || null, start_time: start.toISOString(), end_time: end.toISOString(), is_break: slot.isBreak, slot_type: slot.slotType || (slot.isBreak ? 'break' : 'session') }
      })
      rows.forEach((row,index) => {
        if ([...timeSlots,...rows.slice(0,index)].some(other => other.venue_id === row.venue_id && Date.parse(other.start_time) < Date.parse(row.end_time) && Date.parse(row.start_time) < Date.parse(other.end_time))) throw new Error('These slots overlap existing availability in the same room. Adjust the times before saving.')
      })
      // A single PostgREST insert is transactional: the whole batch succeeds or fails.
      const response = await fetch(`${SUPABASE_URL}/rest/v1/time_slots`, {
        method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      })
      const created = await requireSavedRows<TimeSlot>(response)
      setTimeSlots(prev => [...prev,...created].sort((a,b) => Date.parse(a.start_time) - Date.parse(b.start_time)))
      return true
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this availability.')
      return false
    } finally { setIsSaving(false) }
  }

  const handleAddTimeSlot = (venueId: string, dayDate: string, startTime: string, endTime: string, label: string, slotType: string, isBreak: boolean) =>
    handleSaveTimeSlots([{venueId,dayDate,startTime,endTime,label,slotType,isBreak}])

  const handleDeleteTimeSlot = async (id: string) => {
    const token = getAccessToken()
    if (!token) { setSaveError('Please sign in again to save changes.'); return false }

    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/time_slots?id=eq.${id}&event_id=eq.${event.id}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`,
          'Prefer': 'return=representation',
        },
      })

      await requireSavedRows<TimeSlot>(response)
      {
        setTimeSlots((prev) => prev.filter((s) => s.id !== id))
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not remove this availability.')
    }
  }

  const toggleVenueExpanded = (venueId: string) => {
    setExpandedVenues((prev) => {
      const next = new Set(prev)
      if (next.has(venueId)) {
        next.delete(venueId)
      } else {
        next.add(venueId)
      }
      return next
    })
  }

  // Bulk generate time slots
  const handleBulkGenerate = async (slots: GeneratedSlot[]) => {
    if (await handleSaveTimeSlots(slots)) setShowBulkGenerator(false)
  }

  if (authLoading || roleLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAdmin) {
    return null
  }

  return (
        <div className="space-y-6">
      {saveError && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{saveError}</div>}

<div><h1 className="font-semibold">Spaces & times</h1><p className="text-muted-foreground mt-2">Give your gathering a place to happen.</p></div>
          {/* Info Card */}
          <Card className="bg-muted/30">
            <CardContent className="py-4">
              <p className="text-sm text-muted-foreground">
                Configure venues and their availability windows. Each venue can have different time slots for each day.
                Once configured, use the <Link href={`/e/${event.slug}/admin/schedule`} className="text-primary hover:underline font-medium">Schedule Builder</Link> to assign sessions to slots.
              </p>
            </CardContent>
          </Card>

          {/* Add Venue Button */}
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Venues & Availability
            </h2>
            {can('manageVenues') && (
              <div className="flex gap-2">
                <Button onClick={() => setShowVenueForm(true)} disabled={showVenueForm} className="flex-1 sm:flex-none">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Venue
                </Button>
                {venues.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => setShowBulkGenerator(true)}
                    disabled={showBulkGenerator}
                    className="flex-1 sm:flex-none"
                  >
                    <Zap className="h-4 w-4 mr-2" />
                    <span className="hidden sm:inline">Bulk Generate Slots</span>
                    <span className="sm:hidden">Bulk Slots</span>
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Bulk Slot Generator */}
          {showBulkGenerator && venues.length > 0 && (
            <Card className="border-primary/50">
              <CardHeader>
                <CardTitle className="text-lg">Bulk Generate Time Slots</CardTitle>
              </CardHeader>
              <CardContent>
                <BulkSlotGenerator
                  venues={venues.map(v => ({ id: v.id, name: v.name, capacity: v.capacity }))}
                  eventDays={eventDays}
                  onGenerate={handleBulkGenerate}
                  isSaving={isSaving}
                  onCancel={() => setShowBulkGenerator(false)}
                />
              </CardContent>
            </Card>
          )}

          {/* Venue Form */}
          {showVenueForm && (
            <Card className="border-primary/50">
              <CardHeader>
                <CardTitle className="text-lg">
                  {editingVenue ? 'Edit Venue' : 'New Venue'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Name *</label>
                    <Input
                      placeholder="e.g., E-Town Hall"
                      value={venueName}
                      onChange={(e) => setVenueName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Slug</label>
                    <Input
                      placeholder="e.g., etown (auto-generated if empty)"
                      value={venueSlug}
                      onChange={(e) => setVenueSlug(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Capacity</label>
                    <Input
                      type="number"
                      placeholder="e.g., 100"
                      value={venueCapacity}
                      onChange={(e) => setVenueCapacity(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Type</label>
                    <div className="flex items-center gap-3 h-10">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={venueIsPrimary}
                          onChange={(e) => setVenueIsPrimary(e.target.checked)}
                          className="rounded"
                        />
                        <span className="text-sm">Primary Venue (main stage)</span>
                      </label>
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Address</label>
                  <Input
                    placeholder="e.g., 1600 Walnut St, Boulder, CO 80302"
                    value={venueAddress}
                    onChange={(e) => setVenueAddress(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Features (comma-separated)</label>
                  <Input
                    placeholder="e.g., projector, whiteboard, round tables"
                    value={venueFeatures}
                    onChange={(e) => setVenueFeatures(e.target.value)}
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={resetVenueForm}>
                    Cancel
                  </Button>
                  <Button onClick={handleSaveVenue} disabled={!venueName.trim() || isSaving}>
                    <Check className="h-4 w-4 mr-2" />
                    {editingVenue ? 'Update' : 'Create'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Venues List with Availability */}
          <div className="space-y-4">
            {venues.map((venue) => {
              const venueSlots = getVenueSlots(venue.id)
              const isExpanded = expandedVenues.has(venue.id)

              return (
                <Card key={venue.id}>
                  <CardContent className="p-4">
                    <div className="space-y-3">
                      <div className="space-y-2 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Building className="h-5 w-5 text-primary flex-shrink-0" />
                          <h3 className="font-semibold">{venue.name}</h3>
                          {venue.is_primary && (
                            <Badge variant="default" className="text-xs">Primary</Badge>
                          )}
                          {venue.slug && (
                            <Badge variant="outline" className="text-xs hidden sm:inline-flex">{venue.slug}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 sm:gap-4 text-sm text-muted-foreground flex-wrap">
                          {venue.capacity && (
                            <span className="flex items-center gap-1">
                              <UsersIcon className="h-4 w-4" />
                              {venue.capacity} cap
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            {venueSlots.length} slots
                          </span>
                        </div>
                        {venue.features && venue.features.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {venue.features.map((feature) => (
                              <Badge key={feature} variant="secondary" className="text-xs">
                                {feature}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 flex-wrap sm:flex-nowrap pt-2 border-t">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleVenueExpanded(venue.id)}
                          className="flex-1 sm:flex-none"
                        >
                          <Calendar className="h-4 w-4 mr-1" />
                          <span className="hidden sm:inline">Availability</span>
                          <span className="sm:hidden">Slots</span>
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4 ml-1" />
                          ) : (
                            <ChevronDown className="h-4 w-4 ml-1" />
                          )}
                        </Button>
                        {can('manageVenues') && (
                          <>
                            <Button size="icon" variant="ghost" onClick={() => startEditVenue(venue)} className="h-9 w-9">
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="text-destructive hover:text-destructive h-9 w-9"
                              onClick={() => handleDeleteVenue(venue.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Expanded Availability Section */}
                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t">
                        <VenueAvailabilityEditor
                          venue={venue}
                          slots={venueSlots}
                          eventDays={eventDays}
                          canManage={can('manageVenues')}
                          onAddSlot={handleAddTimeSlot}
                          onDeleteSlot={handleDeleteTimeSlot}
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
                <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="font-semibold mb-2">No venues configured</h3>
                <p className="text-muted-foreground mb-4">
                  Add your first venue to start setting up the schedule
                </p>
                {can('manageVenues') && (
                  <Button onClick={() => setShowVenueForm(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Venue
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
  )
}

// Venue availability editor component
function VenueAvailabilityEditor({
  venue,
  slots,
  eventDays,
  canManage,
  onAddSlot,
  onDeleteSlot,
}: {
  venue: Venue
  slots: TimeSlot[]
  eventDays: { date: string; label: string }[]
  canManage: boolean
  onAddSlot: (venueId: string, dayDate: string, startTime: string, endTime: string, label: string, slotType: string, isBreak: boolean) => Promise<boolean>
  onDeleteSlot: (id: string) => void
}) {
  const event = useEvent()
  const [isAdding, setIsAdding] = React.useState(false)
  const [selectedDay, setSelectedDay] = React.useState(eventDays[0]?.date || '')
  const [showAddForm, setShowAddForm] = React.useState(false)
  const [newStartTime, setNewStartTime] = React.useState('09:00')
  const [newEndTime, setNewEndTime] = React.useState('10:00')
  const [newLabel, setNewLabel] = React.useState('')
  const [newSlotType, setNewSlotType] = React.useState('session')
  const [newIsBreak, setNewIsBreak] = React.useState(false)

  const daySlots = slots
    .filter((s) => s.day_date === selectedDay)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())

  const handleAdd = async () => {
    if (isAdding) return
    setIsAdding(true)
    const saved = await onAddSlot(venue.id, selectedDay, newStartTime, newEndTime, newLabel, newSlotType, newIsBreak)
    setIsAdding(false)
    if (!saved) return
    setShowAddForm(false)
    setNewLabel('')
    setNewSlotType('session')
    setNewIsBreak(false)
  }

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: event.timezone })
  }

  return (
    <div className="space-y-4">
      {/* Day Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {eventDays.map((day) => (
          <Button
            key={day.date}
            variant={selectedDay === day.date ? 'default' : 'outline'}
            size="sm"
            onClick={() => setSelectedDay(day.date)}
            className="whitespace-nowrap flex-shrink-0"
          >
            {day.label}
          </Button>
        ))}
      </div>

      {/* Slots for selected day */}
      <div className="space-y-2">
        {daySlots.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No time slots for this day. Add availability windows below.
          </p>
        ) : (
          daySlots.map((slot) => (
            <div
              key={slot.id}
              className={cn(
                'flex items-center justify-between p-3 rounded-lg border gap-2',
                slot.is_break ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800' : 'bg-muted/30'
              )}
            >
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap flex-1 min-w-0">
                <div className="text-sm whitespace-nowrap">
                  {formatTime(slot.start_time)} - {formatTime(slot.end_time)}
                </div>
                <Badge variant={slot.is_break ? 'secondary' : 'outline'} className="text-xs">
                  {slot.is_break ? 'Break' : slot.slot_type || 'session'}
                </Badge>
                {slot.label && (
                  <span className="text-sm text-muted-foreground truncate">{slot.label}</span>
                )}
              </div>
              {canManage && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 flex-shrink-0 text-destructive hover:text-destructive"
                  onClick={() => onDeleteSlot(slot.id)} aria-label={`Remove ${formatTime(slot.start_time)} slot`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add slot form */}
      {canManage && (
        <>
          {showAddForm ? (
            <Card className="border-dashed">
              <CardContent className="p-4 space-y-4">
                <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Start</label>
                    <Input
                      type="time"
                      value={newStartTime}
                      onChange={(e) => setNewStartTime(e.target.value)}
                      className="min-h-[44px]"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">End</label>
                    <Input
                      type="time"
                      value={newEndTime}
                      onChange={(e) => setNewEndTime(e.target.value)}
                      className="min-h-[44px]"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Type</label>
                    <select
                      value={newSlotType}
                      onChange={(e) => {
                        setNewSlotType(e.target.value)
                        setNewIsBreak(e.target.value === 'break')
                      }}
                      className="w-full min-h-[44px] rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="session">Session</option>
                      <option value="unconference">Unconference</option>
                      <option value="track">Track</option>
                      <option value="break">Break</option>
                      <option value="checkin">Check-in</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Label</label>
                    <Input
                      placeholder="Optional"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      className="min-h-[44px]"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setShowAddForm(false)} className="flex-1 sm:flex-none">
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleAdd} disabled={isAdding} className="flex-1 sm:flex-none">
                    <Plus className="h-4 w-4 mr-1" />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">Add Time Slot for {eventDays.find((d) => d.date === selectedDay)?.label}</span>
              <span className="sm:hidden">Add Slot</span>
            </Button>
          )}
        </>
      )}
    </div>
  )
}
