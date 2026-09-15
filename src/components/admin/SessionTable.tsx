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

  const SortHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <button
      onClick={() => onSortChange(field)}
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
    >
      {children}
      {sortField === field ? (
        sortDirection === 'asc' ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-50" />
      )}
    </button>
  )

  const formatPref = (pref: string) =>
    pref.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No sessions found
      </div>
    )
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Table Header */}
      <div className={cn('bg-muted/50 border-b px-4 py-3 hidden sm:grid gap-4 items-center', results ? 'sm:grid-cols-[auto_1fr_auto_auto_auto]' : 'sm:grid-cols-[auto_1fr_auto_auto]')}>
        <Checkbox
          checked={allSelected || (someSelected ? 'indeterminate' : false)}
          onCheckedChange={handleSelectAll}
          aria-label="Select all"
        />
        <SortHeader field="title">Session</SortHeader>
        {results && <SortHeader field="votes">Votes</SortHeader>}
        <SortHeader field="duration">Duration</SortHeader>
        <span className="text-xs font-medium text-muted-foreground">Status</span>
      </div>

      {/* Table Body */}
      <div className="divide-y">
        {sessions.map((session) => {
          const isSelected = selectedIds.has(session.id)
          const isExpanded = expandedId === session.id
          const isScheduled = session.status === 'scheduled'
          const isRejected = session.status === 'rejected'

          return (
            <div
              key={session.id}
              className={cn(
                'px-4 py-3 transition-colors',
                isSelected && 'bg-primary/5',
                isRejected && 'opacity-60',
                isScheduled && 'bg-green-500/5',
                onRowClick && 'cursor-pointer hover:bg-muted/50'
              )}
              onClick={() => onRowClick?.(session)}
            >
              {/* Main Row */}
              <div className={cn('grid grid-cols-[auto_1fr_auto] gap-4 items-center', results ? 'sm:grid-cols-[auto_1fr_auto_auto_auto]' : 'sm:grid-cols-[auto_1fr_auto_auto]')}>
                {/* Checkbox */}
                <div onClick={(e) => handleSelectOne(session.id, e)}>
                  <Checkbox
                    checked={isSelected}
                    aria-label={`Select ${session.title}`}
                  />
                </div>

                {/* Session Info */}
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="capitalize text-xs">
                      {session.format}
                    </Badge>
                    {session.track && (
                      <Badge
                        variant="outline"
                        className="text-xs"
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
                        <Badge variant="outline" className="text-xs gap-1"><Globe className="h-3 w-3" />Published</Badge>
                      )}
                      {session.proposal_withdrawn_at ? (
                        <Badge variant="outline" className="text-xs gap-1 border-destructive/40 text-destructive"><AlertTriangle className="h-3 w-3" />Withdrawn by proposer</Badge>
                      ) : session.proposal_drift_at ? (
                        <Badge variant="outline" className="text-xs gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3 w-3" />Edited after scheduling</Badge>
                      ) : null}
                    </div>
                  )}
                </div>

                {results && (
                  <div className="hidden sm:flex items-center gap-1 text-sm" title="Votes in the closed round">
                    <ThumbsUp className="h-3.5 w-3.5 text-primary" />
                    <span className="font-medium">{results[session.id]?.votes ?? 0}</span>
                  </div>
                )}

                {/* Duration - hidden on mobile */}
                <div className="hidden sm:block text-sm text-muted-foreground">
                  {session.duration ? `${session.duration}m` : '—'}
                </div>

                {/* Status & Expand */}
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      isScheduled ? 'default' :
                      session.status === 'approved' ? 'secondary' :
                      session.status === 'rejected' ? 'destructive' :
                      'outline'
                    }
                    className="capitalize text-xs"
                  >
                    {session.status}
                  </Badge>

                  {results && (
                    <span className="sm:hidden text-xs text-muted-foreground flex items-center gap-1">
                      <ThumbsUp className="h-3 w-3" />
                      {results[session.id]?.votes ?? 0}
                    </span>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedId(isExpanded ? null : session.id)
                    }}
                    className="h-8 w-8 p-0"
                    aria-label={isExpanded ? `Collapse ${session.title}` : `Expand ${session.title}`}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Scheduled Info */}
              {isScheduled && (session.venue || session.time_slot) && (
                <div className="mt-2 flex items-center gap-4 text-sm text-green-700 dark:text-green-400">
                  {session.venue && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {session.venue.name}
                    </span>
                  )}
                  {session.time_slot && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {session.time_slot.label || new Date(session.time_slot.start_time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                  {session.host_notified_at ? (
                    <Badge variant="outline" className="text-xs border-green-500/50 text-green-700 dark:text-green-400 bg-green-500/10">
                      <MailCheck className="h-3 w-3 mr-1" />
                      Notified
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-700 dark:text-amber-400 bg-amber-500/10">
                      <Mail className="h-3 w-3 mr-1" />
                      Pending
                    </Badge>
                  )}
                </div>
              )}

              {/* Expanded Content */}
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
                    <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                      The proposer edited this session after it was scheduled. Review the change and re-publish the schedule.
                    </p>
                  )}

                  {session.topic_tags && session.topic_tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {session.topic_tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {session.time_preferences && session.time_preferences.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Prefers:</span>
                      {session.time_preferences.map((pref) => (
                        <Badge
                          key={pref}
                          variant="outline"
                          className="text-xs border-blue-500/50 text-blue-700 dark:text-blue-400 bg-blue-500/10"
                        >
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
                    <ExternalLink className="h-3 w-3" />
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
