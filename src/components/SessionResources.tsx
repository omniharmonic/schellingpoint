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
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api/client'
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
  const [resources, setResources] = React.useState<Resource[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [showForm, setShowForm] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [kind, setKind] = React.useState<ResourceKind>('link')
  const [isSaving, setIsSaving] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const endpoint = `/api/v1/events/${eventSlug}/sessions/${sessionId}/resources`

  const load = React.useCallback(async () => {
    try {
      const json = await apiFetch<{ resources: Resource[] }>(endpoint)
      setResources(json.resources ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resources')
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
      setTitle('')
      setUrl('')
      setKind('link')
      setShowForm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add resource')
    } finally {
      setIsSaving(false)
    }
  }

  const handleRemove = async (resource: Resource) => {
    if (!confirm(`Remove "${resource.title}"?`)) return
    setBusyId(resource.id)
    setError(null)
    try {
      await apiFetch(`${endpoint}?id=${encodeURIComponent(resource.id)}`, { method: 'DELETE' })
      setResources((prev) => prev.filter((r) => r.id !== resource.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove resource')
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
      setError(err instanceof Error ? err.message : 'Failed to reorder resources')
    } finally {
      setBusyId(null)
    }
  }

  // Nothing to show for regular attendees when the list is empty.
  if (!isLoading && !canManage && resources.length === 0) {
    return null
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Paperclip className="h-4 w-4" />
          Resources
        </h3>
        {canManage && !showForm && (
          <Button variant="ghost" size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive mb-3">{error}</p>}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      ) : resources.length === 0 ? (
        !showForm && (
          <p className="text-sm text-muted-foreground">
            No resources yet. Add slides, a recording, notes, or links for attendees.
          </p>
        )
      ) : (
        <ul className="space-y-2">
          {resources.map((resource, index) => {
            const meta = KIND_META[resource.kind] ?? KIND_META.link
            const Icon = meta.icon
            const isBusy = busyId === resource.id
            return (
              <li
                key={resource.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-2 pl-3 transition-opacity',
                  isBusy && 'opacity-60'
                )}
              >
                <div className="p-1.5 rounded-md bg-primary/10 text-primary shrink-0">
                  <Icon className="h-4 w-4" />
                </div>
                <a
                  href={resource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 min-w-0 group"
                  title={resource.url}
                >
                  <p className="text-sm font-medium truncate group-hover:underline">
                    {resource.title}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {meta.label} · {hostnameOf(resource.url)}
                  </p>
                </a>
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                {canManage && (
                  <div className="flex items-center shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Move up"
                      disabled={index === 0 || busyId !== null}
                      onClick={() => handleMove(index, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Move down"
                      disabled={index === resources.length - 1 || busyId !== null}
                      onClick={() => handleMove(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label="Remove resource"
                      disabled={busyId !== null}
                      onClick={() => handleRemove(resource)}
                    >
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {canManage && showForm && (
        <form onSubmit={handleAdd} className="mt-4 space-y-3 border-t pt-4">
          <div className="flex flex-wrap gap-1.5">
            {KIND_ORDER.map((k) => {
              const Icon = KIND_META[k].icon
              return (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={kind === k ? 'default' : 'outline'}
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                >
                  <Icon className="h-3.5 w-3.5 mr-1" />
                  {KIND_META[k].label}
                </Button>
              )
            })}
          </div>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, 200))}
            placeholder="Title (e.g. Slide deck)"
            maxLength={200}
            required
          />
          <div className="space-y-1">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              inputMode="url"
              required
              aria-invalid={!urlLooksValid}
              className={cn(!urlLooksValid && 'border-destructive focus-visible:ring-destructive')}
            />
            {!urlLooksValid && (
              <p className="text-xs text-destructive">Enter a full URL starting with http:// or https://</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add resource
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowForm(false)
                setTitle('')
                setUrl('')
                setKind('link')
                setError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}
