import { json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { previewInvite } from '@/app/api/v1/sessions/_lib/invite'

/** GET /api/invite/[token] — what a co-host invite link is for (no sign-in needed to look). */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invite = await previewInvite(token)
  if (!invite) return jsonError(404, 'Invite not found')
  return json(invite)
}
