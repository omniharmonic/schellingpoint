import { redirect } from 'next/navigation'

interface AdminProposalsPageProps {
  params: Promise<{ slug: string }>
}

// Legacy route: older notifications linked to /e/[slug]/admin/proposals.
// Proposal review now lives on the event admin dashboard.
export default async function AdminProposalsPage({ params }: AdminProposalsPageProps) {
  const { slug } = await params
  redirect(`/e/${slug}/admin`)
}
