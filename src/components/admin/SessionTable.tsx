'use client'

import * as React from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  ThumbsUp,
  AlertTriangle,
  Globe,
  Clock,
  MapPin,
  ExternalLink,
  MailCheck,
  Mail,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { sessionStatusBadge } from '@/lib/labels'
import { hostLabel, type AdminSession, type SessionResult } from './types'

type Session = AdminSession

export type SortField = 'votes' | 'title' | 'duration' | 'created_at'
export type SortDirection = 'asc' | 'desc'

interface SessionTableProps {
  sessions: Session[]
  /** Voting results, only after the round closes (organizer-only). Hidden entirely while voting is open. */
  results?: Record<string, SessionResult> | null
  eventSlug: string
  selectedIds: Set<string>
  onSelectionChange: (ids: Set<string>) => void
  onRowClick?: (session: Session) => void
  sortField: SortField
  sortDirection: SortDirection
  onSortChange: (field: SortField) => void
}

/** "monday_am" → "Monday AM". */
const formatPref = (pref: string) => pref.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ (Am|Pm)$/, (m) => m.toUpperCase())

export function SessionTable({
  sessions,
  results = null,
  eventSlug,
  selectedIds,
  onSelectionChange,
  onRowClick,
  sortField,
  sortDirection,
  onSortChange,
}: SessionTableProps) {
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  const allSelected = sessions.length > 0 && sessions.every((s) => selectedIds.has(s.id))
  const someSelected = sessions.some((s) => selectedIds.has(s.id)) && !allSelected

  const handleSelectAll = () => {
    if (allSelected) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(sessions.map((s) => s.id)))
    }
  }

  const handleSelectOne = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const newSelection = new Set(selectedIds)

    // Shift-click for range selection
    if (e.shiftKey && selectedIds.size > 0) {
      const lastSelected = Array.from(selectedIds).pop()
      const lastIndex = sessions.findIndex((s) => s.id === lastSelected)
      const currentIndex = sessions.findIndex((s) => s.id === id)
      const [start, end] = lastIndex < currentIndex
        ? [lastIndex, currentIndex]
        : [currentIndex, lastIndex]

      for (let i = start; i <= end; i++) {
        newSelection.add(sessions[i].id)
      }
    } else {
      if (newSelection.has(id)) {
        newSelection.delete(id)
      } else {
        newSelection.add(id)
      }
    }

    onSelectionChange(newSelection)
  }

  const sortHeader = (field: SortField, label: string) => (
    <button
      type="button"
      onClick={() => onSortChange(field)}
      aria-sort={sortField === field ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
      className="flex min-h-8 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      {sortField === field ? (
        sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden="true" />
      )}
    </button>
  )

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No sessions match.
      </div>
    )
  }

  return (
    <div className="border rounded-xl overflow-hidden">
      {/* Header */}
      <div className={cn('bg-muted/50 border-b px-4 py-2 hidden sm:grid gap-4 items-center', results ? 'sm:grid-cols-[auto_1fr_auto_auto_auto]' : 'sm:grid-cols-[auto_1fr_auto_auto]')}>
        <Checkbox
          checked={allSelected || (someSelected ? 'indeterminate' : false)}
          onCheckedChange={handleSelectAll}
          aria-label="Select all"
        />
        {sortHeader('title', 'Session')}
        {results && sortHeader('votes', 'Votes')}
        {sortHeader('duration', 'Length')}
        <span className="text-xs font-medium text-muted-foreground">Status</span>
      </div>

      {/* Body */}
      <div className="divide-y">
        {sessions.map((session) => {
          const isSelected = selectedIds.has(session.id)
          const isExpanded = expandedId === session.id
          const isScheduled = session.status === 'scheduled'
          const isRejected = session.status === 'rejected'
          const status = sessionStatusBadge(session.status)

          return (
            <div
              key={session.id}
              className={cn(
                'px-4 py-3 transition-colors',
                isSelected && 'bg-primary/5',
                isRejected && 'opacity-60',
                isScheduled && 'bg-success/5',
                onRowClick && 'cursor-pointer hover:bg-muted/50'
              )}
              onClick={() => onRowClick?.(session)}
            >
              <div className={cn('grid grid-cols-[auto_1fr_auto] gap-4 items-center', results ? 'sm:grid-cols-[auto_1fr_auto_auto_auto]' : 'sm:grid-cols-[auto_1fr_auto_auto]')}>
                <div onClick={(e) => handleSelectOne(session.id, e)}>
                  <Checkbox
                    checked={isSelected}
                    aria-label={`Select ${session.title}`}
                  />
                </div>

                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {session.format && (
                      <Badge variant="secondary" className="capitalize">
                        {session.format}
                      </Badge>
                    )}
                    {session.track && (
                      <Badge
                        variant="outline"
                        style={{
                          borderColor: session.track.color ?? undefined,
                          color: session.track.color ?? undefined,
                          backgroundColor: session.track.color ? `${session.track.color}10` : undefined,
                        }}
                      >
                        {session.track.name}
                      </Badge>
                    )}
                  </div>
                  <h4 className="font-medium line-clamp-1">{session.title}</h4>
                  {hostLabel(session) && (
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {session.host_id ? `by ${hostLabel(session)}` : hostLabel(session)}
                    </p>
                  )}
                  {(session.proposal_withdrawn_at || session.proposal_drift_at || session.network_published) && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {session.network_published && (
                        <Badge variant="outline" className="gap-1"><Globe className="h-3 w-3" aria-hidden="true" />Published</Badge>
                      )}
                      {session.proposal_withdrawn_at ? (
                        <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" aria-hidden="true" />Withdrawn by proposer</Badge>
                      ) : session.proposal_drift_at ? (
                        <Badge variant="amber" className="gap-1"><AlertTriangle className="h-3 w-3" aria-hidden="true" />Edited after scheduling</Badge>
                      ) : null}
                    </div>
                  )}
                </div>

                {results && (
                  <div className="hidden sm:flex items-center gap-1 text-sm" title="Votes in the closed round">
                    <ThumbsUp className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    <span className="font-medium tabular-nums">{results[session.id]?.votes ?? 0}</span>
                  </div>
                )}

                <div className="hidden sm:block text-sm text-muted-foreground tabular-nums">
                  {session.duration ? `${session.duration} min` : '—'}
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant={status.badge}>{status.label}</Badge>

                  {results && (
                    <span className="sm:hidden text-xs text-muted-foreground flex items-center gap-1">
                      <ThumbsUp className="h-3 w-3" aria-hidden="true" />
                      {results[session.id]?.votes ?? 0}
                    </span>
                  )}

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedId(isExpanded ? null : session.id)
                    }}
                    aria-label={isExpanded ? `Collapse ${session.title}` : `Expand ${session.title}`}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                </div>
              </div>

              {isScheduled && (session.venue || session.time_slot) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-success">
                  {session.venue && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      {session.venue.name}
                    </span>
                  )}
                  {session.time_slot && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      {session.time_slot.label || new Date(session.time_slot.start_time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                  {session.host_id && (session.host_notified_at ? (
                    <Badge variant="success" className="gap-1">
                      <MailCheck className="h-3 w-3" aria-hidden="true" />
                      Host emailed
                    </Badge>
                  ) : (
                    <Badge variant="amber" className="gap-1">
                      <Mail className="h-3 w-3" aria-hidden="true" />
                      Host not emailed
                    </Badge>
                  ))}
                </div>
              )}

              {isExpanded && (
                <div className="mt-3 pt-3 border-t space-y-3">
                  {session.description && (
                    <p className="text-sm text-muted-foreground">
                      {session.description}
                    </p>
                  )}

                  {session.rejection_reason && session.status === 'rejected' && (
                    <p className="text-sm text-muted-foreground">Reason given: {session.rejection_reason}</p>
                  )}

                  {session.listed_host_name && !session.host_id && (
                    <p className="text-xs text-muted-foreground">
                      Listed as {session.listed_host_name} (unclaimed). This name is visible to organizers only and is never published.
                    </p>
                  )}

                  {session.proposal_withdrawn_at && (
                    <p role="status" className="text-sm text-destructive">
                      The proposer withdrew this proposal. Cancel the session or fill its slot; their record cannot be restored.
                    </p>
                  )}
                  {!session.proposal_withdrawn_at && session.proposal_drift_at && (
                    <p role="status" className="text-sm text-signal-amber">
                      The proposer edited this session after it was scheduled. Review the change and re-publish the schedule.
                    </p>
                  )}

                  {session.topic_tags && session.topic_tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {session.topic_tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {session.time_preferences && session.time_preferences.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Prefers:</span>
                      {session.time_preferences.map((pref) => (
                        <Badge key={pref} variant="muted">
                          {formatPref(pref)}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <Link
                    href={`/e/${eventSlug}/sessions/${session.id}`}
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    View full session
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
