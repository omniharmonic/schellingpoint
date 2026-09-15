import 'server-only'
import { sql } from '@/lib/db'

/**
 * Resolves `?event=<slug>` for a person's own notification data. Returns null for a slug
 * that does not exist and for a draft/private event the account is not a member of, so the
 * answer never discloses whether a hidden event exists.
 */
export async function resolveEventScope(slug: string, accountId: string): Promise<{ id: string; slug: string } | null> {
  if (!slug || slug.length > 200) return null
  const rows = await sql<{ id: string; slug: string; hidden: boolean; member: boolean }[]>`
    select e.id, e.slug,
           (e.visibility = 'private' or e.status = 'draft') as hidden,
           exists (select 1 from event_members m where m.event_id = e.id and m.user_id = ${accountId}) as member
    from events e
    where e.slug = ${slug}
  `
  const event = rows[0]
  if (!event || (event.hidden && !event.member)) return null
  return { id: event.id, slug: event.slug }
}
