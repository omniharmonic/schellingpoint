'use client'

/**
 * Organizer controls over the voting rounds (inventory 5.10 / P2-14), plus the audit of what
 * has been done to them.
 *
 * What this panel deliberately does not show: any count. A round's card carries its rules and
 * its window; closing it tells you how many people took part (`ballotsCast`, the number the
 * public tally already carries) and nothing about what they chose. Results appear on Analytics
 * once the round is closed, held to k, exactly as before.
 */
import * as React from 'react'
import { AlertTriangle, History, Loader2, Lock, PlayCircle, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { apiFetch, ApiError } from '@/lib/api/client'
import { formatInEventTimezone, parseTimeInTimezone } from '@/lib/events/timezone'
import { ROUND_ACTION, ROUND_PHASE, ROUND_STATUS } from '@/lib/labels'

type Phase = 'pre-event' | 'attendance'
type RoundKey = 'pre' | 'attendance'

interface RoundInfo {
  id: string
  phase: Phase
  mechanism: string
  credits: number
  opensAt: string
  closesAt: string
  finalizedAt: string | null
  status: 'upcoming' | 'open' | 'closed'
}

interface RoundStateView {
  round: RoundInfo | null
  status: 'none' | 'upcoming' | 'open' | 'closed'
}

interface RoundActionRow {
  id: string
  roundId: string | null
  phase: Phase
  action: 'open' | 'extend' | 'close'
  actor: string | null
  detail: Record<string, unknown>
  createdAt: string
}

interface ControlsResponse {
  rounds: Record<Phase, RoundStateView>
  actions: RoundActionRow[]
}

const PHASES: Array<{ phase: Phase; key: RoundKey }> = [
  { phase: 'pre-event', key: 'pre' },
  { phase: 'attendance', key: 'attendance' },
]

/** `datetime-local` value for an instant in the gathering's timezone. */
function toLocalInput(iso: string | null | undefined, timezone: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? ''
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`
}

/** The same wall-clock reading, back to an instant in the gathering's timezone. */
function fromLocalInput(value: string, timezone: string): string | null {
  const [day, time] = value.split('T')
  if (!day || !time) return null
  try {
    return parseTimeInTimezone(time.slice(0, 5), day, timezone).toISOString()
  } catch {
    return null
  }
}

export function RoundControls({ eventSlug, timezone }: { eventSlug: string; timezone: string }) {
  const { toast } = useToast()
  const base = `/api/v1/events/${encodeURIComponent(eventSlug)}/rounds`
  const [data, setData] = React.useState<ControlsResponse | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [extendTo, setExtendTo] = React.useState<Record<Phase, string>>({ 'pre-event': '', attendance: '' })
  const [confirming, setConfirming] = React.useState<Phase | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<ControlsResponse>(base, { cache: 'no-store' })
      setData(res)
      setExtendTo({
        'pre-event': toLocalInput(res.rounds['pre-event'].round?.closesAt, timezone),
        attendance: toLocalInput(res.rounds.attendance.round?.closesAt, timezone),
      })
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The voting rounds could not be read.')
    } finally {
      setIsLoading(false)
    }
  }, [base, timezone])

  React.useEffect(() => { void load() }, [load])

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      toast({ title: done, variant: 'success' })
      await load()
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'That did not work. Please try again.'
      setError(message)
      toast({ title: 'Nothing changed', description: message, variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border p-4 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the voting rounds…
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-xl border p-4" data-testid="round-controls">
      <div className="space-y-1">
        <p className="text-sm font-medium">Round controls</p>
        <p className="text-sm text-muted-foreground">
          Open a round now, give it more time, or close it early. Closing runs the same path the
          scheduled close does: the ballot key is destroyed in that transaction and the entries
          become unlinkable. Nobody, you included, sees a count until a round is closed.
        </p>
      </div>

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

      {PHASES.map(({ phase, key }) => {
        const state = data?.rounds[phase]
        const round = state?.round ?? null
        const open = state?.status === 'open' || state?.status === 'upcoming'
        return (
          <div key={phase} className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid={`round-${key}`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{ROUND_PHASE[phase]}</p>
              <Badge variant={ROUND_STATUS[state?.status ?? 'none'].badge}>{ROUND_STATUS[state?.status ?? 'none'].label}</Badge>
              {round && (
                <span className="text-xs text-muted-foreground">
                  {round.credits} credits · {round.mechanism} · closes {formatInEventTimezone(new Date(round.closesAt), timezone, 'datetime')}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-2">
              {!open && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={busy === `open-${phase}`}
                  onClick={() => void run(`open-${phase}`, () => apiFetch(base, { method: 'POST', json: { round: key } }), 'Round opened')}
                >
                  <PlayCircle className="mr-1.5 h-4 w-4" aria-hidden />
                  Open now
                </Button>
              )}

              {open && (
                <>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    New closing time ({timezone})
                    <Input
                      type="datetime-local"
                      aria-label={`New closing time for the ${ROUND_PHASE[phase].toLowerCase()}`}
                      value={extendTo[phase]}
                      onChange={(e) => setExtendTo((prev) => ({ ...prev, [phase]: e.target.value }))}
                      // The panel sits inside the settings form; Enter here must not save settings.
                      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                      className="max-w-[15rem]"
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!extendTo[phase]}
                    loading={busy === `extend-${phase}`}
                    onClick={() => void run(
                      `extend-${phase}`,
                      () => apiFetch(base, { method: 'PATCH', json: { round: key, closesAt: fromLocalInput(extendTo[phase], timezone) } }),
                      'Voting has more time',
                    )}
                  >
                    <Timer className="mr-1.5 h-4 w-4" aria-hidden />
                    Extend
                  </Button>
                  {confirming === phase ? (
                    <ConfirmInline
                      layout="inline"
                      destructive
                      message="Close this round now? It seals the ballots, destroys the key and cannot be undone."
                      confirmLabel="Close the round"
                      loading={busy === `close-${phase}`}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => {
                        setConfirming(null)
                        void run(`close-${phase}`, () => apiFetch(`${base}?round=${key}`, { method: 'DELETE' }), 'Round closed')
                      }}
                    />
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(phase)}>
                      <Lock className="mr-1.5 h-4 w-4" aria-hidden />
                      Close now
                    </Button>
                  )}
                </>
              )}
            </div>

            {open && phase === 'pre-event' && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-signal-amber" aria-hidden />
                Closing early is final. Ballots already cast are counted; the link between a person
                and their votes is gone the moment it closes.
              </p>
            )}
            {!open && state?.status === 'closed' && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                Sealed. Results are on Analytics, held to the gathering&rsquo;s k.
              </p>
            )}
          </div>
        )
      })}

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <History className="h-4 w-4" aria-hidden />
          What has been done
        </p>
        {data && data.actions.length > 0 ? (
          <ul className="space-y-1" data-testid="round-actions">
            {data.actions.map((a) => (
              <li key={a.id} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{ROUND_ACTION[a.action].label}</span>
                {' · '}{ROUND_PHASE[a.phase]}
                {' · '}{formatInEventTimezone(new Date(a.createdAt), timezone, 'datetime')}
                {a.actor ? ` · ${a.actor}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing yet. Opening, extending or closing a round is recorded here.</p>
        )}
      </div>
    </div>
  )
}
