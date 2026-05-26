# Work-order assignments + external-worker portal

**Date:** 2026-05-26
**Status:** Draft, approved by Jordan, pending writing-plans

## 1. Goal

Add the ability to assign a work order to a person, where that person is either a **team member** or an **external worker** (a vendor / contractor invited into PropSpot). External workers log in to a stripped-down portal that shows only their assigned work orders and lets them upload photos via FieldCam scoped to those work orders' properties.

This unblocks the existing Maintenance app's `assigned_contact_id` column, which has been on the schema since the satellite was built but never surfaced in the UI.

## 2. Scope

**In scope:**

- New `work_orders.assigned_user_id` column.
- New `users.user_type` column distinguishing `'team'` vs `'external_worker'`.
- Assignee field + picker on every work order (detail card + edit modal).
- "+ Invite external worker" inline flow from the picker — creates a user, sends invite email, and auto-grants the right `app_grants` + `property_access` rows.
- New "Assigned to me" filter pill on the Maintenance list page.
- New `/my-work.html` portal for external-worker logins (chrome stripped, two-column WO list + detail, upload photos via FieldCam).
- Routing guard: `external_worker` users hitting any other URL get redirected to `/my-work.html`.
- Notifications: email to assignee (always) + Pulse mention (team members only — externals have no Pulse access).

**Out of scope (deferred):**

- Multi-assignee per WO. Single-assignee for v1; add `work_order_assignees` join later if needed.
- Auto-revocation of an external worker's access when a WO completes or they're reassigned. Access is manually revoked from an admin page in a follow-up.
- A dedicated "External Workers" admin page (manage list, revoke, deactivate). Implied by the manual-revoke decision but its own spec.
- Multi-property scoping for an external worker via something other than per-WO assignment.
- Push notifications.
- Migration of the old `assigned_contact_id` data — the column stays on the table, unused, and is not displayed.

## 3. Data model

Two columns. No new tables.

```sql
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS work_orders_assigned_user_idx
  ON work_orders(assigned_user_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'team';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_user_type_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_user_type_check
      CHECK (user_type IN ('team','external_worker'));
  END IF;
END $$;
```

Existing rows backfill to `'team'` via the column default. The old `assigned_contact_id` column is left in place but not read or written by any new code path.

## 4. Architecture overview

```
┌────────────────────────────────────────────────────────────┐
│                     shared Postgres                        │
│  work_orders.assigned_user_id  →  users.id                 │
│  users.user_type ∈ {team, external_worker}                 │
│  app_grants (maintenance, fieldcam) for external workers   │
│  property_access scopes external workers to their WO's     │
│   property                                                 │
└────────────────────────────────────────────────────────────┘
                              ▲
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   /maintenance.html      /my-work.html         /fieldcam.html
   (team view of WOs,     (external-worker      (used by both;
    with picker)           scoped portal)        scoped by
                                                 property_access)
```

The team-facing Maintenance app gains an assignee column and picker. A new `/my-work.html` page is the *only* place external workers land. FieldCam stays one app — the access checks it already runs against `property_access` and `app_grants` are what scopes external workers down to a single property.

## 5. Components

### 5.1 Assignee picker (`public/maintenance.html`)

A combobox attached to every work-order row + every WO edit modal. Opens a popup with:

- **Search input** at top.
- **Team** section: all rows where `user_type = 'team'`, alphabetical, avatar + full name + email.
- **External workers** section: all rows where `user_type = 'external_worker'`. Pending invites get a small grey "Pending" pip on the avatar (i.e. `password_hash IS NULL`).
- **+ Invite external worker…** action row at the bottom.

Selecting a user calls `PATCH /api/work-orders/:id` with `{ assigned_user_id }`. Selecting the invite action opens the sub-modal in 5.2.

Card-level display: a small avatar + first name on the right of each WO card, or a grey "Unassigned" chip.

### 5.2 Invite external worker sub-modal (`public/maintenance.html`)

Two fields: **Full name**, **Email**. Below: a non-editable hint — "They'll only see work orders assigned to them."

On save → `POST /api/work-orders/:id/invite-external-worker` with `{ full_name, email }`. The endpoint:

1. Validates email format.
2. If a user already exists with this email AND `user_type = 'team'`, returns `409 { error: 'team_member_exists' }`. The modal shows "This email already belongs to a team member" inline.
3. Otherwise upserts the user with `user_type = 'external_worker'`, generates an invite token, sets `invite_expires = NOW() + 7 days`. Reuses helpers from `routes/auth.js`.
4. Upserts `app_grants` for the maintenance and fieldcam apps (role `'member'`, scope `{"all": true}`).
5. Upserts a `property_access` row for the WO's `property_id`.
6. Sets `work_orders.assigned_user_id` to the new user.
7. Sends the invite email (existing template + a new copy variant: "Jordan assigned you a work order at 123 Main St.").
8. Returns the new user row.

The whole thing runs inside one DB transaction. Email send happens after commit; if it fails, log it and return the invite link in the response so it can be copy-pasted manually (existing pattern in `routes/auth.js`).

### 5.3 Re-assignment behavior

`PATCH /api/work-orders/:id { assigned_user_id }`:

- If the new assignee is an `external_worker`, ensure `property_access(property_id=WO.property_id, user_id=new_assignee.id)` exists (insert if missing).
- Do **not** revoke the previous assignee's access. (Decision: keep access until manually revoked.)
- Send notification (see 5.7).

### 5.4 External-worker portal (`public/my-work.html` — NEW)

