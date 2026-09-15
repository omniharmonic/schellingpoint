import 'server-only'
import { sql } from '@/lib/db'

export interface InvitePreview {
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  session_id: string
  event_slug: string
  event_name: string
  session: {
    id: string
    title: string
    description: string | null
    format: string | null
    duration: number | null
    /** The proposer as they present themselves; null for a host-less session. */
    host: { display_name: string | null; handle: string | null; avatar_url: string | null } | null
  }
}

const TOKEN = /^[0-9a-f]{64}$/

/** What an invite link shows before anyone accepts it. Names only the proposer. */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
  if (!TOKEN.test(token)) return null
  const rows = await sql<{
    status: InvitePreview['status']; expires_at: string; session_id: string; title: string; description: string | null
    format: string | null; duration: number | null; host_id: string | null; display_name: string | null
    handle: string | null; avatar_url: string | null; event_slug: string; event_name: string
  }[]>`
    select i.status, i.expires_at, s.id as session_id, s.title, s.description, s.format, s.duration, s.host_id,
           p.display_name, a.handle, p.avatar_url, e.slug as event_slug, e.name as event_name
    from cohost_invites i
    join sessions s on s.id = i.session_id and s.event_id = i.event_id
    join events e on e.id = i.event_id
    left join profiles p on p.id = s.host_id
    left join accounts a on a.id = s.host_id
    where i.token = ${token}
  `
  const row = rows[0]
  if (!row) return null
  const expired = row.status === 'pending' && new Date(row.expires_at).getTime() < Date.now()
  return {
    status: expired ? 'expired' : row.status,
    session_id: row.session_id,
    event_slug: row.event_slug,
    event_name: row.event_name,
    session: {
      id: row.session_id,
      title: row.title,
      description: row.description,
      format: row.format,
      duration: row.duration,
      host: row.host_id ? { display_name: row.display_name, handle: row.handle, avatar_url: row.avatar_url } : null,
    },
  }
}
