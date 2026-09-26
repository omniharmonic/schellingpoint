import 'server-only'
/**
 * `venues.outline` is jsonb, so it has to reach postgres.js as `sql.json(...)` rather than as a
 * plain object (CLAUDE.md: never `JSON.stringify(...)::jsonb`). Both venue routes build their
 * insert/update row through here so the conversion happens in exactly one place.
 */
import type { Sql } from '@/lib/db'
import type { VenueInput } from '@/lib/scheduling/inputs'

export function venueRow(tx: Sql, input: VenueInput): Record<string, unknown> {
  return { ...input, outline: input.outline === null ? null : tx.json(input.outline as never) }
}
