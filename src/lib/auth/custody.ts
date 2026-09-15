import 'server-only'
/**
 * The PRIMARY door (spec §7): an email becomes a fresh identity on our own PDS.
 *
 *   startEmailSignIn(email)
 *     └─ lock(email) → existing account? → magic link
 *                    → else createInviteCode → createAccount(<generated handle>) → wrap password
 *                      → accounts(kind 'custodial') → magic link
 *
 * The member never chooses or sees the password: 32 random bytes, AES-256-GCM wrapped
 * (`src/lib/atproto/crypto.ts`), held by the app. `takeOwnership` is the documented exit.
 * The handle is `<word><word><NNN>.<domain>` and is NEVER derived from the email.
 *
 * Ported from Free School `apps/appview/src/lib/custody.ts` (Drizzle → `sql` tagged
 * templates), keeping its ordering guarantees: the advisory lock that serialises a
 * brand-new email, the orphan self-heal, and take-ownership's commit-then-rotate-then-undo.
 *
 * REVEAL STORAGE (a deliberate adaptation). Free School keeps the one-time password in an
 * `fs_ownership_reveal` row. Here the token half lives in `auth_email_tokens`
 * (purpose 'reveal') — which has no blob column, and should not: it is a token table —
 * and the WRAPPED new password lives in `at_credentials` under the synthetic key
 * `did = 'reveal:' || token_hash` (kind 'app-password', identifier = the member's DID,
 * created_by = the account). Revealing claims the token row atomically and then DELETES
 * the credential row, so the password exists at rest only until it is shown once (or the
 * link is replaced). Nothing looks up `at_credentials` by a `reveal:` key except this file.
 */
import { sql, tx } from '@/lib/db'
import { safeReturnPath } from '@/lib/auth-redirect'
import { defaultPdsUrl, isProduction, publicUrl } from '@/lib/atproto/config'
import { unwrapSecret, wrapSecret } from '@/lib/atproto/crypto'
import { evictAgent } from '@/lib/atproto/agent'
import { generateHandle, handleDomain, isReservedLabel, isStaticReservedLabel, isValidGatheringLabel } from './handles'
import { createAccount, createInviteCode, PdsError, searchAccountByEmail, updateAccountPassword } from './pds'
import { sendMail } from './mail'
import { hashToken, newToken, randomPassword } from './tokens'

type Tx = Parameters<Parameters<typeof tx>[0]>[0]

export const SIGNIN_TTL_MS = 15 * 60 * 1000
export const REVEAL_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_SIGNIN_LINKS_PER_HOUR = 5
const MINT_ATTEMPTS = 5

/**
 * The PDS's phrasings of "this email already belongs to an account" (pds 0.4:
 * `InvalidRequest` / "Email already taken: <email>").
 */
const EMAIL_TAKEN_RE = /^email.*(taken|already|in use)/i

/**
 * A handle the PDS will not mint, worth drawing again for. pds 0.4 answers a taken handle
 * with `InvalidRequest` / "Handle already taken: <handle>" (NOT `HandleNotAvailable`), a
 * reserved one with `HandleNotAvailable` / "Reserved handle", and a malformed one with
 * `InvalidRequest` / "Invalid handle ...".
 */
function isRetryableHandleError(err: unknown): boolean {
  if (!(err instanceof PdsError)) return false
  if (err.code === 'HandleNotAvailable' || err.code === 'InvalidHandle') return true
  return err.code === 'InvalidRequest' && /^(handle already taken|invalid handle|reserved handle)/i.test(err.message)
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/** A take-ownership link is already live; rotating again would orphan its password. */
export class RevealPendingError extends AuthError {
  constructor(readonly expiresAt: Date) {
    super('A take-ownership link is already pending for this account. Check your email.', 409, 'RevealPending')
  }
}

export interface AccountRecord {
  id: string
  did: string
  handle: string | null
  email: string | null
  kind: 'custodial' | 'oauth'
  owned_at: string | null
  email_verified_at: string | null
}

export function normalizeEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : ''
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('That does not look like an email address.', 400, 'InvalidEmail')
  }
  return email
}

