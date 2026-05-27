# Timesheets — PropSpot app

**Date:** 2026-05-26
**Owner:** Jordan
**Slug:** `timesheets`
**Lives in:** `propspot-os` (single Railway service, per the one-service model)

## Goal

A timesheet app inside PropSpot for virtual assistants, hourly W2 employees (Jonathan, Jen), and hourly contractors (Ethan). Workers clock in and out in real time, tag their time against PropSpot entities, and an admin approves each pay period. Approved hours for W2 employees push automatically to Gusto for payroll. Non-Gusto workers (VAs, contractors) just show as approved with totals — payment handled outside the app.

## Users and roles

App grants on the existing `app_grants` table. The `app_grants.role` column has no CHECK constraint, so adding new role string values requires no schema change — they're just strings the route middleware interprets.

| Role | Sees | Can do |
|---|---|---|
| `member` | Only their own entries | Clock in/out, tag entries, edit unapproved entries, view own pay period totals |
| `approver` | Everyone's entries | Member actions + approve any worker's pay period, see anomaly flags, push to Gusto, unlock approved entries with a reason |
| `admin` | Everyone's entries | Approver actions + connect/disconnect Gusto, manage category dropdown, manage approver list |

All workers (VAs, W2, contractors) are already PropSpot users (`users.user_type = 'team'`). No invite flow needed. Onboarding = admin grants the Timesheets app.

## Scope

**In scope:**
- Live clock in / clock out with running timer
- Optional tagging per entry: project, property, work order, free-text category
- Admin approval per worker per pay period
- Gusto OAuth + push approved hours + pull employee list + auto-detect pay schedule
- Anomaly flags surfaced to approvers (no auto-rejection)
- Audit log of every edit
- CSV export of approved hours (fallback if Gusto push fails)
- Past pay period history with Gusto sync status

