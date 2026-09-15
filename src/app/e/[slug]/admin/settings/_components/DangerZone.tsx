'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { canDelete } from '@/lib/events/lifecycle'
import type { Event, EventStatus } from '@/types/event'
import { SectionCard, Field } from './SectionCard'
import { deleteEvent, SettingsError } from './shared'

export function DangerZone({ event, status, published }: { event: Event; status: EventStatus; published: boolean }) {
  const router = useRouter()
  const [confirmation, setConfirmation] = React.useState('')
  const [deleting, setDeleting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const deletable = canDelete(status) && !published
  const matches = confirmation.trim() === event.slug

  const remove = async () => {
    if (!matches || deleting) return
    setDeleting(true); setError(null)
    try {
      await deleteEvent(event.id)
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof SettingsError || err instanceof Error ? err.message : 'Could not delete this event.')
      setDeleting(false)
    }
  }

  return <SectionCard id="danger" title="Danger zone" description="Only the owner sees this. Deleting removes the gathering, its sessions, members and tickets, and its network identity, for good." className="border-destructive/40">
    {deletable ? <>
      <Field label={`Type ${event.slug} to confirm`} htmlFor="delete-confirm" error={error}>
        <Input id="delete-confirm" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} placeholder={event.slug} />
      </Field>
      <Button type="button" variant="destructive" disabled={!matches || deleting} onClick={remove}>{deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}Delete this draft</Button>
    </> : <p className="text-sm text-muted-foreground">{published
      ? 'This gathering has published records on the network, so it cannot be deleted. Archive it from the Lifecycle section instead; its public records stay where they are.'
      : 'Only drafts can be deleted. This gathering has been published, so archive it from the Lifecycle section instead; archived gatherings leave discovery but keep their history.'}</p>}
  </SectionCard>
}