export async function getAccount(accountId: string): Promise<AccountRecord | null> {
  const rows = await sql<AccountRecord[]>`
    select id, did, handle, email, kind, owned_at, email_verified_at from accounts where id = ${accountId}
  `
  return rows[0] ?? null
}

/* ───────────────────────────── minting ───────────────────────────── */

async function drawHandle(): Promise<string> {
  const domain = handleDomain()
  for (let i = 0; i < 10; i++) {
    const handle = generateHandle(domain)
    if (!(await isReservedLabel(handle.slice(0, handle.indexOf('.'))))) return handle
  }
  throw new AuthError('Could not generate a handle.', 502, 'HandleGenerationFailed')
}

/**
 * Mint under an already-held `pg_advisory_xact_lock(hashtext(email))`, with no existing
 * `accounts` row for the email. Returns the (possibly adopted) account.
 */
async function mintLocked(t: Tx, email: string): Promise<{ accountId: string; did: string; handle: string }> {
  const password = randomPassword(32)
  // Wrap BEFORE touching the PDS: a missing custody key must not strand a minted account.
  const { wrapped, keyVersion } = wrapSecret(password)
  const inviteCode = await createInviteCode(1)

  let account: { did: string; handle: string } | undefined
  let adopted = false
  let lastError: unknown
  for (let attempt = 0; attempt < MINT_ATTEMPTS && !account; attempt++) {
    const handle = await drawHandle()
    try {
      account = await createAccount({ email, handle, password, inviteCode })
    } catch (err) {
      lastError = err
      if (isRetryableHandleError(err)) continue
      if (err instanceof PdsError && EMAIL_TAKEN_RE.test(err.message)) {
        // Orphan self-heal: the PDS already holds this email — almost certainly an earlier
        // sign-up that minted the account and then failed before its row committed.
        const found = await searchAccountByEmail(email)
        if (!found) {
          throw new AuthError('Could not create the account: the email is registered on the PDS but no account was found.', 502, 'PdsRejected')
        }
        // Re-checked under the same lock, right before rotating anything.
        const already = await t<{ id: string; did: string; handle: string | null; email: string | null }[]>`
          select id, did, handle, email from accounts where did = ${found.did} or email = ${email} limit 1
        `
        if (already[0]) {
          if (already[0].email === email) {
            return { accountId: already[0].id, did: already[0].did, handle: already[0].handle ?? found.handle }
          }
          throw new AuthError('Could not create the account.', 502, 'PdsRejected')
        }
        await updateAccountPassword(found.did, password)
        account = found
        adopted = true
        break
      }
      throw err
    }
  }
  if (!account) {
    const detail = lastError instanceof Error ? lastError.message : 'unknown'
    throw new AuthError(`Could not mint an account on the PDS: ${detail}`, 502, 'PdsRejected')
  }

  const inserted = await t<{ id: string }[]>`
    insert into accounts (did, handle, email, kind, wrapped_password, key_version)
    values (${account.did}, ${account.handle}, ${email}, 'custodial', ${wrapped}, ${keyVersion})
    on conflict do nothing
    returning id
  `
  if (!inserted[0]) {
    const raced = await t<{ id: string; did: string; handle: string | null }[]>`
      select id, did, handle from accounts where email = ${email}
    `
    if (raced[0]) return { accountId: raced[0].id, did: raced[0].did, handle: raced[0].handle ?? account.handle }
    throw new AuthError('Could not create the account.', 502, 'PdsRejected')
  }
  const accountId = inserted[0].id
  await t`
    update profiles set did = ${account.did}, atproto_handle = ${account.handle},
      atproto_linked_at = coalesce(atproto_linked_at, now())
    where id = ${accountId}
  `
  console.info(adopted ? '[custody] adopted an orphaned PDS account' : `[custody] custodial account minted under .${handleDomain()}`)
  return { accountId, did: account.did, handle: account.handle }
}

