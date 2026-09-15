'use client'

import * as React from 'react'
import { AlertCircle, Check, ChevronDown, ChevronUp, Globe, GripVertical, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { SkillPicker } from '@/components/SkillPicker'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
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
  const canManage = can('manageTracks')
  const base = `/api/v1/events/${event.slug}/admin/tracks`

  const [tracks, setTracks] = React.useState<AdminTrack[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [editingTrack, setEditingTrack] = React.useState<AdminTrack | null>(null)
  const [isCreating, setIsCreating] = React.useState(false)
  const [formData, setFormData] = React.useState<TrackFormData>(EMPTY_FORM)
  const [isSaving, setIsSaving] = React.useState(false)
  const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null)
  const [draggedTrack, setDraggedTrack] = React.useState<AdminTrack | null>(null)

  React.useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 5000)
    return () => window.clearTimeout(timer)
  }, [status])

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
    else setStatus(success)
  }

  const cancelEdit = () => {
    setEditingTrack(null)
    setIsCreating(false)
    setFormData(EMPTY_FORM)
  }

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setError('Track name is required')
      return
    }
    setIsSaving(true)
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
      setError(errorText(e, editingTrack ? 'The track could not be updated.' : 'The track could not be created.'))
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
      report(res.network, res.sessionsWithoutTrack ? `Track deleted. ${res.sessionsWithoutTrack} session${res.sessionsWithoutTrack === 1 ? '' : 's'} now have no track.` : 'Track deleted.')
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
    setFormData({ name: track.name, color: track.color || COLOR_PALETTE[0], description: track.description || '', skill_uris: track.skill_uris, is_active: track.is_active })
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-12" role="status" aria-label="Loading"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="max-w-4xl">
      <div className="page-heading mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold">Tracks</h1>
          <p className="text-muted-foreground">Organize sessions by theme, and connect each track to shared skills</p>
        </div>
        {canManage && !isCreating && !editingTrack && (
          <Button onClick={() => { setIsCreating(true); setEditingTrack(null); setFormData(EMPTY_FORM) }}>
            <Plus className="h-4 w-4 mr-2" />
            Add track
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-6 p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setError(null)} aria-label="Dismiss"><X className="h-4 w-4" /></Button>
        </div>
      )}
      {status && <p role="status" className="mb-6 rounded-lg border border-primary/30 p-4 text-sm">{status}</p>}

      {(isCreating || editingTrack) && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{editingTrack ? 'Edit track' : 'Create track'}</CardTitle>
            <CardDescription>{editingTrack ? 'Update track details' : 'Add a new track for organizing sessions'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="track-name" className="text-sm font-medium">Name <span className="text-destructive">*</span></label>
              <Input id="track-name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g., Technical, Governance, Community" maxLength={50} />
            </div>
            <div className="space-y-2">
              <span id="track-color-label" className="text-sm font-medium">Color</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="track-color-label">
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={formData.color === color}
                    aria-label={color}
                    onClick={() => setFormData({ ...formData, color })}
                    className={cn('w-8 h-8 rounded-full transition-transform', formData.color === color && 'ring-2 ring-offset-2 ring-primary scale-110')}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="track-description" className="text-sm font-medium">Description</label>
              <Textarea id="track-description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="What belongs in this track…" rows={3} maxLength={200} />
              <p className="text-xs text-muted-foreground">{formData.description.length}/200</p>
            </div>
            <SkillPicker
              value={formData.skill_uris}
              onChange={(skill_uris) => setFormData({ ...formData, skill_uris })}
              max={20}
              label="Skills"
              description="Skills from the shared taxonomy help people find this track across gatherings and schools."
              disabled={isSaving}
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={formData.is_active} onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })} />
              Active (offered in proposal forms)
            </label>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={cancelEdit} disabled={isSaving}>Cancel</Button>
              <Button onClick={() => void handleSave()} disabled={isSaving}>
                {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {editingTrack ? 'Save changes' : 'Create track'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Tracks ({tracks.length})</CardTitle>
          <CardDescription>Drag, or use the arrows, to reorder. Tracks appear in this order in session forms.</CardDescription>
        </CardHeader>
        <CardContent>
          {tracks.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No tracks yet.</div>
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
                  className={cn('flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-background transition-colors', draggedTrack?.id === track.id && 'opacity-50', draggedTrack && draggedTrack.id !== track.id && 'border-dashed')}
                >
                  {canManage && <GripVertical className="h-4 w-4 text-muted-foreground cursor-move flex-shrink-0" aria-hidden />}
                  <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: track.color || '#64748b' }} aria-hidden />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{track.name}</span>
                      {!track.is_active && <Badge variant="outline" className="text-xs">Inactive</Badge>}
                      {track.network_published && <Badge variant="outline" className="text-xs gap-1"><Globe className="h-3 w-3" />On the network</Badge>}
                      {track.skill_uris.length > 0 && <Badge variant="secondary" className="text-xs">{track.skill_uris.length} skill{track.skill_uris.length === 1 ? '' : 's'}</Badge>}
                    </div>
                    {track.description && <p className="text-sm text-muted-foreground truncate">{track.description}</p>}
                  </div>
                  <Badge variant="secondary" className="flex-shrink-0">{track.session_count} sessions</Badge>
                  {canManage && (deleteConfirm === track.id ? (
                    <div className="flex items-center gap-2" role="alertdialog" aria-label={`Delete ${track.name}`}>
                      <span className="text-xs text-destructive">{track.session_count > 0 ? `${track.session_count} sessions will lose their track.` : 'Delete this track?'}</span>
                      <Button variant="destructive" size="sm" onClick={() => void handleDelete(track.id)} disabled={isSaving} aria-label="Confirm delete">{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}</Button>
                      <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)} disabled={isSaving} aria-label="Cancel delete"><X className="h-4 w-4" /></Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => moveTrack(track, -1)} disabled={index === 0} aria-label={`Move ${track.name} up`}><ChevronUp className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => moveTrack(track, 1)} disabled={index === tracks.length - 1} aria-label={`Move ${track.name} down`}><ChevronDown className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => startEdit(track)} aria-label={`Edit ${track.name}`}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(track.id)} className="text-destructive hover:text-destructive" aria-label={`Delete ${track.name}`}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
