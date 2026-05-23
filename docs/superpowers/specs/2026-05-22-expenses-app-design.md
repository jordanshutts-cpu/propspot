# Expenses app

**Date:** 2026-05-22
**Status:** Draft, pending Jordan review

## 1. Goal

Stand up a new PropSpot satellite app, **Expenses**, at `expenses.propspot.io`, that serves as the bookkeeper-facing transactional ledger of every bill Restoration Homes pays. Each expense is tied to a property and a vendor, can have an invoice file attached, and flows through a simple AP approval state machine (received → approved → paid). Vendors are a new first-class entity. Historical expenses currently stored in Salesforce are backfilled via a CSV import wizard. QuickBooks sync is stubbed in the schema but deferred to a phase-2 spec.

The app must be usable for live expense entry on day one and must support a same-day import of historical Salesforce data.

## 2. Scope

**In scope:**

- New satellite app at `propspot/expenses/`, deployed as its own Railway service at `expenses.propspot.io`, mirroring the structure of `holdings/`.
- Four new tables in the shared schema: `vendors`, `expenses`, `expense_documents`, `expense_categories`.
- Seeded category list (utility, insurance, property_tax, mortgage, hoa, business_license, repairs, maintenance, materials, contractor_labor, supplies, professional_fees, legal, travel, marketing, other), admin-editable.
- Full CRUD UI: list view with filters and totals, quick-add form, expense detail page, vendor list + edit, category admin page.
- Invoice file uploads to Cloudinary (PDF, image, doc, xls, txt), one or more files per expense.
- AP approval workflow: state machine with `received` / `approved` / `paid` / `rejected` / `void`; owner-only approval; back-entry-with-paid_on bypass.
- Salesforce CSV import wizard: upload → field-mapping → preview → commit. Re-runnable via `(source, source_external_id)` idempotency.
- Sidebar badge showing the count of expenses awaiting the viewing owner's approval, surfaced through the existing apps-tile sidebar mechanism.
- Activity-log entries for all state transitions, written to the shared `activity` table.
- New row in `apps` seed: `('expenses','Expenses','Bills, invoices, and property-level expense tracking','💵','https://expenses.propspot.io',TRUE)`. Owner auto-grants pick this up via the existing boot logic in `propspot-os/db/seed.sql`.
- **QuickBooks sync columns added to schema now** (`vendors.qb_vendor_id`, `expenses.qb_transaction_id`, sync status + timestamps on both) so phase 2 doesn't need a schema migration.

**Out of scope (deferred):**

- Phase 2 — QuickBooks sync: Intuit OAuth, vendor and bill creation in QB, bidirectional reconciliation, bookkeeper diff page.
- Phase 2 — Holdings ↔ Expenses integration: clicking "Mark Paid" on a holdings item also creates an expense row; eventual deprecation of `holdings_payments`.
- Phase 2 — Approver delegation: per-user `can_approve_expenses` flag so the bookkeeper can approve smaller bills. v1 is owner-only.
- Phase 2 — Vendor-level auto-approve. (Explicitly rejected for v1 per Jordan.)
- Phase 2 — Approval thresholds (e.g. bills over $5k need extra sign-off). (Explicitly rejected for v1.)
- Phase 2 — Email/SMS notifications on approval requests. v1 has in-app sidebar badge only.
- Phase 2 — Recurring-expense templates ("create the rent expense the 1st of every month"). Holdings already handles this for recurring obligations; this would be the non-holdings recurring case (e.g. monthly subscriptions).
- Phase 2 — Category splits (one bill across two categories). Single category per expense in v1.
- Property-detail "Expenses" tab inside `propspot-os` — included in v1 if it lands cheaply, otherwise punted to a phase-1.5 follow-up. The standalone app is the day-one shipping target.

## 3. Architecture overview

