import { createAdminClient } from '@/lib/supabase/server'
import { validateApiKey, partnerEventForRow } from '@/lib/api/auth'
import {
  apiSuccess,
  unauthorized,
  badRequest,
  notFound,
  methodNotAllowed,
  isValidUUID,
} from '@/lib/api/response'

const SESSION_DETAIL_SELECT = [
  'id,title,description,format,duration,host_name,topic_tags,status,is_self_hosted,custom_location,self_hosted_start_time,self_hosted_end_time,session_type,is_votable,total_votes,total_credits,voter_count,host_id,venue_id,time_slot_id,track_id,telegram_group_url,created_at,updated_at',
  'host:profiles!host_id(id,display_name,bio,affiliation,building,interests)',
  'cohosts:session_cohosts(user_id,display_order,profile:profiles(id,display_name,bio,affiliation,building,interests))',
  'track:tracks(id,name,slug,description,color)',
  'venue:venues(id,name,slug,capacity,features,style,address,notes,is_primary)',
  'time_slot:time_slots(id,start_time,end_time,label,is_break,day_date,slot_type)',
].join(',')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!validateApiKey(request)) return unauthorized()

  const { id } = await params
  if (!isValidUUID(id)) {
    return badRequest('Invalid session ID format. Expected a UUID.')
  }

  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('sessions')
    .select(`event_id,${SESSION_DETAIL_SELECT}`)
    .eq('id', id)
    .single()

  if (error || !data) {
    return notFound('Session')
  }

  // Hide rows whose event is private/draft (or does not match ?event=)
  // (cast: supabase-js cannot infer types for this composite select string)
  const { event_id, ...session } = data as unknown as { event_id: string | null } & Record<string, unknown>
  const event = await partnerEventForRow(request, supabase, event_id)
  if (!event) return notFound('Session')

  return apiSuccess(session)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
