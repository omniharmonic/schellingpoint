import { redirect } from 'next/navigation'

interface CheckinRedirectProps {
  params: Promise<{ slug: string }>
}

// Legacy route: check-in now lives inside the organizer workspace.
export default async function CheckinRedirectPage({ params }: CheckinRedirectProps) {
  const { slug } = await params
  redirect(`/e/${slug}/admin/checkin`)
}
