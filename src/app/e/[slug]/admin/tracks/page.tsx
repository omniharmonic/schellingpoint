'use client'

import * as React from 'react'
import { AlertCircle, ChevronDown, ChevronUp, Globe, GripVertical, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { SkillPicker } from '@/components/SkillPicker'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { networkNotice, type AdminTrack, type NetworkSync } from '@/components/admin/types'

const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#78716c', '#64748b', '#475569',
]

interface TrackFormData {
  name: string
  color: string
  description: string
  skill_uris: string[]
  is_active: boolean
}

const EMPTY_FORM: TrackFormData = { name: '', color: COLOR_PALETTE[0], description: '', skill_uris: [], is_active: true }

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export default function AdminTracksPage() {
  const event = useEvent()
  const { can } = useEventRole()
  const { toast } = useToast()
  const canManage = can('manageTracks')
  const base = `/api/v1/events/${event.slug}/admin/tracks`

  const [tracks, setTracks] = React.useState<AdminTrack[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [editingTrack, setEditingTrack] = React.useState<AdminTrack | null>(null)
  const [isCreating, setIsCreating] = React.useState(false)
  const [formData, setFormData] = React.useState<TrackFormData>(EMPTY_FORM)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null)
  const [draggedTrack, setDraggedTrack] = React.useState<AdminTrack | null>(null)
  const nameRef = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ tracks: AdminTrack[] }>(base)
      setTracks(res.tracks)
    } catch (e) {
      setError(errorText(e, 'Tracks could not be loaded.'))
    } finally {
      setIsLoading(false)
    }
  }, [base])

  React.useEffect(() => { void load() }, [load])

  const report = (sync: NetworkSync | undefined, success: string) => {
    const warning = networkNotice(sync)
    if (warning) setError(warning)
    else toast({ title: success, variant: 'success' })
  }

  const cancelEdit = () => {
    setEditingTrack(null)
    setIsCreating(false)
    setFormData(EMPTY_FORM)
    setFormError(null)
  }

  const openCreate = () => {
    setIsCreating(true)
    setEditingTrack(null)
    setFormData(EMPTY_FORM)
    setFormError(null)
    window.requestAnimationFrame(() => nameRef.current?.focus())
  }

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setFormError('Give the track a name.')
      nameRef.current?.focus()
      return
    }
    setIsSaving(true)
    setFormError(null)
    setError(null)
    const body = {
      name: formData.name.trim(),
      color: formData.color,
      description: formData.description.trim() || null,
      skill_uris: formData.skill_uris,
      is_active: formData.is_active,
    }
    try {
      const res = editingTrack
        ? await apiFetch<{ network: NetworkSync }>(`${base}/${editingTrack.id}`, { method: 'PATCH', json: body })
        : await apiFetch<{ network: NetworkSync }>(base, { method: 'POST', json: body })
      cancelEdit()
      await load()
      report(res.network, editingTrack ? 'Track updated.' : 'Track created.')
    } catch (e) {
      setFormError(errorText(e, editingTrack ? 'The track could not be updated.' : 'The track could not be created.'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (trackId: string) => {
    setIsSaving(true)
    setError(null)
    try {
      const res = await apiFetch<{ sessionsWithoutTrack: number; network: NetworkSync }>(`${base}/${trackId}`, { method: 'DELETE' })
      setDeleteConfirm(null)
      await load()
      report(res.network, res.sessionsWithoutTrack ? `Track deleted. ${plural(res.sessionsWithoutTrack, 'session')} now ${res.sessionsWithoutTrack === 1 ? 'has' : 'have'} no track.` : 'Track deleted.')
    } catch (e) {
      setError(errorText(e, 'The track could not be deleted.'))
    } finally {
      setIsSaving(false)
    }
  }

  const saveOrder = async (ordered: AdminTrack[]) => {
    const previous = tracks
    setTracks(ordered.map((t, i) => ({ ...t, display_order: i })))
    try {
      const res = await apiFetch<{ tracks: AdminTrack[] }>(base, { method: 'PUT', json: { order: ordered.map((t) => t.id) } })
      setTracks(res.tracks)
    } catch (e) {
      setTracks(previous)
      setError(errorText(e, 'The new order could not be saved.'))
    }
  }

  const moveTrack = (track: AdminTrack, offset: number) => {
    const index = tracks.findIndex((t) => t.id === track.id)
    const target = index + offset
    if (target < 0 || target >= tracks.length) return
    const next = [...tracks]
    next.splice(index, 1)
    next.splice(target, 0, track)
    void saveOrder(next)
  }

  const handleDrop = (target: AdminTrack) => {
    if (!draggedTrack || draggedTrack.id === target.id) return
    const next = tracks.filter((t) => t.id !== draggedTrack.id)
    next.splice(tracks.findIndex((t) => t.id === target.id), 0, draggedTrack)
    setDraggedTrack(null)
    void saveOrder(next)
  }

  const startEdit = (track: AdminTrack) => {
    setEditingTrack(track)
    setIsCreating(false)
    setFormError(null)
    setFormData({ name: track.name, color: track.color || COLOR_PALETTE[0], description: track.description || '', skill_uris: track.skill_uris, is_active: track.is_active })
    window.requestAnimationFrame(() => nameRef.current?.focus())
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-12" role="status" aria-label="Loading"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  const formOpen = isCreating || Boolean(editingTrack)

  return (
    <div>
      <PageHeader
        title="Tracks"
        subtitle="Organize sessions by theme, and connect each track to shared skills."
        actions={canManage && !formOpen && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
            Add track
          </Button>
        )}
      />

      {error && (
        <Alert variant="destructive" className="mb-6 flex items-start gap-3 [&>svg~*]:pl-0">
          <AlertCircle className="h-5 w-5" aria-hidden="true" />
          <AlertDescription className="flex-1 pl-7">{error}</AlertDescription>
          <Button variant="ghost" size="icon-sm" className="-my-2 shrink-0" onClick={() => setError(null)} aria-label="Dismiss"><X className="h-4 w-4" aria-hidden="true" /></Button>
        </Alert>
      )}

      {formOpen && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{editingTrack ? 'Edit track' : 'New track'}</CardTitle>
            <CardDescription>{editingTrack ? 'Changes apply to every session in this track.' : 'Tracks group sessions by theme and appear in the proposal form.'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="track-name">Name</Label>
              <Input ref={nameRef} id="track-name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Technical, Governance, Community" maxLength={50} aria-invalid={formError && !formData.name.trim() ? true : undefined} />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Color</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Track color">
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={formData.color === color}
                    aria-label={color}
                    onClick={() => setFormData({ ...formData, color })}
                    className={cn('flex h-10 w-10 items-center justify-center rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', formData.color === color && 'ring-2 ring-offset-2 ring-primary scale-110')}
                  >
                    <span className="h-7 w-7 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="track-description">Description (optional)</Label>
              <Textarea id="track-description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="What belongs in this track…" rows={3} maxLength={200} />
              <p className="text-xs text-muted-foreground">{formData.description.length}/200</p>
            </div>
            <SkillPicker
              value={formData.skill_uris}
              onChange={(skill_uris) => setFormData({ ...formData, skill_uris })}
              max={20}
              label="Skills (optional)"
              description="Skills from the shared taxonomy help people find this track across gatherings and schools."
              disabled={isSaving}
            />
            <div className="flex items-center gap-2">
              <Checkbox id="track-active" checked={formData.is_active} onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked === true })} />
              <Label htmlFor="track-active" className="font-normal">Active (offered in proposal forms)</Label>
            </div>
            {formError && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{formError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={cancelEdit} disabled={isSaving}>Cancel</Button>
              <Button onClick={() => void handleSave()} loading={isSaving}>
                {editingTrack ? 'Save changes' : 'Create track'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{plural(tracks.length, 'track')}</CardTitle>
          <CardDescription>Drag, or use the arrows, to reorder. Tracks appear in this order in session forms.</CardDescription>
        </CardHeader>
        <CardContent>
          {tracks.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No tracks yet. Tracks help people find sessions by theme.</p>
              {canManage && !formOpen && (
                <Button className="mt-4" onClick={openCreate}><Plus className="h-4 w-4 mr-2" aria-hidden="true" />Add your first track</Button>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {tracks.map((track, index) => (
                <li
                  key={track.id}
                  draggable={canManage}
                  onDragStart={() => setDraggedTrack(track)}
                  onDragEnd={() => setDraggedTrack(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(track)}
                  className={cn('space-y-2 p-3 rounded-xl border bg-background transition-colors', draggedTrack?.id === track.id && 'opacity-50', draggedTrack && draggedTrack.id !== track.id && 'border-dashed')}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    {canManage && <GripVertical className="h-4 w-4 text-muted-foreground cursor-move flex-shrink-0" aria-hidden="true" />}
                    <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: track.color || '#64748b' }} aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{track.name}</span>
                        {!track.is_active && <Badge variant="muted">Inactive</Badge>}
                        {track.network_published && <Badge variant="outline" className="gap-1"><Globe className="h-3 w-3" aria-hidden="true" />On the network</Badge>}
                        {track.skill_uris.length > 0 && <Badge variant="secondary">{plural(track.skill_uris.length, 'skill')}</Badge>}
                      </div>
                      {track.description && <p className="text-sm text-muted-foreground truncate">{track.description}</p>}
                    </div>
                    <Badge variant="secondary" className="flex-shrink-0">{plural(track.session_count, 'session')}</Badge>
                    {canManage && deleteConfirm !== track.id && (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => moveTrack(track, -1)} disabled={index === 0} aria-label={`Move ${track.name} up`}><ChevronUp className="h-4 w-4" aria-hidden="true" /></Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => moveTrack(track, 1)} disabled={index === tracks.length - 1} aria-label={`Move ${track.name} down`}><ChevronDown className="h-4 w-4" aria-hidden="true" /></Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => startEdit(track)} aria-label={`Edit ${track.name}`}><Pencil className="h-4 w-4" aria-hidden="true" /></Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDeleteConfirm(track.id)} className="text-destructive hover:text-destructive" aria-label={`Delete ${track.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
                      </div>
                    )}
                  </div>
                  {canManage && deleteConfirm === track.id && (
                    <ConfirmInline
                      layout="inline"
                      destructive
                      message={track.session_count > 0 ? `Delete “${track.name}”? ${plural(track.session_count, 'session')} will lose ${track.session_count === 1 ? 'its' : 'their'} track.` : `Delete “${track.name}”?`}
                      confirmLabel="Delete"
                      loading={isSaving}
                      onConfirm={() => void handleDelete(track.id)}
                      onCancel={() => setDeleteConfirm(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
