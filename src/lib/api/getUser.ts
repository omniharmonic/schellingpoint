import 'server-only'
import { getViewer } from '@/lib/auth/viewer'

export interface RequestUser {
  /** `accounts.id` (also `profiles.id`). */
  id: string
  email: string | null
}

/**
 * Compatibility shim over `getViewer` (plan §3.2): the signed-in account from the
 * `sp_at_session` cookie, or null. Routes not yet converted keep compiling; new code
 * should use `requireViewer` / `requireEventRole` from `@/lib/auth/viewer` directly.
 */
export async function getUserFromRequest(request: Request): Promise<RequestUser | null> {
  const viewer = await getViewer(request)
  return viewer ? { id: viewer.accountId, email: viewer.email } : null
}
