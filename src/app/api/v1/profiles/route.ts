import { createAdminClient } from '@/lib/supabase/server'
import { validateApiKey, resolvePartnerEvent } from '@/lib/api/auth'
import { apiSuccess, unauthorized, badRequest, methodNotAllowed } from '@/lib/api/response'

// Contact and permission fields (email, telegram, ens, is_admin) are never
// exposed to the partner API.
const PROFILE_FIELDS = 'id,display_name,bio,avatar_url,affiliation,building,interests,created_at'

export async function GET(request: Request) {
  if (!validateApiKey(request)) return unauthorized()

  const supabase = await createAdminClient()

  const resolved = await resolvePartnerEvent(request, supabase)
  if ('error' in resolved) return resolved.error

  // Only members of the requested event are visible to partners
  const { data, error } = await supabase
    .from('event_members')
    .select(`profile:profiles!user_id(${PROFILE_FIELDS})`)
    .eq('event_id', resolved.event.id)

  if (error) {
    return badRequest(error.message)
  }

  type ProfileRow = { display_name: string | null } & Record<string, unknown>
  const profiles = (data ?? [])
    .map((row) => row.profile as unknown as ProfileRow | null)
    .filter((profile): profile is ProfileRow => profile !== null)
    .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''))

  return apiSuccess(profiles, profiles.length)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