**Out of scope (deferred, can add later):**
- Pay rate sync from Gusto (no per-project labor cost calc yet)
- Contractor payments through Gusto (hours-only for non-W2)
- PDF/invoice generation for contractors
- Per-worker pay schedules (org has one biweekly schedule; data model allows it but UI doesn't surface)
- GPS/screenshot proof-of-work
- Break/lunch tracking (workers clock out for lunch, clock back in)
- Mobile app (web app must be mobile-responsive; no native app)

## Worker experience (`/timesheets.html` — member view)

**Top of screen — Clock In/Out card:**
- Tag selectors above the button: **Project**, **Property**, **Work Order**, **Category** (dropdown of admin-managed options like "Acquisitions", "Underwriting", "Bookkeeping", "Inbox triage", "General admin"). All optional.
- Big button — green **"Clock In"** when idle, red **"Clock Out"** when active, with live running timer (`HH:MM:SS`) updated client-side via `setInterval` against the entry's `started_at`.
- **"Switch task"** button shown while clocked in — clocks out the current entry and starts a new one with new tags in a single action.

**Below the button:**
- **Today's entries** list — start/end times, duration, tags, notes. Edit pencil per row (only for unapproved entries).
- **Pay period running total** — e.g., "Pay period May 18–31: 38.5 hrs so far / payday Fri Jun 5"
- **Add manual entry** button — for offline work, missed clock-ins, fixing auto-closed entries. Tagged `source: 'manual'` in the data.

**Past pay periods tab:** read-only history of the worker's own approved periods.

## Admin experience (`/timesheets.html` — approver/admin tabs)

**Live now strip (top):** horizontal list of currently-clocked-in workers with name, current tag, elapsed time. Auto-refresh every 30s.

**Current pay period card:** one row per worker.

| Column | Source |
|---|---|
| Worker | `users.full_name` + Gusto-linked badge if `gusto_employee_links` row exists |
| Hours so far | Sum of `timesheet_entries.duration_minutes` for this user × pay period |
| Anomalies | Count of flagged entries (see Anomaly flags below) |
| Status | `in_progress` / `submitted` / `approved` / `pushed` / `paid` |
| Action | "Approve" / "Send back" / "Unlock" depending on status |

Click a row → drill into all that worker's entries for the period: timestamps, tags, notes, edit history (from `timesheet_audit_log`), anomaly badges. From here: approve, send back with comment, or edit individual entries (admin only, logged).

**Push to Gusto button:** appears on the pay period card once all Gusto-linked workers are approved. Pushes only the linked workers; non-linked workers stay in `approved` status with no push.

**Past pay periods tab:** every closed period, Gusto sync status, CSV download.

**Settings tab (admin only):**
- Connect / disconnect Gusto (OAuth flow)
- Manage approvers (grant `role: 'approver'` to PropSpot users)
- Manage category dropdown options (add/edit/remove)
- Gusto employee mapping (one-time review after connecting; auto-matches by email)

## Anomaly flags

Surfaced as badges on the entry and a count on the pay period row. No auto-rejection — they're prompts for the approver to look closely.

- `long_shift` — single entry > 12 hours
- `edited_after_close` — entry edited after its original `ended_at`
- `no_tags` — entry has no project, property, work order, or category
- `weekend_off_pattern` — entry on Sat/Sun for a worker whose last 30 days are all weekday
- `auto_closed` — entry was auto-closed at the 14-hour cap
- `manual_entry` — entry's `source = 'manual'`
- `overlap_attempted` — rare; logged when worker tried to clock in while another entry was open

## Gusto integration

**Auth:** OAuth 2.0 via Gusto Partner API. Access + refresh tokens stored encrypted in `timesheet_settings` using the existing `inbox-crypto` library.

**On connect:**
1. Admin clicks "Connect Gusto" → redirected to Gusto OAuth → returns with code → exchanged for tokens.
2. App fetches `GET /v1/companies` → stores `company_uuid` in `timesheet_settings`.
3. App fetches `GET /v1/companies/{uuid}/pay_schedules` → stores frequency + anchor dates → generates `timesheet_pay_periods` rows for the current and next period (rolling forward via daily background job).
4. App fetches `GET /v1/companies/{uuid}/employees` → presents mapping screen → admin confirms email-based auto-matches → `gusto_employee_links` rows written.

**On approve + push:**
- For each Gusto-linked worker in the approved period, call `POST /v1/companies/{uuid}/time_tracking/time_sheets` with hours split into `regular` (first 40 hrs/week) and `overtime` (>40 hrs/week per calendar week).
- Store returned `time_sheet_uuid` on entries; flip pay period status `approved` → `pushed`.
- Daily sync job calls `GET /v1/companies/{uuid}/time_tracking/time_sheets/{uuid}` until Gusto reports payroll run → flip to `paid`.

**Token refresh:** background. On 401 from Gusto, attempt refresh; on refresh failure, set `timesheet_settings.gusto_disconnected_at` and surface banner.

**Failure handling:** push failure preserves `approved` status; admin sees error + retry button + CSV fallback. No silent drops.

## Data model

All tables append to the existing `db/schema.sql`. No migrations framework — uses the project's existing `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` idempotent pattern.

### `timesheet_entries`

The workhorse table. One row per clock-in / clock-out session (or manual entry).

```sql
CREATE TABLE IF NOT EXISTS timesheet_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pay_period_id     UUID REFERENCES timesheet_pay_periods(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,                    -- NULL = currently clocked in
  duration_minutes  INTEGER,                        -- computed when ended_at set
  project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
  property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
  work_order_id     UUID REFERENCES work_orders(id) ON DELETE SET NULL,
  category          TEXT,                           -- free-form, validated against settings list
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','submitted','approved','pushed','paid')),
  source            TEXT NOT NULL DEFAULT 'clock'
                    CHECK (source IN ('clock','manual')),
  auto_closed       BOOLEAN NOT NULL DEFAULT FALSE,
  gusto_time_sheet_uuid TEXT,                       -- set after push
  approved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,                    -- soft delete; row kept for audit
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS timesheet_entries_user_idx        ON timesheet_entries(user_id);
CREATE INDEX IF NOT EXISTS timesheet_entries_pay_period_idx  ON timesheet_entries(pay_period_id);
CREATE INDEX IF NOT EXISTS timesheet_entries_open_idx        ON timesheet_entries(user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS timesheet_entries_started_idx     ON timesheet_entries(started_at DESC);
```

Constraint enforced in application code (not SQL): a user cannot have two entries where `ended_at IS NULL` simultaneously. Checked on clock-in.

### `timesheet_pay_periods`

```sql
CREATE TABLE IF NOT EXISTS timesheet_pay_periods (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_on       DATE NOT NULL,                    -- inclusive
  ends_on         DATE NOT NULL,                    -- inclusive
  payday          DATE NOT NULL,
  gusto_pay_schedule_uuid TEXT,                     -- which Gusto schedule this came from
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed','pushed','paid')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS timesheet_pay_periods_dates_uniq
  ON timesheet_pay_periods(starts_on, ends_on);
```

Per-worker approval status lives on `timesheet_entries.status`, not here. The pay period status reflects the period as a whole (`open` while in progress, `closed` after end date, `pushed` once Gusto push succeeded for any worker, `paid` once Gusto confirms payroll ran).

### `timesheet_settings`

Single-row org-level config table.

```sql
CREATE TABLE IF NOT EXISTS timesheet_settings (
  id                            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  gusto_company_uuid            TEXT,
  gusto_access_encrypted        TEXT,                 -- inbox-crypto encrypted
  gusto_refresh_encrypted       TEXT,
  gusto_token_expires_at        TIMESTAMPTZ,
  gusto_connected_at            TIMESTAMPTZ,
  gusto_disconnected_at         TIMESTAMPTZ,          -- set on refresh failure
  category_options              JSONB NOT NULL DEFAULT '["Acquisitions","Underwriting","Bookkeeping","Inbox triage","General admin"]'::jsonb,
  weekly_overtime_threshold_min INTEGER NOT NULL DEFAULT 2400,  -- 40 hrs = 2400 min
  auto_close_after_hours        INTEGER NOT NULL DEFAULT 14,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO timesheet_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
```

### `gusto_employee_links`

```sql
CREATE TABLE IF NOT EXISTS gusto_employee_links (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gusto_employee_uuid  TEXT NOT NULL,
  gusto_email          TEXT,                            -- captured at link time for display
  linked_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by            UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS gusto_employee_links_uniq
  ON gusto_employee_links(gusto_employee_uuid);
```

A PropSpot user without a row here is a non-Gusto worker (VAs, contractors). The approval flow still works; the Gusto push step skips them.

### `timesheet_audit_log`

```sql
CREATE TABLE IF NOT EXISTS timesheet_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     UUID NOT NULL REFERENCES timesheet_entries(id) ON DELETE CASCADE,
  changed_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  field        TEXT NOT NULL,                        -- e.g., 'started_at','ended_at','project_id','status'
  old_value    TEXT,
  new_value    TEXT,
  reason       TEXT,                                 -- required for admin unlock; optional otherwise
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS timesheet_audit_log_entry_idx ON timesheet_audit_log(entry_id, changed_at DESC);
```

Every write to `timesheet_entries` (except the initial insert and `duration_minutes` recompute) writes a corresponding row here. Wrapped in a DB transaction with the entry update.

### Apps registry row

One seed `INSERT` into `apps`:

```sql
INSERT INTO apps (slug, name, description, icon, enabled)
VALUES ('timesheets', 'Timesheets', 'Clock in / clock out, approve hours, push to Gusto', 'clock', TRUE)
ON CONFLICT (slug) DO NOTHING;
```

## API surface

All under `/api/timesheets/*`. Bearer-token auth via existing `middleware/auth.js`. Authorization via `app_grants.role` for the `timesheets` app — values `'member'`, `'approver'`, `'admin'` are interpreted by route middleware.

### Worker endpoints (member role)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/timesheets/clock-in` | Body: `{ project_id?, property_id?, work_order_id?, category?, notes? }`. Creates entry with `started_at = NOW()`, `ended_at = NULL`. Rejects if user already has open entry. |
| `POST` | `/api/timesheets/clock-out` | Body: `{}`. Closes the user's open entry, sets `ended_at = NOW()`, computes `duration_minutes`. |
| `POST` | `/api/timesheets/switch` | Body: same as clock-in. Atomically clocks out current and starts new entry. |
| `GET` | `/api/timesheets/me/current` | Returns the user's currently open entry, or `null`. |
| `GET` | `/api/timesheets/me/entries?pay_period_id=...` | List user's own entries for a pay period (defaults to current). |
| `PATCH` | `/api/timesheets/entries/:id` | Edit own unapproved entry. Body: any of the entry fields. Writes audit log rows. |
| `POST` | `/api/timesheets/entries` | Create manual entry. Body includes `started_at`, `ended_at`, tags. `source: 'manual'`. |
| `DELETE` | `/api/timesheets/entries/:id` | Soft-delete own unapproved entry — sets `deleted_at`; row stays for audit. Excluded from list/summary queries. |

### Approver/admin endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/timesheets/live` | Currently-clocked-in workers across the org. |
| `GET` | `/api/timesheets/pay-periods` | List of pay periods with rolled-up status counts per worker. |
| `GET` | `/api/timesheets/pay-periods/:id` | Full detail of a pay period: every worker, their entries, anomalies, status. |
| `GET` | `/api/timesheets/users/:userId/entries?pay_period_id=...` | Drill-in to a worker's entries. |
| `POST` | `/api/timesheets/pay-periods/:id/workers/:userId/approve` | Approve all of a worker's entries in this period. |
| `POST` | `/api/timesheets/pay-periods/:id/workers/:userId/send-back` | Body: `{ reason }`. Unlocks worker's entries and posts a Pulse mention to the worker with the reason. |
| `POST` | `/api/timesheets/entries/:id/unlock` | Admin-only. Body: `{ reason }`. Reverts a single approved entry. |
| `POST` | `/api/timesheets/pay-periods/:id/push-to-gusto` | Pushes all approved Gusto-linked workers in this period. |
| `GET` | `/api/timesheets/pay-periods/:id/csv` | CSV download. |

### Settings endpoints (admin role)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/timesheets/settings` | Read settings (Gusto connection status, category options, etc). |
| `PATCH` | `/api/timesheets/settings` | Update categories, approver list, overtime threshold. |
| `GET` | `/api/timesheets/gusto/connect` | Initiates OAuth — returns redirect URL. |
| `GET` | `/api/timesheets/gusto/callback` | OAuth return; exchanges code, stores tokens. |
| `POST` | `/api/timesheets/gusto/disconnect` | Clears tokens. |
| `GET` | `/api/timesheets/gusto/employees` | List Gusto employees + auto-match suggestions. |
| `PUT` | `/api/timesheets/gusto/links` | Body: `[{ user_id, gusto_employee_uuid }, ...]`. Writes `gusto_employee_links`. |

## Background workers

One new file: `workers/timesheets.js`. Mounted on server startup the same way `workers/inbox-sync.js` is.

| Job | Cadence | What it does |
|---|---|---|
| `auto-close-stale` | every 10 min | `UPDATE timesheet_entries SET ended_at = started_at + INTERVAL '14 hours', auto_closed = TRUE WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL '14 hours';` then writes audit rows. |
| `ensure-next-pay-period` | daily at 06:00 UTC | Reads Gusto pay schedule, ensures `timesheet_pay_periods` row exists for current + next period. |
| `assign-pay-period` | every hour | Backfills `pay_period_id` on entries where the entry's `started_at::date` (UTC) falls within a known period's `starts_on`–`ends_on` range. |
| `gusto-token-refresh` | every 30 min | Refreshes any Gusto access token within 1 hour of expiry. |
| `gusto-payroll-poll` | every 4 hours | For pay periods in `pushed` state, polls Gusto until payroll runs → flip to `paid`. |

## Frontend (`public/timesheets.html`)

Single HTML page, same vanilla-JS pattern as `pulse.html`, `inbox.html`, `maintenance.html`. Loaded inside the existing app frame.

**Tabs** (rendered/hidden by role):
- **My time** (everyone) — clock in/out card, today's entries, pay period totals, history
- **Approvals** (approver/admin) — live now strip, current pay period card, drill-ins
- **History** (approver/admin) — past pay periods
- **Settings** (admin only) — Gusto, approvers, categories

Live timer is client-side `setInterval` based on the open entry's `started_at`. No WebSocket needed for the worker view; the "Live now" admin strip auto-refreshes every 30s via polling (matches existing patterns elsewhere in PropSpot).

## Edge cases (covered in design)

| Case | Behavior |
|---|---|
| Forgot to clock out | `auto-close-stale` job caps at 14 hrs, flags `auto_closed`, worker can edit actual `ended_at` |
| Already clocked in, hits Clock In again | Button never shows "Clock In" while open; "Switch task" available instead |
| Edits after the fact | Allowed until status = `approved`; all logged in audit |
| Manual entry for a past day | Allowed; tagged `source: 'manual'`; surfaces as anomaly |
| Overlapping entries | Rejected at API level; only one open entry per user |
| Timezone | All timestamps stored UTC; displayed in the worker's browser local timezone via JS `Date`. Pay period boundaries are calendar dates (UTC) from Gusto; no per-user timezone column added in V1. |
| Daylight savings | Non-issue with UTC storage |
| Gusto disconnected | Approval works; push surfaces "Reconnect Gusto" banner; CSV always available |
| Overtime | Hours over 40/calendar week sent to Gusto as `overtime`, rest as `regular`. Gusto applies multiplier. |
| Worker leaves company | Entries persist; app grant revoked; historical pay periods still show them |
| Push fails | Status stays `approved`; error banner with retry; CSV available |
| Worker on multiple pay schedules | Not in scope for UI; data model supports it via `gusto_pay_schedule_uuid` on pay period |

## Testing

- **Unit:** duration calc, weekly OT split, anomaly detection logic, audit log writer
- **Integration (with test DB):** clock-in → clock-out → edit → approve → push flow; rejection of overlapping clock-ins; auto-close job
- **Mocked Gusto:** OAuth callback, employee fetch, time sheet POST, token refresh, error responses
- **Manual:** real Gusto sandbox connection + push before first production payroll
- **Smoke after deploy:** clock in as test VA user, verify entry appears in admin view within 5s

## Non-goals (explicit)

- Not building a per-project labor cost report yet (no pay rate sync; can add later by enabling rate sync from Gusto)
- Not building contractor payment flows inside the app (hours summary is enough; payment happens via Wise/etc outside)
- Not building break/lunch tracking (workers clock out for lunch, clock back in)
- Not building a native mobile app (responsive web only)
- Not building GPS or screenshot proof-of-work
- Not building scheduling (when workers are supposed to work) — only what they actually worked