async function lockEmail(t: Tx, email: string): Promise<void> {
  await t`select pg_advisory_xact_lock(hashtext(${email}))`
}

async function findByEmail(t: Tx, email: string) {
  const rows = await t<{ id: string; did: string; handle: string | null }[]>`
    select id, did, handle from accounts where email = ${email}
  `
  return rows[0] ?? null
}

/** Find-or-mint the custodial account for `email`. Idempotent; serialised per email. */
export async function mintCustodialAccount(emailInput: string): Promise<{ accountId: string; did: string; handle: string }> {
  const email = normalizeEmail(emailInput)
  return tx(async (t) => {
    await lockEmail(t, email)
    const existing = await findByEmail(t, email)
    if (existing) return { accountId: existing.id, did: existing.did, handle: existing.handle ?? '' }
    return mintLocked(t, email)
  })
}

/* ───────────────────────────── sign-in ───────────────────────────── */

/**
 * Sign in OR sign up: one door. An existing account (custodial, or custodial-then-owned)
 * gets a link; a new email gets an identity minted first. An owned account can still use
 * email to open a session here — it just can no longer publish through custody.
 */
export async function startEmailSignIn(emailInput: string, nextPath: string | null | undefined): Promise<{ ok: true; devVerifyUrl?: string }> {
  const email = normalizeEmail(emailInput)
  const next = safeReturnPath(nextPath)
  const token = newToken()

  await tx(async (t) => {
    await lockEmail(t, email)
    const recent = await t<{ n: number }[]>`
      select count(*)::int as n from auth_email_tokens
      where email = ${email} and purpose = 'signin' and created_at > now() - interval '1 hour'
    `
    if ((recent[0]?.n ?? 0) >= MAX_SIGNIN_LINKS_PER_HOUR) {
      throw new AuthError('Too many sign-in links requested for this address. Try again in an hour.', 429, 'RateLimited')
    }
    const existing = await findByEmail(t, email)
    const accountId = existing ? existing.id : (await mintLocked(t, email)).accountId
    await t`
      insert into auth_email_tokens (token_hash, email, account_id, purpose, next_path, expires_at)
      values (${hashToken(token)}, ${email}, ${accountId}, 'signin', ${next}, ${new Date(Date.now() + SIGNIN_TTL_MS)})
    `
  })

  const url = `${publicUrl()}/auth/verify?token=${encodeURIComponent(token)}`
  const { delivered } = await sendMail({
    to: email,
    subject: 'Your unconference sign-in link',
    text: [
      'Open this link to sign in:',
      url,
      '',
      'It works once and expires in 15 minutes. If you did not ask for it, ignore this email.',
    ].join('\n'),
  })
  return { ok: true, ...(!delivered && !isProduction() ? { devVerifyUrl: url } : {}) }
}

/** Consume a sign-in token. Atomic: a double click cannot open two sessions from one link. */
export async function verifyEmailToken(token: string): Promise<{ accountId: string; nextPath: string }> {
  if (!token || typeof token !== 'string') throw new AuthError('That sign-in link is no longer valid.', 400, 'InvalidToken')
  const rows = await sql<{ account_id: string | null; next_path: string | null; email: string }[]>`
    update auth_email_tokens set used_at = now()
    where token_hash = ${hashToken(token)} and purpose = 'signin' and used_at is null and expires_at > now()
    returning account_id, next_path, email
  `
  const row = rows[0]
  if (!row) throw new AuthError('That sign-in link is no longer valid.', 400, 'InvalidToken')
  let accountId = row.account_id
  if (!accountId) {
    const byEmail = await sql<{ id: string }[]>`select id from accounts where email = ${row.email}`
    accountId = byEmail[0]?.id ?? null
  }
  if (!accountId) throw new AuthError('That sign-in link is no longer valid.', 400, 'InvalidToken')
  await sql`update accounts set email_verified_at = coalesce(email_verified_at, now()) where id = ${accountId}`
  return { accountId, nextPath: safeReturnPath(row.next_path) }
}

