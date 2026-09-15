import type { Metadata } from 'next'
import { previewInvite } from '@/app/api/v1/sessions/_lib/invite'
import { InviteClient } from './InviteClient'

interface InvitePageProps {
  params: Promise<{ token: string }>
}

export async function generateMetadata({ params }: InvitePageProps): Promise<Metadata> {
  const { token } = await params
  const invite = await previewInvite(token)
  if (!invite) return { title: 'Invite Not Found' }
  return {
    title: `Co-host invite: ${invite.session.title}`,
    description: `You've been invited to co-host "${invite.session.title}" at ${invite.event_name}`,
    robots: { index: false, follow: false },
  }
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params
  const invite = await previewInvite(token)
  return <InviteClient token={token} invite={invite} />
}