```
                  ┌─────────────────────────────────────────┐
                  │              shared Postgres            │
                  │  (existing tables + vendors, expenses,  │
                  │   expense_documents, expense_categories)│
                  └─────────────────────────────────────────┘
                                     ▲
                                     │ DATABASE_URL
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
        ┌───────┴───────┐    ┌───────┴───────┐    ┌───────┴───────┐
        │ propspot-os   │    │  expenses     │    │   holdings    │
        │ os.propspot.io│    │  (new)        │    │ holdings.…    │
        │               │    │ expenses.…    │    │               │
        │ • owns schema │    │ • CRUD        │    │ • untouched   │
        │ • mints JWT   │    │ • approval    │    │   in v1       │
        │ • /api/os/me  │    │ • SF import   │    │               │
        └───────────────┘    └───────────────┘    └───────────────┘
                                     ▲
                                     │ Cloudinary
                                     │ (invoice files,
                                     │  folder='expenses')
                                     ▼
                              ┌──────────────┐
                              │  Cloudinary  │
                              └──────────────┘
```

Same patterns as every other PropSpot satellite: shared `JWT_SECRET`, shared `DATABASE_URL`, `requireAuth` middleware verifies the OS JWT, vanilla HTML/JS frontend, Cloudinary for file storage. No new infrastructure.

## 4. Data model

All new objects go into `propspot-os/db/schema.sql` (idempotent `IF NOT EXISTS`), since propspot-os is the canonical owner of the shared schema.

### 4.1 `vendors`

Business entities Restoration Homes pays. Distinct from `contacts` (which is people). Maps 1:1 to a QuickBooks Vendor in phase 2.

```sql
CREATE TABLE IF NOT EXISTS vendors (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  display_name           TEXT,
  email                  TEXT,
  phone                  TEXT,
  website                TEXT,
  address_line1          TEXT,
  address_line2          TEXT,
  city                   TEXT,
  state                  TEXT,
  postal_code            TEXT,
  default_category       TEXT,            -- pre-fills expense.category when this vendor is picked
  default_payment_method TEXT,            -- ach | check | card | autopay | other
  account_number         TEXT,            -- our account number with them
  tax_id                 TEXT,            -- EIN/SSN if 1099-eligible
  is_1099                BOOLEAN NOT NULL DEFAULT FALSE,
  notes                  TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',  -- active | archived
  -- QuickBooks (phase 2; columns exist now to avoid a later migration)
  qb_vendor_id           TEXT,
  qb_synced_at           TIMESTAMPTZ,
  qb_sync_status         TEXT,                            -- pending | synced | error | NULL
  qb_sync_error          TEXT,
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vendors_name_idx   ON vendors(LOWER(name));
CREATE INDEX IF NOT EXISTS vendors_status_idx ON vendors(status);
CREATE INDEX IF NOT EXISTS vendors_qb_id_idx  ON vendors(qb_vendor_id);
```

No `auto_approve` column — Jordan explicitly rejected vendor-level auto-approve.

### 4.2 `expenses`

One row per bill. The transactional ledger.

```sql
CREATE TABLE IF NOT EXISTS expenses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  vendor_id           UUID NOT NULL REFERENCES vendors(id)    ON DELETE RESTRICT,
  category            TEXT NOT NULL,            -- references expense_categories.slug (soft FK)
  amount              NUMERIC(12,2) NOT NULL,
  bill_date           DATE,                     -- when bill was issued / received
  paid_on             DATE,                     -- when WE paid it; NULL = not yet paid
  payment_method      TEXT,                     -- ach | check | card | cash | autopay | other
  reference           TEXT,                     -- check#, confirmation#, last 4, etc.
  memo                TEXT,                     -- short ("June water bill", "Roof patch")
  notes               TEXT,                     -- longer free-form
  -- AP approval state
  status              TEXT NOT NULL DEFAULT 'received',  -- received | approved | paid | rejected | void
  approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  rejected_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at         TIMESTAMPTZ,
  rejected_reason     TEXT,
  voided_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  voided_at           TIMESTAMPTZ,
  voided_reason       TEXT,
  requires_approval   BOOLEAN NOT NULL DEFAULT TRUE,      -- imports set this FALSE
  -- Forward-link to holdings (unused UI in v1; populated when phase 2 reconciles)
  holdings_item_id    UUID REFERENCES holdings_items(id) ON DELETE SET NULL,
  -- Source tracking
  source              TEXT NOT NULL DEFAULT 'manual',     -- manual | salesforce_import | holdings_sync | quickbooks_sync
  source_external_id  TEXT,                               -- original SF Id, QB txn id, etc.
  -- QuickBooks (phase 2)
  qb_transaction_id   TEXT,
  qb_synced_at        TIMESTAMPTZ,
  qb_sync_status      TEXT,
  qb_sync_error       TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT expenses_status_check
    CHECK (status IN ('received','approved','paid','rejected','void')),
  CONSTRAINT expenses_paid_requires_paid_on
    CHECK (status <> 'paid' OR paid_on IS NOT NULL),
  CONSTRAINT expenses_source_dedup_unique
    UNIQUE (source, source_external_id)
);
CREATE INDEX IF NOT EXISTS expenses_property_idx  ON expenses(property_id);
CREATE INDEX IF NOT EXISTS expenses_vendor_idx    ON expenses(vendor_id);
CREATE INDEX IF NOT EXISTS expenses_status_idx    ON expenses(status);
CREATE INDEX IF NOT EXISTS expenses_paid_idx      ON expenses(paid_on DESC);
CREATE INDEX IF NOT EXISTS expenses_bill_idx      ON expenses(bill_date DESC);
CREATE INDEX IF NOT EXISTS expenses_category_idx  ON expenses(category);
CREATE INDEX IF NOT EXISTS expenses_qb_id_idx     ON expenses(qb_transaction_id);
```

