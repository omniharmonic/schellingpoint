import { isAtprotoConfigured } from '@/lib/atproto/config'
import LoginClient from './LoginClient'

// Read deployment configuration per request; no secrets are sent to the client.
export const dynamic = 'force-dynamic'

export default function LoginPage() {
  return <LoginClient atConfigured={isAtprotoConfigured()} />
}
