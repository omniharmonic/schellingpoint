'use client'

/**
 * Address search over a map (design §1.3). Lifted out of `LocationPicker` so the organizer's venue
 * editor and a proposer's location picker share one lookup, one error voice and one budget.
 *
 * Everything goes through `POST …/admin/geocode`: the same authorization (organizers, hosts of a
 * self-hosted session, and members while proposals are open) and the same 30 lookups an hour an
 * account. `limit` asks for up to five candidates to choose between; those answers live in their
 * own cache namespace, so they never overwrite the single result the rest of the app reads.
 *
 * Nothing is persisted: picking a candidate just flies the map there.
 */
import * as React from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch, ApiError } from '@/lib/api/client'
import type { StructuredAddress } from '@/lib/geo/coarse'

export interface AddressMatch {
  lat: number
  lng: number
  label: string
}

/** What the geocode route accepts: free text, or a room's address in parts. */
export type LookupInput = { query: string } | { address: Record<string, string | null | undefined> }

export interface AddressLookup {
  search: (input: LookupInput, limit?: number) => Promise<AddressMatch[]>
  looking: boolean
  error: string | null
  setError: (message: string | null) => void
}

/** The geocode call itself, with its loading and error state. */
export function useAddressLookup(eventSlug: string): AddressLookup {
  const [looking, setLooking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const search = React.useCallback(
    async (input: LookupInput, limit = 1): Promise<AddressMatch[]> => {
      setLooking(true)
      setError(null)
      try {
        const res = await apiFetch<{ result: AddressMatch | null; results?: AddressMatch[] }>(
          `/api/v1/events/${encodeURIComponent(eventSlug)}/admin/geocode`,
          { method: 'POST', json: limit > 1 ? { ...input, limit } : input },
        )
        const matches = res.results ?? (res.result ? [res.result] : [])
        if (!matches.length) setError('No match for that address. Place the pin by hand instead.')
        return matches
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'The address lookup failed. Place the pin by hand instead.')
        return []
      } finally {
        setLooking(false)
      }
    },
    [eventSlug],
  )

  return { search, looking, error, setError }
}

/** A room's address in the parts the route wants. */
export function addressParts(address: StructuredAddress): LookupInput {
  return {
    address: {
      street: address.street ?? null,
      locality: address.locality ?? null,
      region: address.region ?? null,
      postal_code: address.postalCode ?? null,
      country: address.country ?? null,
    },
  }
}

export interface AddressSearchProps {
  eventSlug: string
  /** Fly the map to the chosen candidate. */
  onPick: (match: AddressMatch) => void
  label?: string
  placeholder?: string
  idPrefix?: string
  disabled?: boolean
  /** How many candidates to offer (1–5). */
  limit?: number
  className?: string
}

export function AddressSearch({
  eventSlug,
  onPick,
  label = 'Search for a place',
  placeholder = 'An address, a building, a park…',
  idPrefix = 'address-search',
  disabled,
  limit = 5,
  className,
}: AddressSearchProps) {
  const lookup = useAddressLookup(eventSlug)
  const [query, setQuery] = React.useState('')
  const [matches, setMatches] = React.useState<AddressMatch[]>([])

  const run = async () => {
    const text = query.trim()
    if (text.length < 3) {
      lookup.setError('Type at least three characters.')
      setMatches([])
      return
    }
    setMatches(await lookup.search({ query: text }, limit))
  }

  const pick = (match: AddressMatch) => {
    setMatches([])
    lookup.setError(null)
    onPick(match)
  }

  return (
    <div className={className} data-testid="address-search">
      <Label htmlFor={`${idPrefix}-input`} className="sr-only">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={`${idPrefix}-input`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
          placeholder={placeholder}
          maxLength={200}
          disabled={disabled}
          autoComplete="off"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => void run()} loading={lookup.looking} disabled={disabled}>
          <Search className="mr-1.5 h-4 w-4" aria-hidden />
          Search
        </Button>
        {(matches.length > 0 || lookup.error) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setMatches([])
              lookup.setError(null)
            }}
            aria-label="Clear the search"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
      {lookup.error && (
        <p className="mt-1 text-sm text-destructive" role="alert">
          {lookup.error}
        </p>
      )}
      {matches.length > 0 && (
        <ul className="mt-1 divide-y rounded-md border" aria-label="Search results">
          {matches.map((match) => (
            <li key={`${match.lat},${match.lng},${match.label}`}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted/60"
                onClick={() => pick(match)}
              >
                {match.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
