'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { FilterChip } from '@/components/ui/filter-chip'
import { Label } from '@/components/ui/label'
import {
  Search,
  Filter,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { SESSION_STATUS, type SessionStatus } from '@/lib/labels'
import { plural } from '@/lib/format'

interface Track {
  id: string
  name: string
  color: string | null
}

export interface FilterState {
  search: string
  statuses: SessionStatus[]
  tracks: string[]
  formats: string[]
  /** Sessions the network flagged: proposer edited after scheduling, or withdrew. */
  flaggedOnly: boolean
  hasTimePreference: boolean | null
  hasCohosts: boolean | null
}

interface SessionFiltersProps {
  filters: FilterState
  onFiltersChange: (filters: FilterState) => void
  tracks?: Track[]
  formats?: string[]
  totalCount: number
  filteredCount: number
}

export const defaultFilters: FilterState = {
  search: '',
  statuses: [],
  tracks: [],
  formats: [],
  flaggedOnly: false,
  hasTimePreference: null,
  hasCohosts: null,
}

const STATUS_OPTIONS: SessionStatus[] = ['pending', 'approved', 'scheduled', 'rejected']

export function SessionFilters({
  filters,
  onFiltersChange,
  tracks = [],
  formats = [],
  totalCount,
  filteredCount,
}: SessionFiltersProps) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  const id = React.useId()
  const activeFilterCount = [
    filters.statuses.length > 0,
    filters.tracks.length > 0,
    filters.formats.length > 0,
    filters.flaggedOnly,
    filters.hasTimePreference !== null,
    filters.hasCohosts !== null,
  ].filter(Boolean).length

  const toggle = <K extends 'statuses' | 'tracks' | 'formats'>(key: K, value: FilterState[K][number]) => {
    const list = filters[key] as string[]
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
    onFiltersChange({ ...filters, [key]: next })
  }

  const hasActiveFilters = filters.search || activeFilterCount > 0

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search session proposals"
            placeholder="Search by title, host or tag…"
            value={filters.search}
            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
            className="pl-9 pr-10"
          />
          {filters.search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onFiltersChange({ ...filters, search: '' })}
              className="absolute right-0.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <Button
          type="button"
          variant={isExpanded || activeFilterCount > 0 ? 'secondary' : 'outline'}
          onClick={() => setIsExpanded(!isExpanded)}
          className="gap-2"
          aria-expanded={isExpanded}
          aria-controls={`${id}-panel`}
        >
          <Filter className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Filters</span>
          {activeFilterCount > 0 && (
            <Badge variant="default" className="ml-1 h-5 min-w-5 justify-center px-1.5 py-0">
              {activeFilterCount}
            </Badge>
          )}
          {isExpanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground" role="status">
            Showing {filteredCount} of {plural(totalCount, 'session')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onFiltersChange(defaultFilters)}>
            Clear filters
          </Button>
        </div>
      )}

      {isExpanded && (
        <div id={`${id}-panel`} className="bg-muted/50 border rounded-xl p-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Status</legend>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((status) => (
                <FilterChip key={status} pressed={filters.statuses.includes(status)} onClick={() => toggle('statuses', status)}>
                  {SESSION_STATUS[status].label}
                </FilterChip>
              ))}
            </div>
          </fieldset>

          {tracks.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Track</legend>
              <div className="flex flex-wrap gap-2">
                {tracks.map((track) => (
                  <FilterChip
                    key={track.id}
                    pressed={filters.tracks.includes(track.id)}
                    onClick={() => toggle('tracks', track.id)}
                    icon={<span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: track.color ?? undefined }} aria-hidden="true" />}
                  >
                    {track.name}
                  </FilterChip>
                ))}
              </div>
            </fieldset>
          )}

          {formats.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Format</legend>
              <div className="flex flex-wrap gap-2">
                {formats.map((format) => (
                  <FilterChip key={format} pressed={filters.formats.includes(format)} onClick={() => toggle('formats', format)} className="capitalize">
                    {format}
                  </FilterChip>
                ))}
              </div>
            </fieldset>
          )}

          <fieldset className="flex flex-wrap gap-x-6 gap-y-3">
            <legend className="sr-only">More filters</legend>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-pref`}
                checked={filters.hasTimePreference === true}
                onCheckedChange={(checked) => onFiltersChange({ ...filters, hasTimePreference: checked === true ? true : null })}
              />
              <Label htmlFor={`${id}-pref`} className="font-normal">Has a time preference</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-flagged`}
                checked={filters.flaggedOnly}
                onCheckedChange={(checked) => onFiltersChange({ ...filters, flaggedOnly: checked === true })}
              />
              <Label htmlFor={`${id}-flagged`} className="font-normal">Needs review after a network change</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-cohosts`}
                checked={filters.hasCohosts === true}
                onCheckedChange={(checked) => onFiltersChange({ ...filters, hasCohosts: checked === true ? true : null })}
              />
              <Label htmlFor={`${id}-cohosts`} className="font-normal">Has co-hosts</Label>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  )
}
