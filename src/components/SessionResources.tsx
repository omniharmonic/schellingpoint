'use client'

import * as React from 'react'
import {
  Loader2,
  Plus,
  X,
  ExternalLink,
  Presentation,
  Video,
  FileText,
  Link2,
  GitBranch,
  ArrowUp,
  ArrowDown,
  Paperclip,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FilterChip } from '@/components/ui/filter-chip'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { apiFetch } from '@/lib/api/client'
import { ReportButton } from '@/components/ReportButton'
import { ELLIPSIS } from '@/lib/format'
import { cn } from '@/lib/utils'

export type ResourceKind = 'slides' | 'recording' | 'notes' | 'link' | 'repo'

interface Resource {
  id: string
  session_id: string
  title: string
  url: string
  kind: ResourceKind
  display_order: number
  created_at: string
}

interface SessionResourcesProps {
  sessionId: string
  eventSlug: string
  /** Host, cohost, or event organizer - shows the add/remove controls */
  canManage: boolean
}

const KIND_META: Record<ResourceKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  slides: { label: 'Slides', icon: Presentation },
  recording: { label: 'Recording', icon: Video },
  notes: { label: 'Notes', icon: FileText },
  link: { label: 'Link', icon: Link2 },
  repo: { label: 'Repository', icon: GitBranch },
}

const KIND_ORDER: ResourceKind[] = ['slides', 'recording', 'notes', 'repo', 'link']

function isValidHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function SessionResources({ sessionId, eventSlug, canManage }: SessionResourcesProps) {
  const { toast } = useToast()
  const [resources, setResources] = React.useState<Resource[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [showForm, setShowForm] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [kind, setKind] = React.useState<ResourceKind>('link')
  const [isSaving, setIsSaving] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<Resource | null>(null)

  const endpoint = `/api/v1/events/${eventSlug}/sessions/${sessionId}/resources`
  const titleId = `resource-title-${sessionId}`
  const urlId = `resource-url-${sessionId}`

  const load = React.useCallback(async () => {
    try {
      const json = await apiFetch<{ resources: Resource[] }>(endpoint)
      setResources(json.resources ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resources could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [endpoint])

  React.useEffect(() => {
    load()
  }, [load])

  const urlTrimmed = url.trim()
  const urlLooksValid = urlTrimmed.length === 0 || isValidHttpUrl(urlTrimmed)
  const canSubmit = title.trim().length > 0 && urlTrimmed.length > 0 && urlLooksValid && !isSaving

  const closeForm = () => {
    setShowForm(false)
    setTitle('')
    setUrl('')
    setKind('link')
    setError(null)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setIsSaving(true)
    setError(null)
    try {
      const json = await apiFetch<{ resource: Resource }>(endpoint, {
        method: 'POST',
        json: { title: title.trim(), url: urlTrimmed, kind },
      })
      setResources((prev) => [...prev, json.resource])
      closeForm()
      toast({ title: 'Resource added', variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The resource could not be added. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleRemove = async (resource: Resource) => {
    setBusyId(resource.id)
    setError(null)
    try {
      await apiFetch(`${endpoint}?id=${encodeURIComponent(resource.id)}`, { method: 'DELETE' })
      setResources((prev) => prev.filter((r) => r.id !== resource.id))
      setRemoving(null)
      toast({ title: 'Resource removed', variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The resource could not be removed. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  const handleMove = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= resources.length) return
    const next = [...resources]
    ;[next[index], next[target]] = [next[target], next[index]]
    const previous = resources
    setResources(next)
    setBusyId(next[target].id)
    setError(null)
    try {
      const json = await apiFetch<{ resources: Resource[] }>(endpoint, {
        method: 'PATCH',
        json: { order: next.map((r) => r.id) },
      })
      setResources(json.resources ?? next)
    } catch (err) {
      setResources(previous)
      setError(err instanceof Error ? err.message : 'The order could not be saved, so it was put back. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  // Nothing to show for regular attendees when the list is empty.
  if (!isLoading && !canManage && resources.length === 0) {
    return null
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Paperclip className="h-4 w-4" aria-hidden />
            Resources
          </CardTitle>
          {canManage && !showForm && (
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden />
              Add resource
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading{ELLIPSIS}
          </div>
        ) : resources.length === 0 ? (
          !showForm && (
            <p className="text-sm text-muted-foreground">
              No resources yet. Add slides, a recording, notes or links for attendees.
            </p>
          )
        ) : (
          <ul className="space-y-2">
            {resources.map((resource, index) => {
              const meta = KIND_META[resource.kind] ?? KIND_META.link
              const Icon = meta.icon
              const isBusy = busyId === resource.id
              const isRemoving = removing?.id === resource.id
              return (
                <li key={resource.id} className="space-y-2">
                  <div
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-2 pl-3 transition-opacity',
                      isBusy && 'opacity-60'
                    )}
                  >
                    <div className="shrink-0 rounded-md bg-primary/10 p-1.5 text-primary">
                      <Icon className="h-4 w-4" aria-hidden />
                    </div>
                    <a
                      href={resource.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group min-w-0 flex-1"
                      title={resource.url}
                    >
                      <p className="truncate text-sm font-medium group-hover:underline">
                        {resource.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {meta.label} · {hostnameOf(resource.url)}
                      </p>
                    </a>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    {/* Somebody has to be able to say "this link is not what it says it is". */}
                    {!canManage && (
                      <ReportButton
                        eventSlug={eventSlug}
                        subjectKind="comment"
                        itemRef={`resource:${resource.id}`}
                        subjectLabel={resource.title}
                        iconOnly
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                    {canManage && !isRemoving && (
                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${resource.title} up`}
                          disabled={index === 0 || busyId !== null}
                          onClick={() => handleMove(index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${resource.title} down`}
                          disabled={index === resources.length - 1 || busyId !== null}
                          onClick={() => handleMove(index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${resource.title}`}
                          disabled={busyId !== null}
                          onClick={() => setRemoving(resource)}
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </div>
                  {isRemoving && (
                    <ConfirmInline
                      destructive
                      message={`Remove “${resource.title}”?`}
                      confirmLabel="Remove"
                      loading={isBusy}
                      onConfirm={() => handleRemove(resource)}
                      onCancel={() => setRemoving(null)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {canManage && showForm && (
          <form onSubmit={handleAdd} className="space-y-3 border-t pt-4" noValidate>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium leading-none">Kind</legend>
              <div className="flex flex-wrap gap-1.5 pt-2">
                {KIND_ORDER.map((k) => {
                  const Icon = KIND_META[k].icon
                  return (
                    <FilterChip key={k} pressed={kind === k} onClick={() => setKind(k)} icon={<Icon className="h-3.5 w-3.5" aria-hidden />}>
                      {KIND_META[k].label}
                    </FilterChip>
                  )
                })}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, 200))}
                placeholder="e.g. Slide deck"
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={urlId}>URL</Label>
              <Input
                id={urlId}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={`https://${ELLIPSIS}`}
                inputMode="url"
                required
                aria-invalid={!urlLooksValid}
                error={!urlLooksValid}
                aria-describedby={!urlLooksValid ? `${urlId}-error` : undefined}
              />
              {!urlLooksValid && (
                <p id={`${urlId}-error`} className="text-xs text-destructive">Enter a full URL starting with http:// or https://</p>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" size="sm" variant="outline" onClick={closeForm} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={isSaving} disabled={!canSubmit}>
                Add resource
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
