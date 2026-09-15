import 'server-only'
import { sql as defaultSql, type Sql } from '@/lib/db'
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from './categories'

/**
 * Notification preferences, per category, globally or per event. Resolution matches
 * `public.should_send_notification`: the event row, else the global row, else defaults
 * (email on, in-app on, push off).
 */

export interface EffectivePreference {
  category: NotificationCategory
  email_enabled: boolean
  in_app_enabled: boolean
  push_enabled: boolean
  /** Where the values came from. */
  source: 'event' | 'global' | 'default'
}

export interface PreferenceUpdate {
  category: NotificationCategory
  email_enabled?: boolean
  in_app_enabled?: boolean
  push_enabled?: boolean
}

const DEFAULTS = { email_enabled: true, in_app_enabled: true, push_enabled: false }

interface PrefRow {
  event_id: string | null
  category: NotificationCategory
  email_enabled: boolean
  in_app_enabled: boolean
  push_enabled: boolean
}

export async function getPreferences(
  accountId: string,
  eventId: string | null,
  db: Sql = defaultSql,
): Promise<EffectivePreference[]> {
  const rows = await db<PrefRow[]>`
    select event_id, category, email_enabled, in_app_enabled, push_enabled
    from notification_preferences
    where user_id = ${accountId}
      and (event_id is null ${eventId ? db`or event_id = ${eventId}` : db``})
  `
  return NOTIFICATION_CATEGORIES.map((category) => {
    const eventRow = eventId ? rows.find((r) => r.category === category && r.event_id === eventId) : undefined
    const globalRow = rows.find((r) => r.category === category && r.event_id === null)
    const row = eventRow ?? globalRow
    return {
      category,
      email_enabled: row?.email_enabled ?? DEFAULTS.email_enabled,
      in_app_enabled: row?.in_app_enabled ?? DEFAULTS.in_app_enabled,
      push_enabled: row?.push_enabled ?? DEFAULTS.push_enabled,
      source: eventRow ? 'event' : globalRow ? 'global' : 'default',
    }
  })
}

/**
 * Applies updates at one scope (an event, or global when `eventId` is null). A category
 * without a row at that scope starts from its current effective values, so turning one
 * channel off for an event does not silently reset the others to defaults.
 */
export async function setPreferences(
  accountId: string,
  eventId: string | null,
  updates: readonly PreferenceUpdate[],
  db: Sql = defaultSql,
): Promise<EffectivePreference[]> {
  const current = await getPreferences(accountId, eventId, db)
  for (const update of updates) {
    const base = current.find((p) => p.category === update.category)
    if (!base) continue
    const next = {
      email_enabled: update.email_enabled ?? base.email_enabled,
      in_app_enabled: update.in_app_enabled ?? base.in_app_enabled,
      push_enabled: update.push_enabled ?? base.push_enabled,
    }
    if (eventId) {
      await db`
        insert into notification_preferences (user_id, event_id, category, email_enabled, in_app_enabled, push_enabled)
        values (${accountId}, ${eventId}, ${update.category}, ${next.email_enabled}, ${next.in_app_enabled}, ${next.push_enabled})
        on conflict (user_id, event_id, category) do update
          set email_enabled = excluded.email_enabled,
              in_app_enabled = excluded.in_app_enabled,
              push_enabled = excluded.push_enabled
      `
    } else {
      await db`
        insert into notification_preferences (user_id, event_id, category, email_enabled, in_app_enabled, push_enabled)
        values (${accountId}, null, ${update.category}, ${next.email_enabled}, ${next.in_app_enabled}, ${next.push_enabled})
        on conflict (user_id, category) where event_id is null do update
          set email_enabled = excluded.email_enabled,
              in_app_enabled = excluded.in_app_enabled,
              push_enabled = excluded.push_enabled
      `
    }
  }
  return getPreferences(accountId, eventId, db)
}