Design notes:

- `property_id` and `vendor_id` are `ON DELETE RESTRICT` — you can't orphan an expense by deleting a property/vendor. Archive first.
- `expenses_paid_requires_paid_on` CHECK constraint enforces "you can't mark an expense paid without a paid_on date."
- `expenses_source_dedup_unique` makes Salesforce re-imports safe: a second import of the same SF row hits the unique constraint and is treated as a skip. Postgres' default `UNIQUE NULLS DISTINCT` behavior means `(manual, NULL)` rows don't conflict with each other, which is exactly what we want — only imports (always non-null external ID) participate in dedup.
- `holdings_item_id` is a forward-link only; the v1 UI does not surface it. Phase 2 populates it when "Mark Paid" on a holdings item creates an expense.

### 4.3 `expense_documents`

Same Cloudinary pattern as `holdings_documents`.

```sql
CREATE TABLE IF NOT EXISTS expense_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id    UUID NOT NULL REFERENCES expenses(id)   ON DELETE CASCADE,
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label         TEXT,
  doc_type      TEXT,                  -- invoice | receipt | statement | other
  url           TEXT NOT NULL,
  cloudinary_id TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS expense_documents_expense_idx  ON expense_documents(expense_id);
CREATE INDEX IF NOT EXISTS expense_documents_property_idx ON expense_documents(property_id);
```

`property_id` denormalized on the document row for fast "all docs for this property" queries, same denorm pattern as `holdings_documents.property_id`.

### 4.4 `expense_categories`

Admin-editable lookup. Soft FK from `expenses.category` (text) to `expense_categories.slug`.

```sql
CREATE TABLE IF NOT EXISTS expense_categories (
  slug         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 100,
  qb_account   TEXT,                   -- QuickBooks chart-of-accounts mapping (phase 2)
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

Seeded via `propspot-os/db/seed.sql`:

```sql
INSERT INTO expense_categories (slug, label, sort_order) VALUES
  ('utility',           'Utility',             10),
  ('insurance',         'Insurance',           20),
  ('property_tax',      'Property Tax',        30),
  ('mortgage',          'Mortgage',            40),
  ('hoa',               'HOA Dues',            50),
  ('business_license',  'Business License',    60),
  ('repairs',           'Repairs',            100),
  ('maintenance',       'Maintenance',        110),
  ('materials',         'Materials',          120),
  ('contractor_labor',  'Contractor Labor',   130),
  ('supplies',          'Supplies',           140),
  ('professional_fees', 'Professional Fees',  200),
  ('legal',             'Legal',              210),
  ('travel',            'Travel',             300),
  ('marketing',         'Marketing',          310),
  ('other',             'Other',              999)
