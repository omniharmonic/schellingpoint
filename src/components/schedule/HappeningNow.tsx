'use client'

/**
 * "Happening now" (design §11), the strip at the top of the My schedule tab: while the attendance
 * round is open, the sessions inside their slot ± 15 min on the server's clock, each with the
 * tap-to-vote control for that round. Saved sessions come first; the rest of the timed program
 * follows so a session the viewer walked into unplanned can still be voted for.
 *
 * Nothing here is a count of anyone else's votes — only the viewer's own credits left (spec §5.3).
 */

import * as React from 'react'
import Link from 'next/link'
import { Clock, MapPin, Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { VoteControl } from '@/components/VoteControl'
import { useVoting } from '@/hooks/useVoting'
import { apiFetch, listFrom } from '@/lib/api/client'
import { EN_DASH, plural } from '@/lib/format'
import { formatLabel } from '@/lib/sessions/constants'
import { hostByline } from '@/app/api/v1/sessions/_lib/byline'
import { cn } from '@/lib/utils'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'
import { withWhen, type ScheduleSession } from './useSchedule'
import { formatTime } from './ScheduleCard'

export function HappeningNow({
  eventSlug,
  timeZone,
  saved,
}: {
  eventSlug: string
  timeZone: string
  saved: ScheduleSession[]
}) {
  const attendance = useVoting(eventSlug, 'attendance')
  const open = attendance.signedIn && attendance.attendanceOpen && attendance.status === 'open'
  const [timed, setTimed] = React.useState<SessionView[] | null>(null)

  // The window moves with the clock: re-read the round (and the votable set) every minute.
  React.useEffect(() => {
    if (!open) return
    const id = setInterval(() => void attendance.refresh(), 60_000)
    return () => clearInterval(id)
  }, [open, attendance.refresh])

  React.useEffect(() => {
    if (!open) return
    let mounted = true
    apiFetch<{ sessions: SessionView[] }>(`/api/v1/events/${encodeURIComponent(eventSlug)}/sessions?timed=1&sort=time`)
      .then((data) => {
        if (mounted) setTimed(listFrom<SessionView>(data, 'sessions'))
      })
      .catch(() => {
        if (mounted) setTimed([])
      })
    return () => {
      mounted = false
    }
  }, [open, eventSlug, attendance.votableNow.size])

  if (!open) return null
  const savedIds = new Set(saved.map((s) => s.id))
  const savedNow = saved.filter((s) => attendance.votableNow.has(s.id))
  const othersNow = (timed ?? []).filter((s) => attendance.votableNow.has(s.id) && !savedIds.has(s.id))
  const rows = [...savedNow, ...othersNow.map(withWhen)]

  return (
    <section
      aria-labelledby="happening-now-title"
      data-testid="happening-now"
      className="rounded-xl border border-primary/30 bg-primary/5 p-4"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="happening-now-title" className="flex items-center gap-2 text-base font-semibold">
          <Radio className="h-5 w-5 text-primary" aria-hidden />
          Happening now
        </h2>
        <p className="text-xs text-muted-foreground">
          {plural(attendance.remaining, 'attendance credit')} left — vote for a session while you are in it
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is in session right now. Votes open 15 minutes before a session starts.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((session) => (
            <li key={session.id}>
              <Card className={cn(!savedIds.has(session.id) && 'border-dashed')}>
                <CardContent className="flex items-start justify-between gap-4 p-4 pt-4">
                  <Link
                    href={`/e/${eventSlug}/sessions/${session.id}`}
                    className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary">{formatLabel(session.format)}</Badge>
                      {session.when && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden />
                          {formatTime(session.when.start_time, timeZone)}
                          {session.when.end_time ? ` ${EN_DASH} ${formatTime(session.when.end_time, timeZone)}` : ''}
                        </span>
                      )}
                      {(session.venue || session.is_self_hosted) && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" aria-hidden />
                          {session.is_self_hosted ? 'Self-hosted' : session.venue?.name}
                        </span>
                      )}
                    </div>
                    <h3 className="font-medium">{session.title}</h3>
                    <p className="text-sm text-muted-foreground">{hostByline(session)}</p>
                  </Link>
                  <VoteControl
                    eventSlug={eventSlug}
                    sessionId={session.id}
                    sessionTitle={session.title}
                    round="attendance"
                    compact
                  />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
