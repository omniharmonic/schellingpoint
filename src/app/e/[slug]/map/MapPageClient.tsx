'use client'

/**
 * Participant map (spec §8.4): the gathering's area with venue pins (count badge of the selected
 * day's sessions) and self-hosted pins (exact for viewers with attendee details, ≈1 km otherwise —
 * the sessions API already applied the tier). Clicking a pin opens a panel (side on desktop,
 * bottom sheet on mobile) with that place's sessions in time order, "Now"/"Next" emphasis and
 * favourite hearts. "Near me" uses browser geolocation only; the position never leaves the page.
 * When the map cannot load, the same data renders as a list.
 *
 * The area comes from `GET …/map` (design §1.2): the organizer's saved view when there is one,
 * otherwise the fit of the located rooms. That read also carries the venue outlines members see —
 * clicking one opens the room's sessions, exactly as its pin does — and the gathering's indoor map
 * when the organizers uploaded one. None of the three is ever in a record.
 */
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Heart, Loader2, LocateFixed, MapPin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { FilterChip } from '@/components/ui/filter-chip'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { DashboardLayout } from '@/components/DashboardLayout'
import { GatheringMap, type MapHandle, type MapPin as Pin } from '@/components/map/GatheringMap'
import { useCustomMapLayer } from '@/components/map/CustomMapLayer'
import { useMapArea } from '@/components/map/useMapArea'
import type { MapShape } from '@/components/map/types'
import { setFavorite } from '@/components/SessionCard'
import { useAuth } from '@/hooks/useAuth'
import { useEvent } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { EN_DASH, plural } from '@/lib/format'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

type Session = SessionView

interface Place {
  id: string
  name: string
  kind: 'venue' | 'self' | 'coarse'
  lat: number | null
  lng: number | null
  sessions: Session[]
}

function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
}
function formatDayTab(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' })
}
function dateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}
function startOf(s: Session): string | null {
  return s.time_slot?.start_time ?? (s.is_self_hosted ? s.self_hosted_start_time : null)
}
function endOf(s: Session): string | null {
  return s.time_slot?.end_time ?? (s.is_self_hosted ? s.self_hosted_end_time : null)
}
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}

/** Now / Next relative to the clock, for emphasis in the panel. */
function timing(s: Session, now: number): 'now' | 'next' | null {
  const start = startOf(s)
  const end = endOf(s)
  if (!start) return null
  const st = Date.parse(start)
  const en = end ? Date.parse(end) : st + (s.duration ?? 30) * 60_000
  if (now >= st && now < en) return 'now'
  if (st > now && st - now <= 90 * 60_000) return 'next'
  return null
}