/**
 * INTERNAL. The only reader of a custodial member's password — used when the app writes
 * to the member's own repo on their behalf. Never returned over HTTP, never logged.
 * Accepts an `accounts.id` or a DID.
 */
export async function custodialPassword(accountIdOrDid: string): Promise<string | null> {
  const rows = accountIdOrDid.startsWith('did:')
    ? await sql<{ kind: string; wrapped_password: Buffer | null; key_version: string | null; owned_at: string | null }[]>`
        select kind, wrapped_password, key_version, owned_at from accounts where did = ${accountIdOrDid}`
    : await sql<{ kind: string; wrapped_password: Buffer | null; key_version: string | null; owned_at: string | null }[]>`
        select kind, wrapped_password, key_version, owned_at from accounts where id = ${accountIdOrDid}`
  const row = rows[0]
  if (!row || row.kind !== 'custodial' || row.owned_at || !row.wrapped_password || !row.key_version) return null
  return unwrapSecret(row.wrapped_password, row.key_version)
}

/* ───────────────────────────── take ownership ───────────────────────────── */

function revealKey(tokenHash: string): string {
  return `reveal:${tokenHash}`
}

export interface TakeOwnershipResult {
  handle: string
  /** Returned when mail was not delivered (unconfigured, or the send failed). */
  revealUrl?: string
}

/**
 * The exit from custody. Ordering (Free School, review round 1, C1):
 *   1. the caller is this account's own session (the route's `requireViewer`);
 *   2. refuse (409 RevealPending) while an unused, unexpired reveal link exists; clear
 *      any unused expired one;
 *   3. in ONE transaction: the reveal token row, the wrapped new password, and the account
 *      flip (`wrapped_password = null`, `owned_at = now()`);
 *   4. rotate the PDS password admin-side; if that throws, undo step 3 exactly and 502;
 *   5. email the reveal link; a mail failure still returns the link to this session.
 * From then on `agentForAccount` refuses custodial writes for this DID.
 */
