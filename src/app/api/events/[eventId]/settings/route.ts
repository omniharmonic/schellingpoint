import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { createAdminClient } from '@/lib/supabase/server'
import { canRolePerform } from '@/lib/permissions'
import { isValidTransition } from '@/lib/events/lifecycle'
import type { EventStatus } from '@/types/event'

export async function PATCH(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({error:'Sign in to manage this event.'},{status:401})
  const db = await createAdminClient()
  const {data:member,error:memberError} = await db.from('event_members').select('role').eq('event_id',eventId).eq('user_id',user.id).maybeSingle()
  if (memberError) return NextResponse.json({error:'Could not verify your event access. Try again.'},{status:500})
  if (!member || !canRolePerform(member.role,'editEventSettings')) return NextResponse.json({error:'Only this event’s organizers can change its settings.'},{status:403})
  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim() || !['public','unlisted','private'].includes(body.visibility) || typeof body.tagline !== 'string' || typeof body.description !== 'string') return NextResponse.json({error:'Enter an event name and valid visibility.'},{status:400})
  const {data:event,error} = await db.from('events').select('status').eq('id',eventId).single()
  if (error || !event) return NextResponse.json({error:'Could not load this event.'},{status:404})
  if (body.status !== event.status && !isValidTransition(event.status as EventStatus,body.status)) return NextResponse.json({error:'That phase change is no longer available. Refresh the page and try again.'},{status:409})
  const {data:saved,error:saveError} = await db.from('events').update({
    name:body.name.trim(),tagline:body.tagline.trim() || null,description:body.description.trim() || null,
    visibility:body.visibility,status:body.status,updated_at:new Date().toISOString(),
  }).eq('id',eventId).eq('status',event.status).select('id,status').maybeSingle()
  if (saveError) return NextResponse.json({error:'Could not save event settings. Your changes are still in the form.'},{status:500})
  if (!saved) return NextResponse.json({error:'Another organizer changed the event phase. Refresh before saving.'},{status:409})
  return NextResponse.json({success:true,event:saved})
}
