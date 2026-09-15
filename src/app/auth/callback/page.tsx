import { redirect } from 'next/navigation'

/**
 * Obsolete: the implicit-flow magic-link landing. Magic links now go to `/auth/verify`
 * (a route handler that sets the session cookie), so anything still arriving here is sent home.
 */
export default function AuthCallbackPage() {
  redirect('/')
}
