# Missing Features Design Document

**Date**: 2026-02-21
**Status**: Approved
**Author**: Claude Code + Benjamin

## Overview

This document captures the design for completing missing infrastructure and features in the Schelling Point MVP to enable intuitive event management, invitations, payments, and scheduling.

## Problem Statement

Several critical gaps prevent full platform usability:
1. Broadcast communications return 401 (auth bug)
2. Private events can't invite members
3. Ticket revenue has no payout visibility
4. Admin setup lacks bulk time slot generation (exists in wizard)
5. Session proposals don't capture expected attendance for capacity matching
6. No test data to exercise auto-scheduler

## Design Decisions

### Access Model for Private Events
**Decision**: Invite-only
**Rationale**: Simpler, more secure, no spam/moderation burden. Owners/admins send invite links; no public "request to join" flow.

### Payment Flow
**Decision**: Stripe Connect
**Rationale**: Each organizer connects their own Stripe account. Automatic splits (95% organizer, 5% platform), less liability, standard practice for marketplaces.

### Venue Capacity Matching
**Decision**: Simple capacity numbers
**Rationale**: Venues have max capacity integer. Sessions specify expected attendance. Auto-scheduler checks fit. No need for named tiers initially.

### Test Data Volume
**Decision**: 20-30 sessions
**Rationale**: Enough to test scheduling conflicts, track constraints, and capacity limits without overwhelming the UI.

---

## Phase A: Bug Fixes

### A1: Broadcast API 401 Fix

**Problem**: `/admin/communications` page uses `credentials: 'include'` but doesn't pass Authorization header.

**Solution**:
- Import `getAccessToken()` from `@/lib/supabase/client`
- Add `Authorization: Bearer ${token}` to all fetch calls
- Redirect to login if no token

**Files**:
- `src/app/e/[slug]/admin/communications/page.tsx`

### A2: Session Import Verification

**Action**: Manual test of existing import feature to confirm it works.

---

## Phase B: Core Missing Features

### B3: Event Invitations System

**Database Schema**:
```sql
CREATE TABLE event_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT, -- NULL for reusable links
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  role TEXT NOT NULL DEFAULT 'attendee',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  accepted_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_invitations_event ON event_invitations(event_id);
CREATE INDEX idx_event_invitations_token ON event_invitations(token);
```

**RLS Policies**:
- SELECT: Event owners/admins can view invitations
- INSERT: Event owners/admins can create invitations
- UPDATE: System can mark as accepted
- DELETE: Event owners/admins can revoke

**Components**:

1. **Admin Members Page** (`/admin/members`)
   - List current event_members with roles
   - "Invite People" button opens modal
   - Invite modal: email input, role selector, generate link option
   - Pending invitations list with copy link / revoke actions

2. **Invite Acceptance Page** (`/invite/e/[token]`)
   - Fetch invitation by token
   - Show event name, description, who invited
   - If expired/used: show error
   - If logged in: "Accept Invitation" button
   - If not logged in: prompt to sign up, redirect back after auth

**API Endpoints**:
- `POST /api/v1/events/[slug]/invitations` - Create invitation
- `GET /api/v1/events/[slug]/invitations` - List pending invitations
- `DELETE /api/v1/events/[slug]/invitations/[id]` - Revoke invitation
- `POST /api/v1/invitations/[token]/accept` - Accept invitation (adds to event_members)

### B4: Bulk Time Slot Generator in Admin

**Approach**: Extract wizard component, add to admin setup.

**Components**:

1. **BulkSlotGenerator** (`/components/admin/BulkSlotGenerator.tsx`)
   - Props: `eventId`, `venues`, `dates`, `onComplete`
   - State: venue selection, date selection, duration, break, start/end time
   - Preview calculated slots before creation
   - Conflict detection with existing slots

2. **Admin Setup Integration**
   - Add "Bulk Generate" button next to manual slot creation
   - Opens modal with BulkSlotGenerator
   - On submit: POST to existing time_slots API
   - Refresh slot list on completion

---

## Phase C: Payment Infrastructure

### C5: Stripe Connect Integration

**Database**:
```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS stripe_account_status TEXT DEFAULT 'none';
```

**OAuth Flow**:
1. Admin clicks "Connect Stripe Account" in setup
2. Redirect to Stripe Connect OAuth
3. Callback saves `stripe_account_id` to event
4. Mark status as 'active'

**Components**:

1. **Setup Page Addition** (`/admin/setup`)
   - "Payments" section
   - If not connected: "Connect Stripe Account" button
   - If connected: Show status, "View Stripe Dashboard" link
   - Display fee structure info

**API Endpoints**:
- `POST /api/v1/events/[slug]/stripe/connect` - Generate OAuth URL
- `GET /api/v1/events/[slug]/stripe/callback` - Handle OAuth callback
- `GET /api/v1/events/[slug]/stripe/status` - Check connection status

### C6: Revenue Dashboard Enhancement