ON CONFLICT (slug) DO NOTHING;
```

## 5. App structure

`propspot/expenses/` mirrors `propspot/holdings/`:

```
propspot/expenses/
├── package.json
├── railway.toml
├── .env.example
├── server.js                # Express, CORS, Cloudinary config, /api/me OS proxy, static public/
├── db/
│   └── index.js             # shared pg pool (copy of holdings/db/index.js)
├── middleware/
│   └── auth.js              # JWT verify → req.userId (copy of holdings/middleware/auth.js)
├── lib/
│   ├── activity.js          # writes to shared `activity` table
│   ├── csv.js               # minimal CSV parser for the importer (no big dependencies)
│   └── approval.js          # state-machine helpers (canTransition, applyTransition)
├── routes/
│   ├── expenses.js          # CRUD + /summary + /pending-approval-count + state transitions
│   ├── vendors.js           # CRUD + /search?q=
│   ├── categories.js        # GET list + admin PATCH (owners only)
│   ├── documents.js         # multipart upload → Cloudinary → expense_documents
│   ├── import.js            # POST /preview, POST /commit
│   └── lookups.js           # /properties (for picker), echoes through to propspot-os
└── public/
    ├── index.html           # main list view with filters + totals
    ├── new.html             # quick-add (also embedded as a modal on index)
    ├── item.html            # expense detail
    ├── vendors.html         # vendor list / edit
    ├── categories.html      # category admin (owners only)
    ├── import.html          # Salesforce CSV import wizard
    ├── app.js               # auth + apiFetch (copy of holdings/public/app.js)
    ├── style.css
    └── config.js            # PUBLIC_CONFIG fetched from /api/config
```

`server.js` env: `DATABASE_URL`, `JWT_SECRET`, `OS_URL`, `OS_INTERNAL_URL`, `CLOUDINARY_*`, `APP_URL` (this app's own URL for CORS). Same as holdings/server.js.

## 6. API surface

All routes under `/api/`, gated by `requireAuth` middleware.

### 6.1 Expenses

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/expenses` | Filters: `property_id`, `vendor_id`, `category`, `status` (csv ok), `paid_on_from`, `paid_on_to`, `bill_date_from`, `bill_date_to`. Pagination: `limit` (max 200, default 100), `cursor` (encoded `created_at,id`). |
| `GET`    | `/api/expenses/summary` | Returns `{ this_month, ytd, count_by_status }`. Filters: same as list. |
| `GET`    | `/api/expenses/pending-approval-count` | Returns `{ count }`. Drives sidebar badge. Owner-only; non-owners get `{count: 0}`. |
| `GET`    | `/api/expenses/:id` | Returns expense + joined vendor, property, documents, and activity tail (last 10). |
| `POST`   | `/api/expenses` | Body: full expense fields. Server applies the "back-entry bypass" if `paid_on` is set on create. |
| `PATCH`  | `/api/expenses/:id` | Only allowed when status ∈ {received, approved}. After `paid` it's locked except for `memo`/`notes` and via void/reopen. |
| `DELETE` | `/api/expenses/:id` | Hard delete only if status='received'. Otherwise must void first. |
| `POST`   | `/api/expenses/:id/approve` | Owner-only. Transitions received → approved. |
| `POST`   | `/api/expenses/:id/reject`  | Owner-only. Body: `{ reason }`. received → rejected. |
| `POST`   | `/api/expenses/:id/mark-paid` | Body: `{ paid_on, payment_method, reference }`. approved → paid only. Transactional. |
| `POST`   | `/api/expenses/:id/void` | Owner-only. Body: `{ reason }`. approved/paid → void. |
| `POST`   | `/api/expenses/:id/reopen` | Owner-only. rejected/void → received. |

State-machine enforcement lives in `lib/approval.js → applyTransition(currentStatus, action, isOwner)`. Each route handler calls into it before writing.

### 6.2 Vendors

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/vendors` | Filters: `status`, `q` (name search). |
| `GET`    | `/api/vendors/:id` | Vendor + counts (`expense_count`, `lifetime_total`, `last_paid_on`). |
| `POST`   | `/api/vendors` | Create. |
| `PATCH`  | `/api/vendors/:id` | Update. |
| `POST`   | `/api/vendors/:id/archive` | status='archived'. Doesn't touch existing expenses. |
| `POST`   | `/api/vendors/:id/unarchive` | status='active'. |

No DELETE — archive only. Hard delete would break referential history; this matches QuickBooks behavior anyway (QB vendors archive, never delete).

### 6.3 Categories

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/categories` | Public. Ordered by sort_order. |
| `PATCH`  | `/api/categories/:slug` | Owner-only. Updates label, sort_order, enabled, qb_account. |
| `POST`   | `/api/categories` | Owner-only. Adds a new category. |