export async function takeOwnership(accountId: string): Promise<TakeOwnershipResult> {
  const newPassword = randomPassword(18)
  const { wrapped, keyVersion } = wrapSecret(newPassword)
  const token = newToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + REVEAL_TTL_MS)

  const prepared = await tx(async (t) => {
    await t`select pg_advisory_xact_lock(hashtext(${`own:${accountId}`}))`
    const rows = await t<{
      id: string; did: string; handle: string | null; email: string | null; kind: string
      wrapped_password: Buffer | null; key_version: string | null; owned_at: string | null
    }[]>`
      select id, did, handle, email, kind, wrapped_password, key_version, owned_at from accounts where id = ${accountId} for update
    `
    const account = rows[0]
    if (!account) throw new AuthError('No account for this session.', 404, 'NotFound')
    if (account.kind !== 'custodial') {
      throw new AuthError('This identity is already yours: you signed in with your own ATProto account.', 409, 'NotCustodial')
    }
    if (!account.email) throw new AuthError('This account has no email to send the reveal link to.', 409, 'NoEmail')

    const pending = await t<{ expires_at: string }[]>`
      select expires_at from auth_email_tokens
      where account_id = ${accountId} and purpose = 'reveal' and used_at is null and expires_at > now()
      order by created_at desc limit 1
    `
    if (pending[0]) throw new RevealPendingError(new Date(pending[0].expires_at))

    await t`
      delete from at_credentials where did in (
        select 'reveal:' || token_hash from auth_email_tokens
        where account_id = ${accountId} and purpose = 'reveal' and used_at is null
      )
    `
    await t`delete from auth_email_tokens where account_id = ${accountId} and purpose = 'reveal' and used_at is null`

    await t`
      insert into auth_email_tokens (token_hash, email, account_id, purpose, next_path, expires_at)
      values (${tokenHash}, ${account.email}, ${accountId}, 'reveal', null, ${expiresAt})
    `
    await t`
      insert into at_credentials (did, kind, identifier, wrapped, key_version, pds_url, created_by)
      values (${revealKey(tokenHash)}, 'app-password', ${account.did}, ${wrapped}, ${keyVersion}, ${defaultPdsUrl()}, ${accountId})
    `
    await t`update accounts set wrapped_password = null, key_version = null, owned_at = now() where id = ${accountId}`
    return {
      did: account.did,
      handle: account.handle ?? '',
      email: account.email,
      prior: { wrapped_password: account.wrapped_password, key_version: account.key_version, owned_at: account.owned_at },
    }
  })

  try {
    await updateAccountPassword(prepared.did, newPassword)
  } catch {
    await tx(async (t) => {
      await t`delete from at_credentials where did = ${revealKey(tokenHash)}`
      await t`delete from auth_email_tokens where token_hash = ${tokenHash}`
      await t`
        update accounts set wrapped_password = ${prepared.prior.wrapped_password},
          key_version = ${prepared.prior.key_version}, owned_at = ${prepared.prior.owned_at}
        where id = ${accountId}
      `
    })
    console.error('[custody] take-ownership PDS rotation failed; rolled back, member can retry')
    throw new AuthError('Could not rotate the PDS password. Nothing changed; please try again.', 502, 'PdsRotationFailed')
  }
  evictAgent(prepared.did)

  const url = `${publicUrl()}/account/reveal?token=${encodeURIComponent(token)}`
  let delivered = false
  try {
    ;({ delivered } = await sendMail({
      to: prepared.email,
      subject: 'Take full ownership of your unconference identity',
      text: [
        `You asked to take full ownership of @${prepared.handle}.`,
        '',
        'Open this link to see your new password. It is shown ONCE, so save it somewhere safe:',
        url,
        '',
        'Then sign in with it at your PDS and change it to one of your own choosing.',
        'You can export your full repository any time with com.atproto.sync.getRepo: it is your data.',
        '',
        'The link works once and expires in 24 hours. From now on, publishing here needs a real ATProto sign-in.',
      ].join('\n'),
    }))
  } catch {
    console.warn('[custody] ownership reveal mail failed; returning the link to the session')
  }
  console.info('[custody] custodial account took ownership')
  return { handle: prepared.handle, ...(delivered ? {} : { revealUrl: url }) }
}

export type RevealOwnershipResult =
  | { ok: true; handle: string; password: string }
  | { ok: false; status: number; error: string; code: string }

/** The single-use reveal. Claims the token atomically, then deletes the stored password. */
export async function revealOwnershipPassword(token: string): Promise<RevealOwnershipResult> {
  if (!token) return { ok: false, status: 404, code: 'NotFound', error: 'Unknown take-ownership link.' }
  const tokenHash = hashToken(token)
  const claimed = await sql<{ account_id: string | null }[]>`
    update auth_email_tokens set used_at = now()
    where token_hash = ${tokenHash} and purpose = 'reveal' and used_at is null and expires_at > now()
    returning account_id
  `
  if (!claimed[0]) {
    const existing = await sql<{ used_at: string | null }[]>`
      select used_at from auth_email_tokens where token_hash = ${tokenHash} and purpose = 'reveal'
    `
    if (!existing[0]) return { ok: false, status: 404, code: 'NotFound', error: 'Unknown take-ownership link.' }
    return existing[0].used_at
      ? { ok: false, status: 410, code: 'AlreadyUsed', error: 'This link has already been used. The password was shown once.' }
      : { ok: false, status: 410, code: 'Expired', error: 'This link has expired.' }
  }
  const creds = await sql<{ wrapped: Buffer | null; key_version: string | null }[]>`
    delete from at_credentials where did = ${revealKey(tokenHash)} returning wrapped, key_version
  `
  const cred = creds[0]
  if (!cred?.wrapped || !cred.key_version) {
    return { ok: false, status: 410, code: 'AlreadyUsed', error: 'This link has already been used.' }
  }
  const password = unwrapSecret(cred.wrapped, cred.key_version)
  const account = claimed[0].account_id ? await getAccount(claimed[0].account_id) : null
  return { ok: true, handle: account?.handle ?? '', password }
}