**Additions to** `/admin/revenue`:
- "Your Earnings" card: total revenue minus platform fees
- "Platform Fees" card: 5% + $0.50 per ticket
- "View in Stripe Dashboard" button (links to connected account)
- If Stripe API available: show pending vs available balance

---

## Phase D: Scheduling Improvements

### D7: Session Capacity Field

**Database**:
```sql
-- expected_attendance already exists, ensure it's used
```

**Proposal Form Update**:
- Add "Expected Attendance" dropdown
- Options: "1-10", "10-25", "25-50", "50-100", "100+"
- Store as integer (midpoint of range)
- Help text explaining venue matching

### D8: Auto-Scheduler Capacity Check

**Algorithm Update** (in auto-schedule logic):
```typescript
function canAssignToVenue(session: Session, venue: Venue): boolean {
  if (!session.expected_attendance) return true;
  if (!venue.capacity) return true;
  return session.expected_attendance <= venue.capacity;
}
```

**Schedule Builder UI**:
- Show capacity warning on manual drag to undersized venue
- Color-code venues by available capacity

### D9: Test Data Generator

**Admin UI**: Development tools section in `/admin`
- "Generate Test Sessions" button
- Confirmation modal explaining what will be created
- "Clear Test Data" to remove seeded sessions

**Session Distribution** (25-30 total):
- 5 sessions requesting same popular time slot
- 3 sessions by same presenter
- 4 sessions requiring large venue (100+ attendance)
- 2 multi-slot workshop sessions
- 6 sessions with track assignments
- 8 flexible sessions with no special constraints

**API Endpoint**:
- `POST /api/v1/events/[slug]/admin/seed-sessions`

---

## Implementation Sequence

```
Phase A (Bug Fixes)
├── A1: Broadcast API 401 fix
└── A2: Session import verification

Phase B (Core Features)
├── B3: Event invitations
│   ├── Migration
│   ├── API endpoints
│   ├── /admin/members page
│   └── /invite/e/[token] page
└── B4: Bulk slot generator
    ├── Extract component
    └── Add to admin setup

Phase C (Payments)
├── C5: Stripe Connect
│   ├── Migration
│   ├── OAuth flow
│   └── Setup page integration
└── C6: Revenue dashboard enhancement

Phase D (Scheduling)
├── D7: Session capacity field
├── D8: Auto-scheduler capacity check
└── D9: Test data generator
```

## Success Criteria

- [ ] Broadcast messages send without 401 error
- [ ] Private events can invite members via link
- [ ] Event organizers can connect Stripe accounts
- [ ] Revenue shows earnings after platform fees
- [ ] Admins can bulk-generate time slots
- [ ] Session proposals capture expected attendance
- [ ] Auto-scheduler respects venue capacity
- [ ] Test data exercises scheduling constraints

## Out of Scope

- Request-to-join for private events (invite-only chosen)
- Named capacity tiers (simple numbers chosen)
- Refund management UI (use Stripe dashboard)
- Promo codes / discounts
- Ticket resale / transfer

## Implementation note: C5 Stripe Connect (2026-09-14)

Implemented as Express accounts owned by the platform (not the OAuth flow
sketched above; Stripe now steers new platforms to Express + account links).

- `POST /api/v1/events/[slug]/admin/stripe-connect` (owner/admin) creates an
  Express account on first call (`accounts.create` with `type: 'express'`,
  `card_payments` + `transfers` capabilities, `metadata.event_id/event_slug`),
  stores `events.stripe_account_id`, then returns an onboarding link from
  `accountLinks.create({ type: 'account_onboarding' })`. `?action=dashboard`
  returns an Express Dashboard link (`accounts.createLoginLink`).
- `GET` returns `{ connected, accountId, chargesEnabled, payoutsEnabled,
  detailsSubmitted, requirementsDue, platformFallbackAllowed }` via
  `accounts.retrieve`.
- `DELETE` (owner) clears `stripe_account_id` and, unless
  `STRIPE_ALLOW_PLATFORM_CHARGES=true`, sets `ticketing_enabled=false`. The
  Stripe account is never deleted.
- No server-side callback route: `return_url`/`refresh_url` land on
  `/e/[slug]/admin/tickets?stripe=return|refresh`; the page shows a banner and
  re-fetches `GET`, which is the only trustworthy source of onboarding state.
- `stripe_account_status` column was not added; status is read live from
  Stripe rather than cached.
- Checkout is unchanged in behaviour: null `stripe_account_id` charges the
  platform account; a connected account gets `transfer_data.destination` +
  `application_fee_amount = calculatePlatformFee(price)` (5% + $0.50).
- Admin UI blocks *enabling* ticket sales while paid tiers exist unless the
  connected account has `charges_enabled`, or (with no account connected)
  `STRIPE_ALLOW_PLATFORM_CHARGES=true`. Free-only events are never blocked.
- Without `STRIPE_SECRET_KEY`, every stripe-connect handler and paid checkout
  answer `503 { error: 'Payments are not configured' }`.
