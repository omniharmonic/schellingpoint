## Answer in one line

Yes — the app fetches the Bluesky profile at every OAuth sign-in and copies `displayName` / `avatar` / `description` into `public.profiles`, but only into **empty** fields, only from `public.api.bsky.app` (never the user's own PDS record), and **never again afterwards** — the handle is the only thing that stays fresh.

---

## 1. The OAuth sign-in path

**Start:** `src/app/login/LoginClient.tsx:57-78` → `GET /api/atproto/auth/start` (`src/app/api/atproto/auth/start/route.ts`) → `src/lib/atproto/oauth.ts`. Scope is `atproto transition:generic` (`src/lib/atproto/oauth.ts:42`) — enough to read the user's repo, but that capability is never used for profile data.

**Callback:** `src/app/oauth/callback/route.ts`

| line | what happens |
|---|---|
| `:56-58` | `handleCallback(params)` → DID; `verifyOAuthState` |
| `:64-69` | `resolveDidDoc(did)` → `handle`, `pds`. On failure, falls back to `fetchBskyProfile(did)?.handle` |
| `:74` | `findOrCreateOAuthAccount(did, handle)` |
| `:76` | **`await importBskyProfile(accountId, did, { placeholderName: handle.split('.')[0] })`** — awaited, errors swallowed |
| `:77-78` | `createAtSession` → `sp_at_session` cookie → redirect to `state.next` |

**Account row:** `src/lib/atproto/bridge.ts:155-180`
- Existing DID → row reused; if the handle changed, `accounts.handle` **and** `profiles.atproto_handle` are updated (`:163-166`). This is the one thing refreshed on every sign-in.
- New DID → `insert into accounts (did, handle, email=null, kind='oauth')`; the `on_account_created` trigger (`db/migrations/0001_baseline.sql:2867` → `handle_new_user()` at `:505-524`) inserts the `profiles` row with `email = ''` and `display_name = split_part(handle,'.',1)` (e.g. `alice` for `alice.bsky.social`). Then `:173-176` sets `profiles.did`, `atproto_handle`, `atproto_linked_at`.

## 2. The profile fetch

`src/lib/atproto/bsky-profile.ts`

- `fetchBskyProfile(actor)` — `:31-49`. `GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=…`, unauthenticated, via `safeFetch` (`src/lib/net/safe-fetch.ts`), 5 s timeout, DID cross-checked against the response (`:40`). Returns `{did, handle, displayName, avatar, description}`.
- `applyBskyProfile(userId, remote, opts)` — `:70-118`:
  - `display_name` written only if currently blank, **or** if `onboarding_completed = false` and the current value equals `placeholderName` (i.e. still the handle's first label) — `:80-82`.
  - `avatar_url`: only if blank. The remote `avatar` URL is **downloaded**, re-encoded through `sharp` (rotate, cover-resize 512×512, WebP q82) and stored on the app's own disk via `storeImage` (`src/lib/storage/files.ts:52-76`) → `avatar_url = '/uploads/<aa>/<sha256>.webp'` (`:84-96`).
  - `bio` ← `description`, only if blank (`:97`).
  - Write-back is a compare-and-swap (`case when col is not distinct from <old> …`) plus `exists (select 1 from accounts where id = … and did = remote.did)` (`:104-114`) — a concurrent profile edit wins, and a mismatched DID writes nothing. Test: `tests/profile-import.spec.ts`.
- `importBskyProfileInBackground` (`:120-128`) is **exported but never called anywhere** — dead code.

## 3. Where it is stored

Single table, `public.profiles` (`db/migrations/0001_baseline.sql:1335-1353`), PK `id` → `accounts.id`:

```
display_name text, bio text, avatar_url text, affiliation, building, telegram,
interests text[], ens, did text, atproto_handle text, atproto_linked_at, onboarding_completed, …
```

Identity lives on `public.accounts` (`:90-102`): `did` (unique, not null), `handle`, `email` (NULL for OAuth), `kind ∈ {custodial, oauth}`.

Note the **duplication**: the handle exists in both `accounts.handle` and `profiles.atproto_handle`. All read paths use `accounts.handle`; `profiles.atproto_handle` is written but essentially never read (only `src/hooks/useAuth.tsx:38` types it).

## 4. Where it is displayed

| surface | source | fields shown |
|---|---|---|
| Participants grid + modal, `src/app/e/[slug]/participants/page.tsx` | `GET /api/v1/events/[slug]/participants` → `memberCardColumns()` in `src/app/api/v1/events/[slug]/participants/people.ts:36-41` (`a.id, a.did, a.handle` + `p.display_name, p.avatar_url, p.affiliation, p.bio, p.building, p.interests, p.telegram`) | avatar `:406-412` (with `referrerPolicy="no-referrer"` and an `onError` initial-letter fallback), name `:72-74` (`display_name \|\| '@'+handle \|\| 'Member'`), handle **only in the modal** `:496-500`, bio `:513` |
| Session cards, `src/components/SessionCard.tsx:123-124` | `hostByline()` in `src/app/api/v1/sessions/_lib/byline.ts` | name only — **no avatar on cards** |
| Session detail, `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx:280-296` | `src/app/api/v1/sessions/_lib/read.ts:216-232` (`hp.display_name`, `hp.avatar_url`, `ha.handle`, cohosts via json_agg) | host/cohost avatar stack + byline |
| Sidebar/header avatar, `src/components/DashboardLayout.tsx:225-231, 328-334` | `useAuth().profile` ← `GET /api/auth/me` | avatar; initial fallback is `(display_name \|\| user.email \|\| '?')` — **no handle fallback**, so an OAuth user with no display name shows `?` |
| Cohost manager, `src/components/ManageCohostsSection.tsx:126-128` | invite lib | avatar + name |
| Settings identity block, `src/components/SettingsModal.tsx:582-600` | `GET /api/atproto/me` (`src/app/api/atproto/me/route.ts:24-37`) | `@handle`, DID, kind, publish-proposals toggle |

`memberCardColumns()` is deliberately narrow (no email, no `publish_proposals`, ENS only when verified + opted in).

## 5. Avatar serving — mirrored, not proxied, not CDN

Imported avatars are **copied** into `UPLOADS_DIR` and served from the app origin at `GET /uploads/<aa>/<sha256>.<ext>` (`src/app/uploads/[...path]/route.ts`) with `Cache-Control: public, max-age=31536000, immutable`, an ETag, `nosniff`, sandbox CSP and `Cross-Origin-Resource-Policy: cross-origin`. Not a live proxy: one copy at sign-in, then permanent.

`normalizeAvatarUrl` (`src/app/api/me/profile/validate.ts:109-136`) accepts `/uploads/...`, same-origin `/uploads/...`, an unchanged current value, **and** `https://cdn.bsky.app/...`. That last branch and its comment ("or a Bluesky CDN image imported at sign-in") are **stale** — the import path no longer stores CDN URLs, so this only matters for legacy rows. It also means a client could set its own `cdn.bsky.app` URL, defeating the mirroring policy for that one host.

## 6. Custodial (email) flow, by comparison

`POST /api/auth/email` → `src/lib/auth/custody.ts` `mintCustodialAccount` (`:248-257`) → `mintLocked` (`:215-236`): creates the PDS account, inserts `accounts (kind='custodial', email, wrapped_password)`, then sets `profiles.did / atproto_handle / atproto_linked_at`. The same `handle_new_user()` trigger seeds `display_name` from the generated handle's first label, `email` from the address.

There is **no remote profile to import** — the person fills everything in by hand:
- `OnboardingModal` (`src/components/auth/OnboardingModal.tsx`), rendered from `DashboardLayout.tsx:369-380` when `needsOnboarding` (`src/hooks/useAuth.tsx:127`, i.e. `onboarding_completed === false`). 4 intro slides + 3 profile steps; uploads an avatar via `uploadAvatar` → `POST /api/uploads?purpose=avatar` (≤2 MB, `src/lib/storage/upload.ts:24-42`); submits `PATCH /api/me/profile` with `onboarding_completed: true` (`:168-186`).
- `SettingsModal` (`src/components/SettingsModal.tsx`) — same fields later, plus the ATProto identity panel and "take ownership".

Both write through `PATCH /api/me/profile` (`src/app/api/me/profile/route.ts:70-133`), whose writable set is `WRITABLE_PROFILE_FIELDS` (validate.ts:19-30).

**The OAuth user goes through the exact same onboarding** — the import just pre-fills the form, because `/api/auth/me` (which feeds `initialProfile`) is read after the awaited import.

---

## Gaps and issues

1. **No refresh after first sign-in.** `importBskyProfile` runs on every sign-in but is a no-op once fields are non-empty (`bsky-profile.ts:80-97`). Change your display name, avatar or bio on Bluesky and this app stays stale forever. There is no background job: `reconcileAll` (`src/lib/atproto/ingest.ts:893`) and the Jetstream indexer never touch `profiles.display_name/avatar_url/bio`. The only self-healing identity field is the handle — updated on sign-in (`bridge.ts:163-166`) and by relay `#identity` events through `applyIdentityChange` (`src/lib/atproto/repo-status.ts:229-258`, which updates `accounts.handle`, `profiles.atproto_handle`, `events.actor_handle`).

2. **Profile is read from the Bluesky AppView, never from the PDS.** `public.api.bsky.app` only (`bsky-profile.ts:20`). An ATProto account on a PDS that Bluesky doesn't index — or a user whose `app.bsky.actor.profile` record exists but isn't federated — gets nothing, and lands in onboarding named after their handle's first label. The app holds an OAuth session that could `com.atproto.repo.getRecord` `app.bsky.actor.profile` directly from `state`'s resolved PDS; it never does.

3. **The app never writes `app.bsky.actor.profile`.** Nothing in `src`, `scripts` or `lexicons` references that NSID (only `docs/ATPROTO_AUDIT_2026-09-15.md:94`). So a custodial user's name/avatar/bio live only in Postgres — their own PDS repo has no profile record, and after "take ownership" they leave with an empty-looking identity. Round-tripping is one-way.

4. **Sign-in latency.** The import is `await`ed in the callback: up to 5 s for `getProfile` + 5 s for the avatar download + `sharp` re-encode, all before the redirect. `importBskyProfileInBackground` exists for exactly this and is unused (`bsky-profile.ts:120-128`).

5. **Handle-less worst case.** If both `resolveDidDoc` and `fetchBskyProfile` fail (callback `:64-69`), `handle` is `null` → `accounts.handle` null → the trigger's `COALESCE(NULLIF(split_part(NULL,'.',1),''), NULLIF(split_part(NULL,'@',1),''))` yields `NULL` display name (email is NULL for OAuth). The person shows as **"Member"** on the participants page (`participants/page.tsx:73`) and as **"?"** in the sidebar (`DashboardLayout.tsx:230`, which doesn't fall back to `user.handle` even when one exists).

6. **Handle is not shown on participant cards or session cards** — only inside the participant modal (`participants/page.tsx:496-500`) and in Settings. `hostByline` uses `@handle` only when `display_name` is absent.

7. **Stale `cdn.bsky.app` allowance** in `normalizeAvatarUrl` (validate.ts:132-134) — see §5.

8. **Inconsistent `referrerPolicy`.** Present on `participants/page.tsx:410` and `OnboardingModal.tsx:242`, absent on `DashboardLayout.tsx:226/329`, `ManageCohostsSection.tsx:127`, `SessionDetailClient.tsx:283`. Harmless for `/uploads/` paths, leaky for legacy `cdn.bsky.app` rows.

9. **`profiles.atproto_handle` is a write-only shadow** of `accounts.handle` — maintained in three places (`bridge.ts:165/174`, `custody.ts:230`, `repo-status.ts:244`) and read by no query.