/* ───────────────────────────── gatherings ───────────────────────────── */

/**
 * The mailbox a gathering account is registered under. The reference PDS REQUIRES an email
 * for every hosted account (pds 0.4: `InvalidRequest` / "Email is required") and rejects an
 * address whose domain has no dot (`x@test`: "This email address is not supported"). So:
 * `gathering+<slug>@<domain>` — a mailbox on our own domain, never a person's address — or
 * `gathering+<slug>@gatherings.<domain>` when the handle domain is a bare label (locally `test`).
 */
export function gatheringMailbox(slug: string, domain: string): string {
  const local = `gathering+${slug.replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'event'}`
  return domain.includes('.') ? `${local}@${domain}` : `${local}@gatherings.${domain}`
}

/**
 * Mint a gathering's own identity on our PDS: handle `<slug>.<domain>` when the slug is a
 * valid label outside the static reserved list (else, or when the PDS refuses it, a
 * generated one), a random password wrapped into `at_credentials` (kind 'app-password').
 * Wired into event creation in Wave 1.
 */
export async function mintGatheringAccount(input: { slug: string; name: string; createdBy: string }): Promise<{ did: string; handle: string }> {
  const domain = handleDomain()
  const slug = input.slug.trim().toLowerCase()
  const password = randomPassword(32)
  const { wrapped, keyVersion } = wrapSecret(password)
  const inviteCode = await createInviteCode(1)
  const email = gatheringMailbox(slug, domain)
  const preferred = isValidGatheringLabel(slug) && !isStaticReservedLabel(slug) ? `${slug}.${domain}` : null

  let account: { did: string; handle: string } | undefined
  let lastError: unknown
  let handle = preferred ?? (await drawHandle())
  for (let attempt = 0; attempt < MINT_ATTEMPTS && !account; attempt++) {
    try {
      account = await createAccount({ email, handle, password, inviteCode })
    } catch (err) {
      lastError = err
      if (isRetryableHandleError(err)) {
        handle = await drawHandle()
        continue
      }
      throw err
    }
  }
  if (!account) {
    const detail = lastError instanceof Error ? lastError.message : 'unknown'
    throw new AuthError(`Could not mint the gathering identity: ${detail}`, 502, 'PdsRejected')
  }

  await sql`
    insert into at_credentials (did, kind, identifier, wrapped, key_version, pds_url, created_by, rotated_at)
    values (${account.did}, 'app-password', ${account.handle}, ${wrapped}, ${keyVersion}, ${defaultPdsUrl()}, ${input.createdBy}, now())
  `
  console.info(`[custody] gathering identity minted for ${JSON.stringify(input.name.slice(0, 80))}`)
  return account
}

/** Map an `AuthError` (or a `PdsError`) to `{ error, code }` JSON; null for anything else. */
export function authErrorResponse(e: unknown): Response | null {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (e instanceof AuthError) return Response.json({ error: e.message, code: e.code }, { status: e.status, headers })
  if (e instanceof PdsError) {
    return Response.json(
      { error: 'The identity server did not accept the request. Please try again.', code: e.code ?? 'PdsError' },
      { status: e.status === 503 ? 503 : 502, headers },
    )
  }
  return null
}