### 6.4 Documents

| Method | Path | Notes |
|---|---|---|
| `POST`   | `/api/expenses/:expenseId/documents` | multipart, field `file`. Uploads to Cloudinary `folder=expenses`. |
| `GET`    | `/api/documents?expense_id=…&property_id=…` | List. |
| `PATCH`  | `/api/documents/:id` | Update label, doc_type, notes. |
| `DELETE` | `/api/documents/:id` | Removes Cloudinary asset + row. |

Multer config copied from holdings: 20 MB cap, mime allowlist (pdf, image/*, doc, docx, xls, xlsx, txt).

### 6.5 Import

| Method | Path | Notes |
|---|---|---|
| `POST`   | `/api/import/preview` | multipart, field `file`. Returns `{ columns, sample_rows: [...], total_rows }`. |
| `POST`   | `/api/import/commit` | multipart, field `file`. Body fields: `mapping` (JSON), `default_status` (default 'paid'), `vendor_match_strategy` ('exact' \| 'create_missing'), `property_match_strategy` ('exact_address' \| 'exact_display_name' \| 'fail'). Returns `{ imported, skipped, errors }`. |

Import runs in one DB transaction. Vendor and category-not-found errors per-row don't abort the batch — they go into the `errors` array and the row is skipped. Each imported row gets `source='salesforce_import'`, `source_external_id=<row's SF Id column>`, `requires_approval=FALSE`, `status='paid'` (default).

## 7. UI flows

### 7.1 List view (`index.html`)

Sortable table:

```
[ Status ] [ Date Paid ▼ ] [ Vendor ] [ Property ] [ Category ] [ Amount ] [ Method ] [ Ref ] [ 📎 ] [ ⋮ ]
```

Filter chips above the table: `Property ⌄  Vendor ⌄  Category ⌄  Status ⌄  Date range ⌄  Pending my approval`.

Header tile row above filters: `This month: $X · YTD: $Y · Pending: N bills · Unpaid: $Z`.

Top-right buttons: **+ New Expense** (opens `new.html` as a modal overlay), **Import** (links to `import.html`), **Export CSV** (downloads current filtered set).

Status badges color-coded: yellow=received, blue=approved, green=paid, red=rejected, gray=void.

### 7.2 Quick-add (`new.html`)

Inline modal on index, also standalone page for deep-link.

```
┌─ New expense ──────────────────────────────────┐
│ Vendor    [ search/select ⌄ ]  + new vendor    │
│ Property  [ search/select ⌄ ]                  │
│ Category  [ Repairs ⌄ ]  (auto-fills from vendor default if set)
│ Amount    $[ 0.00 ]                            │
│ Bill date    [ 2026-05-22 ]                    │
│ Paid on      [ 2026-05-22 ] [ ] Mark as unpaid │
│ Method    [ Check ⌄ ]   Ref: [ check# ]        │
│ Memo      [ short description ]                │
│ Notes     [ … ]                                │
│ Invoice   [ drag-drop / pick file ]            │
│                                                │
│ [ Cancel ] [ Save ] [ Save & add another ]     │
└────────────────────────────────────────────────┘
```

Vendor picker has an inline "+ new vendor" affordance that pops a small modal (name, default category, default method, optional address, 1099?, tax id). Saves and selects the new vendor without dismissing the expense form.

Behavior:
- If `paid_on` is set on submit → expense is created with `status='paid'`, `approved_by=req.userId`, `approved_at=now()` (the back-entry bypass).
- If `paid_on` is blank or "Mark as unpaid" checked → `status='received'`, awaits owner approval.
- Invoice file uploaded inline; on successful expense creation the file is associated. If upload fails the expense still saves; the user can attach later from the detail page.

### 7.3 Detail page (`item.html`)

- Header: status pill, vendor name, amount, property address.
- Edit pane (fields locked per status per §4.2 / §6.1).
- Attached files: thumbnails, drag-drop more, label/notes per file.
- Action buttons (state-dependent):
  - `received` + viewer is owner → **[Approve]** **[Reject]**
  - `approved` → **[Mark Paid]** (modal: paid_on, method, reference), **[Void]**
  - `paid` → **[Void]**
  - `rejected` → **[Re-open]**
  - `void` → **[Re-open]**
- Activity timeline (last 20 entries from `activity` table for this expense).

### 7.4 Vendor list (`vendors.html`)

Table: name, default category, # expenses, lifetime total, last paid on. Row click → drawer with edit + archive button.

### 7.5 Category admin (`categories.html`)

Owners only. Drag-to-reorder; toggle enabled; edit label; set `qb_account` text field (unused in v1).

### 7.6 Salesforce import (`import.html`)

Four-step wizard:

1. **Upload.** Drag-drop CSV, POST `/api/import/preview`.
2. **Map columns.** Table with required and optional Expenses fields on the left, dropdown of CSV column names on the right. Pre-fill best-guesses by name match (case-insensitive, e.g. CSV column "Amount" auto-maps to `amount`). User adjusts.
3. **Preview.** Shows first 50 rows mapped, flags errors per row (no vendor match, missing amount, bad date). User can choose `Create missing vendors` / `Fail on missing vendors`. Can re-edit mappings and re-preview.
4. **Commit.** POST `/api/import/commit`. Result page: `Imported N · Skipped N · Errors N (download CSV)`.

CSV parser is hand-rolled in `lib/csv.js` — no heavy dep needed for what this is. (Standard RFC 4180 quoting, no Excel-specific quirks expected.)

### 7.7 propspot-os sidebar tile

Expenses tile shows on every app sidebar (per existing `apps` registry + `app_grants` mechanic). Badge logic: poll `GET expenses.propspot.io/api/expenses/pending-approval-count` from os.propspot.io's sidebar code when the viewing user is an owner, render `💵 ●N` if N > 0. v1 polls on page load and every 60s while focused. (Cross-app realtime badging is the same deferred work called out in the inbox-signatures spec — out of scope.)

## 8. AP approval workflow

### 8.1 State machine

```
                            ┌─── (created with paid_on OR salesforce import) ──┐
                            ↓                                                   ↓
   create ────────→  [received] ──approve──→ [approved] ──mark paid──→ [paid]
                         │                       │                        │
                       reject                   void                     void
                         ↓                       ↓                        ↓
                      [rejected]              [void]                   [void]
                         │                                                │
                         └──reopen───→ [received]      [void] ──reopen──→ [received]
```

### 8.2 Transitions table

| From | Action | To | Allowed for | Effect |
|---|---|---|---|---|
| (none) | create (no paid_on) | received | any app grantee | requires_approval=TRUE |
| (none) | create (with paid_on) | paid | any app grantee | requires_approval=FALSE, approved_by=creator |
| (none) | import row | paid | server-side only | source='salesforce_import' |
| received | approve | approved | owner | sets approved_by/at |
| received | reject | rejected | owner | sets rejected_by/at/reason |
| received | delete | (gone) | creator or owner | hard delete |
| approved | mark_paid | paid | any app grantee | sets paid_on/method/reference |
| approved | void | void | owner | sets voided_by/at/reason |
| paid | void | void | owner | sets voided_by/at/reason |
| rejected | reopen | received | owner | clears rejected_* |
| void | reopen | received | owner | clears voided_* and (if paid) paid_on/method/reference |

Edit field rules:
- All fields editable in `received`.
- In `approved`: amount, bill_date, category, memo, notes editable; vendor/property locked.
- In `paid`: only memo, notes editable. Anything else requires void+reopen.
- In `rejected`/`void`: everything locked; reopen first.

### 8.3 Permissions

Owner = `users.is_owner = TRUE`. v1 implements approver authority by checking `is_owner` in the route handlers. No new role column. Phase 2 may add a per-user `can_approve_expenses` flag for delegating to the bookkeeper.

### 8.4 Notifications

v1 surface: sidebar badge from `pending-approval-count`. No email, no SMS, no Pulse mention. Phase 2 wires Pulse: when an expense lands in `received`, optionally mention the owners in a Pulse channel or DM.

## 9. Salesforce import

### 9.1 Expected CSV shape

The actual columns depend on Jordan's custom-object schema in Salesforce. The importer makes no assumptions beyond "it's a CSV with a header row." Field-mapping happens client-side after preview.

Best-guess mapping rules (the UI pre-fills these; user can adjust):

| Expense field | Heuristic match (case-insensitive, contains) |
|---|---|
| amount | "amount", "total", "cost" |
| bill_date | "bill date", "invoice date", "date" (if no paid date column) |
| paid_on | "paid", "paid on", "payment date" |
| vendor (name) | "vendor", "payee", "supplier" |
| property (address or display name) | "property", "address", "house" |
| category | "category", "type" |
| payment_method | "method", "payment method", "paid with" |
| reference | "ref", "reference", "check", "transaction" |
| memo | "memo", "description", "name" |
| notes | "notes", "comments" |
| source_external_id | "id" (always; SF Id is 15 or 18 chars) |

### 9.2 Vendor matching

For each row's vendor column:
1. Exact case-insensitive match on `vendors.name` → use that vendor_id.
2. No match + strategy=`create_missing` → INSERT a new vendor with just the name; row's vendor_id = the new id. Created vendor gets `source='salesforce_import'` in notes for traceability.
3. No match + strategy=`exact` → row is skipped, added to `errors[]`.

### 9.3 Property matching

For each row's property column:
1. Exact match on `properties.display_name` → use.
2. Otherwise exact match on `properties.address_line1` (combined with `city`/`state` if disambiguation needed) → use.
3. No match → row is skipped, added to `errors[]`. No "create property" in the importer (properties are a much heavier object owned by propspot-os; out of scope).

### 9.4 Idempotency

`(source, source_external_id)` unique constraint catches re-imports. Default behavior: skip duplicates and report in `skipped`. Add a `mode='update'` option (Phase 2 polish) for re-imports that want to overwrite.

### 9.5 Imported row defaults

- `status='paid'` (these are historical, assume already paid)
- `requires_approval=FALSE`
- `approved_by=NULL`, `approved_at=NULL` (importer didn't approve — they're pre-approved by definition)
- `paid_on` populated from the mapped CSV column. If no paid_on column maps and `default_status='paid'` is still set → row skipped, error: "row marked paid but no paid_on date."

## 10. QuickBooks (phase 2 — out of scope)

Stubbed schema columns:

- `vendors.qb_vendor_id`, `vendors.qb_synced_at`, `vendors.qb_sync_status`, `vendors.qb_sync_error`
- `expenses.qb_transaction_id`, `expenses.qb_synced_at`, `expenses.qb_sync_status`, `expenses.qb_sync_error`
- `expense_categories.qb_account` (for chart-of-accounts mapping)
- `source='quickbooks_sync'` reserved on `expenses.source`

Phase-2 spec will cover:
1. Intuit OAuth flow + token storage in propspot-os.
2. One-way push: PropSpot vendor → QB vendor on demand; PropSpot expense (status=paid) → QB Bill + Bill Payment.
3. Bidirectional reconciliation: match QB transactions to PropSpot expenses by amount + vendor + date + property; surface unmatched in both directions on a diff page.
4. Background sync worker (Railway cron) for incremental pushes.

Not built in v1. Schema is forward-compatible.

## 11. Migrations & rollout

Single migration block appended to `propspot-os/db/schema.sql`:

```sql
-- ── Expenses app ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors            ( ... );
CREATE TABLE IF NOT EXISTS expenses           ( ... );
CREATE TABLE IF NOT EXISTS expense_documents  ( ... );
CREATE TABLE IF NOT EXISTS expense_categories ( ... );
CREATE INDEX IF NOT EXISTS ...;
```

`propspot-os/db/seed.sql` appended:

```sql
-- expenses app registration
INSERT INTO apps (slug, name, description, icon, base_url, enabled) VALUES
  ('expenses','Expenses','Bills, invoices, and property-level expense tracking','💵','https://expenses.propspot.io',TRUE)
ON CONFLICT (slug) DO NOTHING;

-- seed categories
INSERT INTO expense_categories (slug, label, sort_order) VALUES (...)
ON CONFLICT (slug) DO NOTHING;
```

Existing logic that auto-grants every owner full access to every enabled app picks up the new row automatically — no per-user grant migration needed.

### 11.1 Rollout order

1. **Merge schema + seed changes** → propspot-os auto-deploys → tables exist, categories seeded, `expenses` row in `apps` table, owner grants minted.
2. **Set up Railway service** for `expenses/`: same GitHub repo, Root Directory = `expenses`, env vars (`DATABASE_URL`, `JWT_SECRET`, `OS_URL`, `OS_INTERNAL_URL`, `CLOUDINARY_*`, `APP_URL=https://expenses.propspot.io`), domain `expenses.propspot.io`.
3. **Merge expenses/ app code** → Railway builds and deploys → app reachable. Jordan can start entering expenses.
4. **Run Salesforce import** through the wizard. Backfill done.
5. **(Optional v1.5)** propspot-os property-detail page gets an "Expenses" tab. Small change; one new fetch + render block on the existing property page.

Each step is backwards-compatible with the previous deployed version. Step 3 can ship before any data is in the table — empty state UI is the first thing users see.

### 11.2 Backout

If something goes wrong after deploy: disable the app in the registry (`UPDATE apps SET enabled=FALSE WHERE slug='expenses'`) — sidebar tile vanishes for everyone, but the Railway service stays up. To fully back out: drop the four new tables (no other table references them). The phase 2 holdings_item_id FK in `expenses` is one-way (expenses → holdings), so holdings is unaffected.

## 12. Testing strategy

Manual smoke tests, matching the established propspot pattern (no automated test suite in any satellite app currently):

1. **Create a vendor** — name only, save, reappears in list with 0 expenses.
2. **Create an expense (unpaid)** — pick property + vendor + category, amount, no paid_on, save. Status badge shows "received". Approval action visible only to owner.
3. **Approve, then mark paid** — owner approves; status → approved. Click Mark Paid; modal collects paid_on/method/reference; status → paid.
4. **Reject + reopen** — owner rejects with reason; expense moves to rejected. Reopen sends it back to received with cleared rejection metadata.
5. **Back-entry bypass** — create an expense with paid_on filled; verify it lands in `paid` directly with `approved_by=req.userId` and `requires_approval=FALSE`. Non-owners can do this (yes — the assumption is "this was already paid, recording history").
6. **Attach invoice** — upload PDF on quick-add; verify file is associated. Upload an additional file from the detail page; both visible.
7. **Property/vendor delete protection** — try deleting a property that has an expense; verify 409/restricted.
8. **Sidebar badge** — create 3 unapproved expenses; verify the Expenses tile shows ●3 for the owner and no badge for a non-owner test user.
9. **List filters** — filter by status=paid, by date range, by property; verify totals tile updates.
10. **CSV import — happy path** — upload a 10-row CSV with all expected columns; map; commit; verify all 10 land as `paid`, `source='salesforce_import'`, `requires_approval=FALSE`.
11. **CSV import — missing vendor** — upload with one row referencing a vendor that doesn't exist; verify "create_missing" creates the vendor and the row imports; switch to "exact" mode and verify the row is skipped with an error.
12. **CSV import — re-import** — re-run the same CSV; verify all 10 rows are skipped (dedup on source_external_id).
13. **Approval edit-locking** — verify you can't change amount on a `paid` expense via the UI; verify the API also rejects with 409.
14. **Owner-only routes** — non-owner hits `POST /api/expenses/:id/approve` → 403.
15. **Schema constraint** — try inserting an expense with `status='paid'` and `paid_on=NULL` directly via SQL; verify CHECK constraint blocks it.

Tests #1–9 are the v1 happy path; #10–12 cover the import; #13–15 cover edge / security.

## 13. Open questions

None. Design locked in:
- Holdings untouched in v1 (parallel ledger; phase 2 reconciles).
- New `vendors` table (not reused `contacts`).
- One expense row = one transaction (`bill_date` + nullable `paid_on`).
- AP approval workflow with owner-only approvers and back-entry bypass when `paid_on` is set at create time.
- No vendor-level auto-approve and no approval thresholds in v1.
- Salesforce import is a generic CSV+mapping wizard; imported rows land as `paid` with `requires_approval=FALSE`.
- QuickBooks columns stubbed now, sync deferred to phase 2.
