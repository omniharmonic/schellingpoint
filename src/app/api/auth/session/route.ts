import { createClient, createRequestClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export async function GET() {
  const supabase = await createClient()

  const { data: { session }, error } = await supabase.auth.getSession()

  if (error || !session) {
    return NextResponse.json({ session: null })
  }

  return NextResponse.json({
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: session.user,
    }
  })
}

// Mirror a verified access token for server-rendered event authorization.
export async function POST(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user }, error } = await createRequestClient(request).auth.getUser(token)
  if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const response = NextResponse.json({ success: true })
  response.cookies.set('sp-access-token', token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', maxAge: 3600,
  })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export async function DELETE(request: Request) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const response = NextResponse.json({ success: true })
  response.cookies.set('sp-access-token', '', { httpOnly: true, path: '/', maxAge: 0 })
  // Also clear legacy SSR cookies so signing out cannot restore an old session.
  const prefix = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`
  for (const cookie of (await cookies()).getAll()) {
    if (cookie.name === prefix || cookie.name.startsWith(`${prefix}.`)) {
      response.cookies.set(cookie.name, '', { path: '/', maxAge: 0 })
    }
  }
  return response
}
