'use client'

/**
 * Bulk session blocks (design 2026-09-25 §4): a two-axis editor over the slot grid.
 *
 *   day tabs (the gathering's dates, with "copy from <day>")
 *     × one row per room (start, end, slot length, break, "closed this day")
 *     → a live preview grid and one POST of every slot, saved together or not at all.
 *
 * "Same as first room" (on by default) keeps a row in lockstep with the first until it is
 * unticked, and "Same times every day" (on by default when there is more than one day) keeps
 * every day the same. With both on, three choices — start, end, slot length — still produce the
 * uniform grid the previous generator produced, in the same number of interactions.
 *
 * Generation, conflict detection and the template shape are pure functions in
 * `src/lib/scheduling/slot-blocks.ts`, so the preview and the POST can never disagree.
 */

import * as React from 'react'
import { Ban, CalendarPlus, Coffee, Copy, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { plural } from '@/lib/format'
import {
  applyTemplate,
  BREAK_LENGTH_OPTIONS,
  conflictKeys,
  copyDayRooms,
  countSlots,
  formatClock,
  generateSlots,
  MAX_SLOTS_PER_SAVE,
  MAX_TEMPLATES,
  MAX_TEMPLATE_NAME,
  mirrorTiming,
  newPlan,
  planToTemplate,
  roomSkips,
  skippedTimes,
  slotKey,
  slotsForRoom,
  SLOT_LENGTH_OPTIONS,
  syncRooms,
  type DayPlan,
  type ExistingSlot,
  type GeneratedSlot,
  type RoomPattern,
  type SlotTemplate,
} from '@/lib/scheduling/slot-blocks'

export type { GeneratedSlot }

interface BulkSlotGeneratorProps {
  venues: { id: string; name: string; capacity: number | null }[]
  eventDays: { date: string; label: string }[]
  /** The gathering's timezone: the editor resolves every generated slot against it before saving. */
  timezone: string
  onGenerate: (slots: GeneratedSlot[]) => void
  onCancel: () => void
  isSaving?: boolean
  existingSlots?: ExistingSlot[]
  /** Saved shapes of this gathering. Omit the handler to hide the template controls. */
  templates?: SlotTemplate[]
  onTemplatesChange?: (next: SlotTemplate[]) => void | Promise<void>
  templatesBusy?: boolean
}

const lengthLabel = (minutes: number) =>
  minutes % 60 === 0 && minutes >= 60 ? plural(minutes / 60, 'hour') : `${minutes} min`

export function BulkSlotGenerator({
  venues,
  eventDays,
  timezone,
  onGenerate,
  onCancel,
  isSaving = false,
  existingSlots = [],
  templates,
  onTemplatesChange,
  templatesBusy = false,
}: BulkSlotGeneratorProps) {
  const id = React.useId()
  const dayKey = eventDays.map((d) => d.date).join(',')
  const venueKey = venues.map((v) => v.id).join(',')

  const [plan, setPlan] = React.useState<DayPlan[]>(() => newPlan(eventDays.map((d) => d.date), venues.map((v) => v.id)))
  const [activeDay, setActiveDay] = React.useState(eventDays[0]?.date ?? '')
  const [sameEveryDay, setSameEveryDay] = React.useState(eventDays.length > 1)
  const [templateChoice, setTemplateChoice] = React.useState('')
  const [templateName, setTemplateName] = React.useState('')
  const [namingTemplate, setNamingTemplate] = React.useState(false)
  const [confirmReplace, setConfirmReplace] = React.useState(false)
  const [templateError, setTemplateError] = React.useState<string | null>(null)

  // Rooms added or dates changed while the editor is open: start that shape from the defaults
  // rather than leaving rows pointing at a room that is gone.
  React.useEffect(() => {
    const dates = dayKey.split(',').filter(Boolean)
    setPlan(newPlan(dates, venueKey.split(',').filter(Boolean)))
    setActiveDay((current) => (dates.includes(current) ? current : (dates[0] ?? '')))
  }, [dayKey, venueKey])

  const day = plan.find((d) => d.dayDate === activeDay) ?? plan[0]
  const rooms = day?.rooms ?? []
  const nameOf = React.useCallback((venueId: string) => venues.find((v) => v.id === venueId)?.name ?? 'Room', [venues])

  /** Write one room's change, pull the lockstep rows along, and mirror the day when asked to. */
  const updateRoom = (index: number, patch: Partial<RoomPattern>) => {
    if (!day) return
    setPlan((prev) => {
      const current = prev.find((d) => d.dayDate === day.dayDate)
      if (!current) return prev
      const rows = syncRooms(current.rooms.map((room, i) => (i === index ? { ...room, ...patch } : room)))
      return prev.map((d) => {
        if (d.dayDate === day.dayDate) return { ...d, rooms: rows }
        // "Same times every day" mirrors the hours, never a closure: a room shut on the Sunday
        // is shut on the Sunday alone.
        return sameEveryDay ? { ...d, rooms: mirrorTiming(rows, d.rooms) } : d
      })
    })
  }

  const copyFrom = (sourceDate: string) => {
    setPlan((prev) => {
      const source = prev.find((d) => d.dayDate === sourceDate)
      if (!source || !day) return prev
      return prev.map((d) => (d.dayDate === day.dayDate ? { ...d, rooms: copyDayRooms(source.rooms, d.rooms) } : d))
    })
  }

  const setSameDays = (next: boolean) => {
    setSameEveryDay(next)
    if (!next || !day) return
    setPlan((prev) => {
      const source = prev.find((d) => d.dayDate === day.dayDate)
      if (!source) return prev
      return prev.map((d) => (d.dayDate === source.dayDate ? d : { ...d, rooms: mirrorTiming(source.rooms, d.rooms) }))
    })
  }

  const allSlots = React.useMemo(() => generateSlots(plan), [plan])
  const conflicts = React.useMemo(() => conflictKeys(allSlots, existingSlots), [allSlots, existingSlots])
  const counts = countSlots(allSlots)
  const perDay = React.useMemo(
    () => new Map(plan.map((d) => [d.dayDate, generateSlots([d]).length])),
    [plan],
  )
  const tooMany = counts.total > MAX_SLOTS_PER_SAVE
  const invalidRows = rooms.filter((room) => !room.closed && room.end <= room.start)
  // Times the gathering's timezone does not have (the morning the clocks go forward). The route
  // refuses to move a slot silently, so the editor has to ask before the POST, not after it.
  const skipped = React.useMemo(() => skippedTimes(allSlots, timezone), [allSlots, timezone])
  const firstSkipped = skipped.size > 0 ? [...skipped].sort()[0]!.split('|') : null

  /* ─────────────────────────── templates ─────────────────────────── */

  const saved = templates ?? []
  const commitTemplates = async (next: SlotTemplate[]) => {
    setTemplateError(null)
    try {
      await onTemplatesChange?.(next)
    } catch {
      setTemplateError('The template could not be saved. Try again.')
    }
  }

  /** The saved template this name would overwrite, if any. */
  const replacing = saved.find((t) => t.name.toLowerCase() === templateName.trim().toLowerCase()) ?? null

  const saveTemplate = async (confirmedReplace = false) => {
    const name = templateName.trim()
    if (!name) { setTemplateError('Give the template a name.'); return }
    // Saving over a name is a replacement, and a saved shape is work: say so before it goes.
    if (replacing && !confirmedReplace) { setConfirmReplace(true); return }
    const kept = saved.filter((t) => t.name.toLowerCase() !== name.toLowerCase())
    if (kept.length >= MAX_TEMPLATES) { setTemplateError(`Keep at most ${MAX_TEMPLATES} templates — delete one first.`); return }
    await commitTemplates([...kept, planToTemplate(name, plan, (venueId) => nameOf(venueId))])
    setConfirmReplace(false)
    setNamingTemplate(false)
    setTemplateName('')
    setTemplateChoice(name)
  }

  const useTemplate = () => {
    const template = saved.find((t) => t.name === templateChoice)
    if (!template) return
    setPlan(applyTemplate(template, eventDays.map((d) => d.date), venues))
    setSameEveryDay(false)
    setTemplateError(null)
  }

  const deleteTemplate = async () => {
    if (!templateChoice) return
    await commitTemplates(saved.filter((t) => t.name !== templateChoice))
    setTemplateChoice('')
  }

  return (
    <div className="space-y-4" data-testid="slot-block-editor">
      {eventDays.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Days">
          {eventDays.map((d) => (
            <Button
              key={d.date}
              size="sm"
              variant={d.date === activeDay ? 'default' : 'outline'}
              aria-pressed={d.date === activeDay}
              data-testid="slot-day-tab"
              data-day={d.date}
              onClick={() => setActiveDay(d.date)}
              className="whitespace-nowrap"
            >
              {d.label}
              <Badge variant={d.date === activeDay ? 'secondary' : 'muted'} className="ml-2 text-xs">{perDay.get(d.date) ?? 0}</Badge>
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch size="sm" checked={sameEveryDay} onCheckedChange={setSameDays} aria-labelledby={`${id}-same-days`} />
              <Label id={`${id}-same-days`} className="font-normal">Same times every day</Label>
            </div>
            {!sameEveryDay && eventDays.length > 1 && (
              <Select
                aria-label="Copy times from another day"
                value=""
                wrapperClassName="w-auto"
                data-testid="slot-copy-from"
                onChange={(e) => { if (e.target.value) copyFrom(e.target.value) }}
              >
                <option value="">Copy from…</option>
                {eventDays.filter((d) => d.date !== activeDay).map((d) => (
                  <option key={d.date} value={d.date}>Copy from {d.label}</option>
                ))}
              </Select>
            )}
          </div>
        </div>
      )}

      {onTemplatesChange && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
          {saved.length > 0 ? (
            <>
              <Select
                aria-label="Saved template"
                value={templateChoice}
                wrapperClassName="w-auto min-w-40"
                data-testid="slot-template-select"
                onChange={(e) => setTemplateChoice(e.target.value)}
              >
                <option value="">Saved templates…</option>
                {saved.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </Select>
              <Button size="sm" variant="outline" disabled={!templateChoice || templatesBusy} onClick={useTemplate}>
                <Copy className="h-4 w-4 mr-1.5" aria-hidden="true" />Apply template
              </Button>
              <Button size="sm" variant="ghost" disabled={!templateChoice || templatesBusy} onClick={() => void deleteTemplate()}>
                <Trash2 className="h-4 w-4 mr-1.5" aria-hidden="true" />Delete template
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No saved templates yet. Save this shape to reuse it next time — a clone of this gathering carries it too.</p>
          )}
          <div className="ml-auto flex items-center gap-2">
            {namingTemplate ? (
              <>
                <Input
                  aria-label="Template name"
                  autoFocus
                  value={templateName}
                  maxLength={MAX_TEMPLATE_NAME}
                  placeholder="e.g. Weekday shape"
                  className="h-9 w-48"
                  onChange={(e) => { setTemplateName(e.target.value); setConfirmReplace(false) }}
                />
                {replacing && !confirmReplace && (
                  <span className="text-xs text-signal-amber" data-testid="slot-template-replaces">Replaces “{replacing.name}”</span>
                )}
                <Button size="sm" onClick={() => void saveTemplate()} loading={templatesBusy}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setNamingTemplate(false); setConfirmReplace(false); setTemplateError(null) }}>Cancel</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setNamingTemplate(true)} disabled={templatesBusy}>
                <Save className="h-4 w-4 mr-1.5" aria-hidden="true" />Save as template
              </Button>
            )}
          </div>
          {confirmReplace && replacing && (
            <ConfirmInline
              layout="inline"
              className="w-full"
              message={<>Replace the saved template “{replacing.name}” with this configuration? The old shape is not kept.</>}
              confirmLabel="Replace"
              loading={templatesBusy}
              onConfirm={() => void saveTemplate(true)}
              onCancel={() => setConfirmReplace(false)}
            />
          )}
          {templateError && <p role="alert" className="w-full text-sm text-destructive">{templateError}</p>}
        </div>
      )}

      <div className="space-y-2">
        {rooms.map((room, index) => {
          const rowId = `${id}-r${index}`
          const locked = index > 0 && room.sameAsFirst
          const generated = slotsForRoom(room, day?.dayDate ?? '')
          const rowConflicts = generated.filter((s) => conflicts.has(slotKey(s))).length
          const rowSkipped = roomSkips(skipped, generated)
          return (
            <div
              key={room.venueId}
              data-testid="slot-room-row"
              data-venue-id={room.venueId}
              data-closed={room.closed ? 'true' : 'false'}
              className={cn('rounded-lg border p-3', room.closed && 'bg-muted/40', (rowConflicts > 0 || rowSkipped) && 'border-destructive/40')}
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-32 flex-1">
                  <p className="text-sm font-medium">{nameOf(room.venueId)}</p>
                  <p className="text-xs text-muted-foreground" data-testid="slot-room-summary">
                    {room.closed ? 'Closed this day' : `${plural(generated.filter((s) => !s.isBreak).length, 'slot')}${generated.some((s) => s.isBreak) ? `, ${plural(generated.filter((s) => s.isBreak).length, 'break')}` : ''}`}
                  </p>
                  {rowSkipped && (
                    <p className="text-xs text-destructive" data-testid="slot-room-skipped">
                      The clocks change this morning: one of these times does not exist. Start later, or use a different slot length.
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${rowId}-start`} className="text-xs">Start</Label>
                  <Input id={`${rowId}-start`} type="time" className="h-10 w-28" value={room.start} disabled={locked || room.closed}
                    onChange={(e) => updateRoom(index, { start: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${rowId}-end`} className="text-xs">End</Label>
                  <Input id={`${rowId}-end`} type="time" className="h-10 w-28" value={room.end} disabled={locked || room.closed}
                    aria-invalid={!room.closed && room.end <= room.start ? true : undefined}
                    onChange={(e) => updateRoom(index, { end: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${rowId}-length`} className="text-xs">Slot length</Label>
                  <Select id={`${rowId}-length`} className="h-10" wrapperClassName="w-auto" value={room.slotMinutes} disabled={locked || room.closed}
                    onChange={(e) => updateRoom(index, { slotMinutes: Number(e.target.value) })}>
                    {SLOT_LENGTH_OPTIONS.map((m) => <option key={m} value={m}>{lengthLabel(m)}</option>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${rowId}-break`} className="text-xs">Break</Label>
                  <Select id={`${rowId}-break`} className="h-10" wrapperClassName="w-auto" value={room.breakMinutes} disabled={locked || room.closed}
                    onChange={(e) => updateRoom(index, { breakMinutes: Number(e.target.value) })}>
                    {BREAK_LENGTH_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? 'None' : `${m} min`}</option>)}
                  </Select>
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <Switch
                    size="sm"
                    checked={room.closed}
                    onCheckedChange={(next) => updateRoom(index, { closed: next })}
                    aria-label={`Closed this day: ${nameOf(room.venueId)}`}
                  />
                  <span className="text-sm text-muted-foreground">Closed this day</span>
                </div>
                {index > 0 && (
                  <div className="flex items-center gap-2 pb-2">
                    <Checkbox
                      id={`${rowId}-same`}
                      checked={room.sameAsFirst}
                      onCheckedChange={(next) => updateRoom(index, { sameAsFirst: next === true })}
                    />
                    <Label htmlFor={`${rowId}-same`} className="font-normal">Same as first room</Label>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Preview: this day's rooms across their generated slots. */}
      {rooms.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {eventDays.find((d) => d.date === activeDay)?.label ?? 'This day'}: {plural(perDay.get(activeDay) ?? 0, 'slot')}
          </p>
          <div className="overflow-x-auto rounded-lg border bg-muted/30 p-3">
            <div className="min-w-max space-y-1.5">
              {rooms.map((room) => {
                const generated = slotsForRoom(room, day?.dayDate ?? '')
                return (
                  <div key={room.venueId} className="flex items-center gap-2" data-testid="slot-preview-row">
                    <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">{nameOf(room.venueId)}</span>
                    {room.closed ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Ban className="h-3 w-3" aria-hidden="true" />Closed</span>
                    ) : generated.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No slots — check the hours</span>
                    ) : (
                      generated.map((slot) => {
                        const clash = conflicts.has(slotKey(slot))
                        return (
                          <span
                            key={`${slot.startTime}-${slot.endTime}`}
                            data-testid="slot-preview-cell"
                            data-conflict={clash ? 'true' : undefined}
                            className={cn(
                              'whitespace-nowrap rounded px-2 py-1 text-xs',
                              clash ? 'bg-destructive/10 text-destructive ring-1 ring-destructive/40'
                                : slot.isBreak ? 'bg-signal-amber/10 text-signal-amber' : 'bg-background',
                            )}
                          >
                            {slot.isBreak && <Coffee className="mr-1 inline h-3 w-3" aria-hidden="true" />}
                            {formatClock(slot.startTime)}
                          </span>
                        )
                      })
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="slot-total">
            {plural(counts.total, 'slot')} in total across {plural(eventDays.length, 'day')}
            {counts.breaks > 0 ? ` (${plural(counts.breaks, 'break')})` : ''} · saved together or not at all
          </p>
        </div>
      )}

      {conflicts.size > 0 && (
        <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          {plural(conflicts.size, 'proposed slot')} {conflicts.size === 1 ? 'overlaps' : 'overlap'} availability this gathering already has. Change the hours, or close that room for the day, before adding slots.
        </p>
      )}
      {invalidRows.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {invalidRows.length === 1 ? 'One room ends' : `${invalidRows.length} rooms end`} before it starts — no slots are generated there.
        </p>
      )}
      {firstSkipped && (
        <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          {formatClock(firstSkipped[1]!)} does not exist on {eventDays.find((d) => d.date === firstSkipped[0])?.label ?? firstSkipped[0]} in {timezone}: the
          clocks go forward that morning. Change the hours or the slot length for the rooms marked below before adding slots.
        </p>
      )}
      {tooMany && (
        <p role="alert" className="text-sm text-destructive">
          That is {plural(counts.total, 'slot')}; at most {MAX_SLOTS_PER_SAVE.toLocaleString()} can be saved at once. Shorten the hours or do one day at a time.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={isSaving}>Cancel</Button>
        <Button
          onClick={() => onGenerate(allSlots)}
          loading={isSaving}
          disabled={counts.total === 0 || conflicts.size > 0 || tooMany || skipped.size > 0}
        >
          {!isSaving && <CalendarPlus className="h-4 w-4 mr-2" aria-hidden="true" />}
          Add {plural(counts.total, 'slot')}
        </Button>
      </div>
    </div>
  )
}