export function MapPageClient() {
  const router = useRouter()
  const event = useEvent()
  const { user } = useAuth()
  const { toast } = useToast()
  const tz = event.timezone
  const handleRef = React.useRef<MapHandle | null>(null)

  const [sessions, setSessions] = React.useState<Session[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null)
  const [selectedPlace, setSelectedPlace] = React.useState<string | null>(null)
  const [me, setMe] = React.useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = React.useState(false)
  const [mapFailed, setMapFailed] = React.useState(false)
  const [favoriteIds, setFavoriteIds] = React.useState<Set<string>>(new Set())
  const [toggling, setToggling] = React.useState<Set<string>>(new Set())
  const [now, setNow] = React.useState(() => Date.now())
  // The resolved area, the outlines members see and the indoor map (design §1.2/§1.4/§1.5).
  const area = useMapArea(event.slug)

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  React.useEffect(() => {
    let mounted = true
    apiFetch<{ sessions: Session[] }>(`/api/v1/events/${encodeURIComponent(event.slug)}/sessions?status=scheduled&timed=1&sort=time`)
      .then((data) => {
        if (!mounted) return
        setSessions(data.sessions)
        setFavoriteIds(new Set(data.sessions.filter((s) => s.is_favorite).map((s) => s.id)))
        setLoadError(null)
      })
      .catch((err) => mounted && setLoadError(err instanceof Error ? err.message : 'The map could not be loaded.'))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [event.slug, user?.id])

  const days = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const s of sessions) {
      const start = startOf(s)
      if (!start) continue
      const key = dateKey(start, tz)
      if (!map.has(key) || start < (map.get(key) as string)) map.set(key, start)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, start]) => ({ key, label: formatDayTab(start, tz) }))
  }, [sessions, tz])

  React.useEffect(() => {
    if (!selectedDay && days.length) {
      const today = dateKey(new Date().toISOString(), tz)
      setSelectedDay(days.find((d) => d.key === today)?.key ?? days[0]!.key)
    }
  }, [days, selectedDay, tz])

  // Places: every venue that hosts a scheduled session (pin only when it has a point) and every
  // self-hosted session with a point; counts are for the selected day.
  const places = React.useMemo<Place[]>(() => {
    const byVenue = new Map<string, Place>()
    const out: Place[] = []
    const onDay = (s: Session) => {
      const start = startOf(s)
      return !!start && !!selectedDay && dateKey(start, tz) === selectedDay
    }
    for (const s of sessions) {
      if (s.is_self_hosted) {
        if (!onDay(s)) continue
        out.push({
          id: `self:${s.id}`,
          name: s.title,
          kind: s.location_geo?.exact ? 'self' : 'coarse',
          lat: s.location_geo?.lat ?? null,
          lng: s.location_geo?.lng ?? null,
          sessions: [s],
        })
        continue
      }
      if (!s.venue) continue
      let place = byVenue.get(s.venue.id)
      if (!place) {
        place = { id: `venue:${s.venue.id}`, name: s.venue.name, kind: 'venue', lat: s.venue.geo?.lat ?? null, lng: s.venue.geo?.lng ?? null, sessions: [] }
        byVenue.set(s.venue.id, place)
        out.push(place)
      }
      if (onDay(s)) place.sessions.push(s)
    }
    for (const p of out) p.sessions.sort((a, b) => (startOf(a) ?? '').localeCompare(startOf(b) ?? ''))
    return out
  }, [sessions, selectedDay, tz])

  const pins = React.useMemo<Pin[]>(() => {
    const list: Pin[] = places
      .filter((p) => p.lat !== null && p.lng !== null)
      .map((p) => ({
        id: p.id,
        lat: p.lat as number,
        lng: p.lng as number,
        label: p.name,
        kind: p.kind,
        count: p.kind === 'venue' ? p.sessions.length : undefined,
        selected: p.id === selectedPlace,
      }))
    if (me) list.push({ id: 'me', lat: me.lat, lng: me.lng, label: 'You are here', kind: 'me' })
    return list
  }, [places, selectedPlace, me])

  // Outlines behave like pins: the label carries the room's name and a click opens its sessions.
  const shapes = React.useMemo<MapShape[]>(
    () => area.outlines.map((o) => ({ id: `venue:${o.venue_id}`, label: o.name, ring: o.ring, selected: `venue:${o.venue_id}` === selectedPlace })),
    [area.outlines, selectedPlace],
  )
  const gatheringCenter = React.useMemo(
    () => (area.view ? { lat: area.view.center[1], lng: area.view.center[0] } : null),
    [area.view],
  )
  const layer = useCustomMapLayer(area.customMap, gatheringCenter)

  const unplaced = React.useMemo(() => places.filter((p) => p.lat === null && p.sessions.length > 0), [places])
  const selected = places.find((p) => p.id === selectedPlace) ?? null

  const nearMe = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast({ title: 'Your browser does not offer location', variant: 'destructive' })
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setMe(p)
        setLocating(false)
        handleRef.current?.flyTo(p.lat, p.lng, 15)
        toast({ title: 'Showing your position', description: 'It stays in your browser and is never sent to the server.', variant: 'success' })
      },
      () => {
        setLocating(false)
        toast({ title: 'Your position is not available', description: 'Allow location access in your browser to use “Near me”.', variant: 'destructive' })
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    )
  }

  const toggleFavorite = async (sessionId: string) => {
    if (!user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/map`)}`)
      return
    }
    const was = favoriteIds.has(sessionId)
    const flip = (on: boolean) => setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
    flip(!was)
    setToggling((prev) => new Set(prev).add(sessionId))
    try {
      await setFavorite(event.slug, sessionId, !was)
      toast({ title: was ? 'Removed from my schedule' : 'Saved to my schedule', variant: 'success' })
    } catch (err) {
      flip(was)
      toast({ title: 'Your saved schedule could not be updated', description: err instanceof Error ? err.message : 'Please try again.', variant: 'destructive' })
    } finally {
      setToggling((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }

  const sessionRow = (s: Session) => {
    const start = startOf(s)
    const end = endOf(s)
    const when = timing(s, now)
    const fav = favoriteIds.has(s.id)
    return (
      <li key={s.id} className={cn('flex items-start gap-3 py-2', when === 'now' && 'rounded-md bg-primary/5 px-2 -mx-2')}>
        <div className="w-20 shrink-0 text-xs text-muted-foreground">
          {start ? formatTime(start, tz) : EN_DASH}
          {end && <><br />{formatTime(end, tz)}</>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {when === 'now' && <Badge variant="success">Now</Badge>}
            {when === 'next' && <Badge variant="secondary">Next</Badge>}
            <Link href={`/e/${event.slug}/sessions/${s.id}`} className="truncate font-medium hover:underline">{s.title}</Link>
          </div>
          <p className="truncate text-xs text-muted-foreground">{hostByline(s)}{s.track ? ` · ${s.track.name}` : ''}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => toggleFavorite(s.id)}
          loading={toggling.has(s.id)}
          aria-pressed={fav}
          aria-label={fav ? `Remove ${s.title} from my schedule` : `Save ${s.title} to my schedule`}
        >
          <Heart className={cn('h-4 w-4', fav ? 'fill-favorite text-favorite' : 'text-muted-foreground')} aria-hidden />
        </Button>
      </li>
    )
  }

  const placeList = (list: Place[]) => (
    <ul className="space-y-4">
      {list.map((p) => (
        <li key={p.id} className="rounded-lg border p-3">
          <div className="mb-1 flex items-center gap-2">
            <MapPin className={cn('h-4 w-4', p.kind === 'venue' ? 'text-primary' : 'text-favorite')} aria-hidden />
            <h3 className="font-semibold">{p.name}</h3>
            {p.kind === 'coarse' && <Badge variant="outline">Approximate</Badge>}
            {p.kind !== 'venue' && <Badge variant="amber">Self-hosted</Badge>}
            {me && p.lat !== null && p.lng !== null && (
              <span className="ml-auto text-xs text-muted-foreground">{distanceKm(me, { lat: p.lat, lng: p.lng }).toFixed(1)} km</span>
            )}
          </div>
          {p.sessions.length ? <ul className="divide-y">{p.sessions.map(sessionRow)}</ul> : <p className="text-sm text-muted-foreground">No sessions here on this day.</p>}
        </li>
      ))}
    </ul>
  )

  const sortedForList = React.useMemo(() => {
    const list = places.filter((p) => p.sessions.length > 0)
    if (!me) return list
    return [...list].sort((a, b) => {
      const da = a.lat !== null && a.lng !== null ? distanceKm(me, { lat: a.lat, lng: a.lng }) : Infinity
      const db = b.lat !== null && b.lng !== null ? distanceKm(me, { lat: b.lat, lng: b.lng }) : Infinity
      return da - db
    })
  }, [places, me])

  const header = (
    <PageHeader
      title="Map"
      subtitle={loading ? undefined : `${plural(pins.filter((p) => p.kind !== 'me').length, 'place')} on the map`}
      actions={
        <Button variant="outline" size="sm" onClick={nearMe} loading={locating}>
          <LocateFixed className="mr-1.5 h-4 w-4" aria-hidden />
          Near me
        </Button>
      }
    />
  )

  if (loading) {
    return (
      <DashboardLayout>
        {header}
        <div className="flex h-64 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" aria-hidden /><span className="sr-only">Loading</span></div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      {header}
      {loadError && <p className="mb-4 text-sm text-destructive" role="alert">{loadError}</p>}
      {days.length > 1 && (
        <div className="mb-3 overflow-x-auto">
          {days.length <= 5 ? (
            <SegmentedControl aria-label="Day" value={selectedDay ?? days[0]!.key} onValueChange={(v) => { setSelectedDay(v); setSelectedPlace(null) }} options={days.map((d) => ({ value: d.key, label: d.label }))} size="sm" />
          ) : (
            <div className="flex gap-2">
              {days.map((d) => <FilterChip key={d.key} pressed={selectedDay === d.key} onClick={() => { setSelectedDay(d.key); setSelectedPlace(null) }}>{d.label}</FilterChip>)}
            </div>
          )}
        </div>
      )}
      {sessions.length === 0 && !loadError && (
        <p className="text-sm text-muted-foreground">Nothing is on the schedule yet. Places appear here once sessions are scheduled.</p>
      )}

      {mapFailed ? (
        <div className="space-y-3" data-testid="map-list-fallback">
          <p className="text-sm text-muted-foreground">The map could not be loaded, so here is the list.</p>
          {placeList(sortedForList)}
        </div>
      ) : (
        <div className="relative flex flex-col gap-3 md:flex-row" style={{ minHeight: 'min(70vh, 640px)' }}>
          <div className="relative h-[55vh] min-h-[320px] flex-1 overflow-hidden rounded-lg border md:h-auto" data-testid="gathering-map">
            <GatheringMap
              pins={pins}
              view={area.view}
              shapes={shapes}
              image={layer.image}
              basemap={layer.basemap}
              clampTo={layer.clampTo}
              handleRef={handleRef}
              onPinClick={(id) => { if (id !== 'me') setSelectedPlace(id) }}
              onShapeClick={(id) => setSelectedPlace(id)}
              onError={() => setMapFailed(true)}
            />
            {unplaced.length > 0 && (
              <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow">
                {plural(unplaced.length, 'place')} without a pin yet
              </div>
            )}
          </div>

          {selected && (
            <aside
              /* The sheet sits above the floating bar on a phone (design §2.4); on desktop it is
                 a static column again and the offset folds away. */
              className="above-mobile-bar fixed inset-x-0 z-30 max-h-[55vh] overflow-y-auto rounded-t-xl border bg-background p-4 shadow-lg md:static md:max-h-none md:w-80 md:shrink-0 md:rounded-lg md:shadow-none"
              aria-label={`Sessions at ${selected.name}`}
              data-testid="map-panel"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">{selected.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.kind === 'coarse' ? 'Approximate area · exact spot for confirmed attendees' : plural(selected.sessions.length, 'session')}
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={() => setSelectedPlace(null)} aria-label="Close"><X className="h-4 w-4" aria-hidden /></Button>
              </div>
              {selected.sessions.length ? <ul className="divide-y">{selected.sessions.map(sessionRow)}</ul> : <p className="text-sm text-muted-foreground">No sessions here on this day.</p>}
            </aside>
          )}
          {!selected && (
            <aside className="hidden md:block md:w-80 md:shrink-0">
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                Pick a pin to see its sessions for the day.
                {unplaced.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 font-medium text-foreground">Not on the map yet</p>
                    <ul className="list-disc space-y-0.5 pl-4">{unplaced.map((p) => <li key={p.id}>{p.name} · {plural(p.sessions.length, 'session')}</li>)}</ul>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
    </DashboardLayout>
  )
}
