#!/usr/bin/env node
/**
 * Local-only: sign in through the real custodial door and print the session cookie.
 *   node scripts/dev-login.mjs someone@example.test [http://localhost:3001]
 * Prints `sp_at_session=<value>` on stdout (pass it as `Cookie:` in curl or Playwright).
 * Requires the dev server running with RESEND_API_KEY unset so /api/auth/email returns devVerifyUrl.
 * To make the account an organizer of the demo gathering (local DB only):
 *   psql "$DATABASE_MIGRATION_URL" -c "insert into event_members(event_id,user_id,role)
 *     select e.id, a.id, 'owner' from events e, accounts a where e.slug='demo-gathering' and a.email='someone@example.test'
 *     on conflict (event_id,user_id) do update set role=excluded.role"
 */
const [email, base = 'http://localhost:3001'] = process.argv.slice(2)
if (!email) {
  console.error('usage: node scripts/dev-login.mjs <email> [base]')
  process.exit(2)
}
const res = await fetch(`${base}/api/auth/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ email, next: '/' }),
})
const body = await res.json().catch(() => ({}))
if (!res.ok || !body.devVerifyUrl) {
  console.error(`sign-in request failed (${res.status}):`, body)
  process.exit(1)
}
// The link's GET only renders a confirmation page; the form POST consumes the token (303 + cookie).
const token = new URL(body.devVerifyUrl).searchParams.get('token') ?? ''
const verify = await fetch(`${base}/auth/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
  body: new URLSearchParams({ token }).toString(),
  redirect: 'manual',
})
const cookie = (verify.headers.getSetCookie?.() ?? [verify.headers.get('set-cookie') ?? ''])
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('sp_at_session='))
if (!cookie) {
  console.error(`verify did not set a session cookie (${verify.status})`)
  process.exit(1)
}
console.log(cookie)
