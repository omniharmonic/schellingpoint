import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

type CookieToSet = { name: string; value: string; options: CookieOptions }

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component - ignore
          }
        },
      },
    }
  )
}

/**
 * Create an admin client that bypasses RLS.
 * Uses the service role key directly with @supabase/supabase-js
 * (not @supabase/ssr which doesn't properly bypass RLS).
 */
export async function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}

/** User-scoped writes preserve auth.uid() for RLS and participation triggers. */
export function createRequestClient(request: Request) {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: request.headers.get('Authorization') || '' } },
      auth: { persistSession: false, autoRefreshToken: false } }
  )
}

/** Access-only cookie; the browser remains responsible for refreshing its session. */
export async function createAccessClient() {
  const token = (await cookies()).get('sp-access-token')?.value
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export async function getAccessUser() {
  const token = (await cookies()).get('sp-access-token')?.value
  if (!token) return null
  const client = await createAccessClient()
  const { data: { user }, error } = await client.auth.getUser(token)
  return error ? null : user
}
