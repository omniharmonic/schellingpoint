'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowUpRight, Loader2, Check, ArrowRight } from 'lucide-react'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { STATUS_INFO, getNextValidStatuses } from '@/lib/events/lifecycle'
import type { EventStatus, EventVisibility } from '@/types/event'

export default function EventSettingsPage() {
  const event = useEvent()
  const {can,isLoading} = useEventRole()
  const {user,isLoading:authLoading} = useAuth()
  const router = useRouter()
  const [name,setName] = React.useState(event.name)
  const [tagline,setTagline] = React.useState(event.tagline || '')
  const [description,setDescription] = React.useState(event.description || '')
  const [visibility,setVisibility] = React.useState<EventVisibility>(event.visibility)
  const [status,setStatus] = React.useState<EventStatus>(event.status)
  const [saving,setSaving] = React.useState(false)
  const [message,setMessage] = React.useState<string | null>(null)
  const [error,setError] = React.useState<string | null>(null)
  const permitted = can('editEventSettings')
  const transitions = getNextValidStatuses(event.status)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaving(true); setError(null); setMessage(null)
    try {
      const key = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`
      const token = JSON.parse(localStorage.getItem(key) || '{}').access_token
      if (!token) throw new Error('Sign in again to save your changes.')
      const response = await fetch(`/api/events/${event.id}/settings`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({name,tagline,description,visibility,status})})
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save event settings.')
      setMessage('Event settings saved.'); router.refresh()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save event settings.') }
    finally { setSaving(false) }
  }
  if (isLoading || authLoading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin"/></div>
  if (!user || !permitted) return <Card><CardContent className="p-8"><h1 className="text-2xl font-semibold mb-3">Organizer access required</h1><p className="text-muted-foreground mb-5">Only this event’s owner and admins can change these settings.</p><Button asChild variant="outline"><Link href={`/e/${event.slug}`}>Return to the gathering</Link></Button></CardContent></Card>
  return <div className="max-w-4xl space-y-8">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm text-muted-foreground mb-2">Your gathering, your rhythm</p><h1 className="text-4xl font-semibold">Event settings</h1><p className="text-muted-foreground mt-3 max-w-xl">Set the invitation. Open each phase when your community is ready.</p></div><Button variant="outline" asChild><Link href={`/e/${event.slug}`}>View event <ArrowUpRight className="h-4 w-4 ml-2"/></Link></Button></div>
    <form onSubmit={save} className="space-y-6">
      <Card className="overflow-hidden"><CardHeader className="bg-secondary border-b"><p className="text-xs font-medium text-muted-foreground">Current phase</p><CardTitle className="text-3xl">{STATUS_INFO[event.status].label}</CardTitle><p className="text-sm text-muted-foreground">{STATUS_INFO[event.status].description}</p></CardHeader><CardContent className="p-6 space-y-4">
        <label htmlFor="event-phase" className="block text-sm font-medium">Event phase</label><select id="event-phase" value={status} onChange={e=>setStatus(e.target.value as EventStatus)} className="w-full rounded-lg border bg-background p-3"><option value={event.status}>Keep {STATUS_INFO[event.status].label.toLowerCase()}</option>{transitions.map(next=><option key={next} value={next}>{STATUS_INFO[next].label}</option>)}</select>
        {status !== event.status && <div className="flex gap-3 rounded-xl bg-primary/5 border border-primary/20 p-4"><ArrowRight className="h-5 w-5 text-primary shrink-0 mt-0.5"/><div><p className="font-medium">{STATUS_INFO[status].label}</p><p className="text-sm text-muted-foreground mt-1">{STATUS_INFO[status].description}. This takes effect when you save.</p></div></div>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>The invitation</CardTitle></CardHeader><CardContent className="space-y-5"><div className="space-y-2"><label htmlFor="event-name" className="text-sm font-medium">Event name</label><Input id="event-name" value={name} onChange={e=>setName(e.target.value)} required maxLength={160}/></div><div className="space-y-2"><label htmlFor="event-tagline" className="text-sm font-medium">Tagline</label><Input id="event-tagline" value={tagline} onChange={e=>setTagline(e.target.value)} maxLength={240}/></div><div className="space-y-2"><label htmlFor="event-description" className="text-sm font-medium">About the gathering</label><textarea id="event-description" value={description} onChange={e=>setDescription(e.target.value)} rows={5} className="w-full rounded-lg border bg-background p-3 text-sm"/></div><div className="space-y-2"><label htmlFor="event-visibility" className="text-sm font-medium">Who can discover this event?</label><select id="event-visibility" value={visibility} onChange={e=>setVisibility(e.target.value as EventVisibility)} className="w-full rounded-lg border bg-background p-3"><option value="public">Public — listed in discovery</option><option value="unlisted">Unlisted — share the direct link</option><option value="private">Private — invited members</option></select><p className="text-xs text-muted-foreground">Drafts stay out of discovery until published.</p></div></CardContent></Card>
      <div className="sticky bottom-3 rounded-xl border bg-card p-4 shadow-lg flex flex-wrap items-center justify-between gap-4"><div className="text-sm" aria-live="polite">{error ? <p role="alert" className="text-destructive">{error}</p> : message ? <p className="text-primary flex items-center gap-2"><Check className="h-4 w-4"/>{message}</p> : <p className="text-muted-foreground">Changes take effect when you save.</p>}</div><Button type="submit" disabled={saving || !name.trim()}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-2"/>}{saving ? 'Saving…' : 'Save settings'}</Button></div>
    </form>
  </div>
}
