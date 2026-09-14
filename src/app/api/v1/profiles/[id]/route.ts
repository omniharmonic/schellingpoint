import { createAdminClient } from '@/lib/supabase/server'
import { validateApiKey, resolvePartnerEvent, partnerVisibleEventIds } from '@/lib/api/auth'
import {
  apiSuccess,
  unauthorized,
  badRequest,
  notFound,
  methodNotAllowed,
  isValidUUID,
  parseIncludes,
} from '@/lib/api/response'

// Contact and permission fields (email, telegram, ens, is_admin) are never
// exposed to the partner API.
const PROFILE_FIELDS = 'id,display_name,bio,affiliation,building,interests,created_at'
const VALID_INCLUDES = ['sessions']

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!validateApiKey(request)) return unauthorized()

  const { id } = await params
  if (!isValidUUID(id)) {
    return badRequest('Invalid profile ID format. Expected a UUID.')
  }

  const result = parseIncludes(request, VALID_INCLUDES)
  if ('error' in result) return result.error

  const supabase = await createAdminClient()

  // Optional ?event=<slug> scopes the profile to a single partner-visible event
  const hasEventParam = new URL(request.url).searchParams.has('event')
  let eventIds: string[]
  if (hasEventParam) {
    const resolved = await resolvePartnerEvent(request, supabase)
    if ('error' in resolved) return resolved.error
    eventIds = [resolved.event.id]

    // When scoped to an event, the profile must be a member of it
    const { data: membership } = await supabase
      .from('event_members')
      .select('id')
      .eq('event_id', resolved.event.id)
      .eq('user_id', id)
      .maybeSingle()
    if (!membership) return notFound('Profile')
  } else {
    eventIds = await partnerVisibleEventIds(supabase)
  }

  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_FIELDS)
    .eq('id', id)
    .single()

  if (error || !data) {
    return notFound('Profile')
  }

  if (result.includes.includes('sessions')) {
    const { data: sessions } = eventIds.length
      ? await supabase
          .from('sessions')
          .select('id,title,description,format,duration,status,session_type,topic_tags,total_votes,created_at')
          .eq('host_id', id)
          .in('event_id', eventIds)
          .in('status', ['approved', 'scheduled'])
          .order('total_votes', { ascending: false })
      : { data: [] }

    return apiSuccess({ ...data, sessions: sessions ?? [] })
  }

  return apiSuccess(data)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