Two-column page, edge-to-edge, only chrome is a slim header with the PropSpot logo and a user menu (avatar dropdown with "Sign out").

- **Left column (40%):** list of work orders where `assigned_user_id = me`, sorted by `priority desc, scheduled_for asc, created_at desc`. Each row: title, property address, status pill, priority pill, scheduled date.
- **Right column (60%):** detail of the selected WO.
  - Header: title + property address + status/priority chips.
  - Description (read-only).
  - "Photos" section: thumbnails of all photos on this property (existing FieldCam photos table), newest first. A **+ Upload photos** button opens the existing FieldCam upload widget pre-scoped to this property.
  - "Updates" thread: rendered from `work_order_updates`, with a textarea to post a new update.
  - "Status" picker: external workers can flip status between `open ↔ in_progress ↔ completed`. `scheduled` and `cancelled` are admin-only and grayed out.

Empty state (no assigned WOs): a friendly message ("Nothing assigned to you yet — your team will let you know when there's work.").

### 5.5 Routing guard

- **Server-side:** `middleware/auth.js` gains a `requireTeamUser` middleware. Any GET to an HTML page other than `/my-work.html`, `/accept-invite.html`, `/forgot-password.html`, `/reset-password.html`, or the login page checks: if `req.user.user_type === 'external_worker'`, respond 302 to `/my-work.html`.
- **Client-side:** the existing `app.js` `requireAuth()` helper rejects external workers on team pages (defense-in-depth in case a route is missed server-side).
- **API guard:** API endpoints continue to use their existing `requireAuth` + grant checks. External workers' grants only cover their own assigned WOs, so they naturally can't reach other data.

### 5.6 FieldCam scoping

No new code in FieldCam. It already filters photos by `property_access`. Granting an external worker a single `property_access` row per assignment naturally scopes:

- Property list (FieldCam home): only properties they have access to.
- Photos on a property: all photos visible (decision B — they can see "before" photos).
- Upload: standard upload, attaches to the property.

If an external worker is assigned to multiple WOs on the same property, the `property_access` row is a single row (already deduped via `UNIQUE(property_id, user_id)`).

### 5.7 Notifications

On assignment (initial or reassignment):

- **Email** to the assignee, always. Subject: "Jordan assigned you a work order at <address>". Body: WO title, description, link.
  - For team members: link to `/maintenance.html?wo=<id>`.
  - For external workers: link to `/my-work.html?wo=<id>` (or `/accept-invite.html?token=...` if still pending invite).
- **Pulse mention** only if the assignee is a team member. Posts to the `#maintenance` channel: "Jordan assigned @Bob to <WO title>." Uses the existing chat_mentions machinery, so it lights up in Mentions on Bob's sidebar. (No DM — the channel post is enough and gives the rest of the team visibility.)

Edge cases:
- Assigning yourself → skip both notifications.
- Unassigning (set to null) → skip both notifications. The newly-unassigned user is not pinged.

## 6. API surface

| Verb | Path | Purpose |
|---|---|---|
| `PATCH` | `/api/work-orders/:id` | Existing — gains `assigned_user_id` in the accepted body |
| `POST` | `/api/work-orders/:id/invite-external-worker` | NEW — body `{ full_name, email }`, creates user + grants + sends invite + assigns |
| `GET` | `/api/users?type=team` and `?type=external_worker` | NEW filter on existing endpoint, drives the picker |
| `GET` | `/api/my-work-orders` | NEW — returns WOs where `assigned_user_id = me`, joined with property |
| `GET` | `/api/me` | Existing — gains `user_type` in the response |

## 7. Edge cases and decisions

| # | Question | Decision |
|---|---|---|
| A | Does access revoke when a WO completes? | **No.** Keep access until manually revoked from a future admin page. |
| B | Can external workers see existing photos on the property? | **Yes.** Full read on FieldCam for their granted properties. |
| C | Can you invite an existing *team* email as an external worker? | **No.** API returns 409, picker shows inline error. |
| D | Multi-assignee? | **No** for v1. Single column. |
| E | Notifications? | Email always, Pulse mention only for team assignees. |
| F | Mobile? | The portal's two-column collapses to single-column with back arrow. Same responsive pattern as `inbox.html`. |

**Resolved decisions for the implementation plan:**

- Pulse mention posts to `#maintenance` channel only (no DM).
- External-worker portal shows only WO-scoped data plus the photo grid for the property. No property notes, no acquisitions data, no holdings detail. Minimal by design.
- Email template body uses the existing invite-email layout with a new copy variant for "you've been assigned a work order".

## 8. Testing notes

- DB migration tests: column add is idempotent; constraint add wrapped in `DO $$ ... IF NOT EXISTS`. Existing users backfill to `'team'`.
- API tests: assigning a non-existent user → 404; assigning an external_worker → `property_access` row exists after; invite endpoint with a team-member email → 409.
- Manual smoke tests:
  1. Team-side: assign WO to teammate; teammate receives email + Pulse mention; "Assigned to me" pill filters.
  2. Invite external worker on a new WO; they receive email; they accept; they land on `/my-work.html`; they see the WO + property photos; they upload a photo.
  3. External worker types `/dashboard.html` in URL bar → redirected to `/my-work.html`.
  4. Reassign WO from worker A to worker B; A keeps access (still in their list), B gains access.

## 9. Out-of-scope cleanup ideas (do NOT do in this spec)

- Build the "External Workers" admin page (list, revoke, deactivate).
- Auto-revoke logic.
- Migrate any historical data sitting in `assigned_contact_id`.
- Multi-assignee.
