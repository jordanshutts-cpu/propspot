# Expenses app

**Date:** 2026-05-22
**Status:** Draft, pending Jordan review

## 1. Goal

Stand up a new PropSpot satellite app, **Expenses**, at `expenses.propspot.io`, that serves as the bookkeeper-facing transactional ledger of every bill Restoration Homes pays. Each expense is tied to a property and a vendor, can have an invoice file attached, and flows through a simple AP approval state machine (received → approved → paid). Vendors are a new first-class entity. Historical expenses currently stored in Salesforce are backfilled via an operator-run Node.js script (not a user-facing import surface). QuickBooks sync is stubbed in the schema but deferred to a phase-2 spec.

The app must be usable for live expense entry on day one and must support a same-day import of historical Salesforce data.

## 2. Scope

**In scope:**

- New satellite app at `propspot/expenses/`, deployed as its own Railway service at `expenses.propspot.io`, mirroring the structure of `holdings/`.
- Five new tables in the shared schema: `vendors`, `vendor_documents`, `expenses`, `expense_documents`, `expense_categories`.
- **Vendor compliance tracking**: each vendor has dedicated upload slots for W9, Workers Comp insurance, and General Liability insurance. Insurance docs carry policy number, carrier, effective date, expiration date. Exemption flags for vendors who legitimately don't need WC/GL (e.g. material-only suppliers, sole proprietors without employees). Status badges (on file / expiring soon / expired / missing / exempt) surface on the vendor list and edit drawer.
- Seeded category list (utility, insurance, property_tax, mortgage, hoa, business_license, repairs, maintenance, materials, contractor_labor, supplies, professional_fees, legal, travel, marketing, other), admin-editable.
- Full CRUD UI: list view with filters and totals, quick-add form, expense detail page, vendor list + edit, category admin page.
- Invoice file uploads to Cloudinary (PDF, image, doc, xls, txt), one or more files per expense.
- AP approval workflow: state machine with `received` / `approved` / `paid` / `rejected` / `void`; owner-only approval; back-entry-with-paid_on bypass.
- One-time Salesforce backfill via a Node.js script under `expenses/scripts/import-salesforce-expenses.js`. **Not part of the user-facing app** — no UI, no menu item, no API endpoint. Operator-run (Jordan + Claude in a session, or via Railway one-off command). Idempotent on re-run via the `(source, source_external_id)` unique constraint.
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
- Phase 2 — **Vendor self-service compliance portal**: magic-link login for vendors to upload their own W9 / WC / GL certs and update on renewal. Schema is built compatibility-first (`vendor_documents.uploaded_via` distinguishes staff vs vendor-uploaded), but no portal UI in v1.
- Phase 2 — Expiration reminders (email vendors and ourselves when WC/GL is within 30 days of expiry). v1 surfaces status visually only.
- Property-detail "Expenses" tab inside `propspot-os` — included in v1 if it lands cheaply, otherwise punted to a phase-1.5 follow-up. The standalone app is the day-one shipping target.

## 3. Architecture overview

```
                  ┌─────────────────────────────────────────┐
                  │              shared Postgres            │
                  │  (existing tables + vendors,            │
                  │   vendor_documents, expenses,           │
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
  -- Compliance exemptions (some vendors don't need certain certs)
  workers_comp_exempt        BOOLEAN NOT NULL DEFAULT FALSE,
  workers_comp_exempt_reason TEXT,                       -- "sole prop, no employees" etc.
  general_liability_exempt   BOOLEAN NOT NULL DEFAULT FALSE,
  general_liability_exempt_reason TEXT,                  -- "material-only supplier" etc.
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

W9 has no exemption flag — it's required for all 1099-eligible vendors, and tracking "missing" is more useful than tracking "exempt" for compliance.

### 4.2 `vendor_documents`

Compliance certificates and tax forms attached to a vendor. Distinct from `expense_documents` (which are invoices). Designed to support both staff-upload (v1) and future vendor-self-upload (phase 2) via `uploaded_via`. History is preserved — a new GL cert doesn't overwrite the old; the most recent per `(vendor_id, doc_type)` is "current."

```sql
CREATE TABLE IF NOT EXISTS vendor_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL,           -- w9 | workers_comp | general_liability | other
  label           TEXT,
  -- Insurance metadata (NULL for w9 / other)
  policy_number   TEXT,
  carrier         TEXT,
  effective_date  DATE,
  expires_on      DATE,                    -- drives expiring-soon / expired status badges
  -- File (always present)
  url             TEXT NOT NULL,
  cloudinary_id   TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,
  notes           TEXT,
  -- Source tracking
  uploaded_via    TEXT NOT NULL DEFAULT 'staff',  -- staff | vendor_portal | email_inbound
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL when vendor self-uploads (future)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT vendor_documents_type_check
    CHECK (doc_type IN ('w9','workers_comp','general_liability','other'))
);
CREATE INDEX IF NOT EXISTS vendor_documents_vendor_idx  ON vendor_documents(vendor_id);
CREATE INDEX IF NOT EXISTS vendor_documents_type_idx    ON vendor_documents(vendor_id, doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_documents_expires_idx ON vendor_documents(expires_on)
  WHERE expires_on IS NOT NULL;
```

**Status derivation (computed, not stored):** for each `(vendor, doc_type)`, the compliance status is:

| State | Condition |
|---|---|
| `exempt` | Relevant `*_exempt` flag set on vendor (WC/GL only) |
| `missing` | No `vendor_documents` row of this type, and not exempt |
| `on_file` | Most recent row has `expires_on IS NULL` (W9, or insurance without expiry tracked) OR `expires_on > CURRENT_DATE + 30` |
| `expiring_soon` | `expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 30` |
| `expired` | `expires_on < CURRENT_DATE` |

A SQL view `vendor_compliance_status` materializes this per-vendor for the list query:

```sql
CREATE OR REPLACE VIEW vendor_compliance_status AS
WITH latest AS (
  SELECT DISTINCT ON (vendor_id, doc_type)
    vendor_id, doc_type, expires_on, url
  FROM vendor_documents
  ORDER BY vendor_id, doc_type, created_at DESC
)
SELECT
  v.id AS vendor_id,
  -- W9
  CASE
    WHEN w9.vendor_id IS NULL THEN 'missing'
    ELSE 'on_file'
  END AS w9_status,
  w9.url AS w9_url,
  -- Workers Comp
  CASE
    WHEN v.workers_comp_exempt THEN 'exempt'
    WHEN wc.vendor_id IS NULL THEN 'missing'
    WHEN wc.expires_on IS NULL THEN 'on_file'
    WHEN wc.expires_on < CURRENT_DATE THEN 'expired'
    WHEN wc.expires_on < CURRENT_DATE + 30 THEN 'expiring_soon'
    ELSE 'on_file'
  END AS workers_comp_status,
  wc.expires_on AS workers_comp_expires_on,
  wc.url        AS workers_comp_url,
  -- General Liability
  CASE
    WHEN v.general_liability_exempt THEN 'exempt'
    WHEN gl.vendor_id IS NULL THEN 'missing'
    WHEN gl.expires_on IS NULL THEN 'on_file'
    WHEN gl.expires_on < CURRENT_DATE THEN 'expired'
    WHEN gl.expires_on < CURRENT_DATE + 30 THEN 'expiring_soon'
    ELSE 'on_file'
  END AS general_liability_status,
  gl.expires_on AS general_liability_expires_on,
  gl.url        AS general_liability_url
FROM vendors v
LEFT JOIN latest w9 ON w9.vendor_id = v.id AND w9.doc_type = 'w9'
LEFT JOIN latest wc ON wc.vendor_id = v.id AND wc.doc_type = 'workers_comp'
LEFT JOIN latest gl ON gl.vendor_id = v.id AND gl.doc_type = 'general_liability';
```

The view is the single source of truth for status across the UI — vendor list query joins to it; the vendor detail page reads it; the optional dashboard widget queries it. Recomputed on read (it's a view, not a materialized view) — perf is fine at the scale of "a few hundred vendors max."

### 4.3 `expenses`

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

### 4.4 `expense_documents`

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

### 4.5 `expense_categories`

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
│   └── approval.js          # state-machine helpers (canTransition, applyTransition)
├── routes/
│   ├── expenses.js          # CRUD + /summary + /pending-approval-count + state transitions
│   ├── vendors.js           # CRUD + /search?q= + /compliance (list with status)
│   ├── vendor-documents.js  # multipart upload + list + delete for W9 / WC / GL / other
│   ├── categories.js        # GET list + admin PATCH (owners only)
│   ├── documents.js         # multipart upload → Cloudinary → expense_documents (invoices)
│   └── lookups.js           # /properties (for picker), echoes through to propspot-os
├── scripts/
│   └── import-salesforce-expenses.js  # one-time backfill; NOT shipped in UI
└── public/
    ├── index.html           # main list view with filters + totals
    ├── new.html             # quick-add (also embedded as a modal on index)
    ├── item.html            # expense detail
    ├── vendors.html         # vendor list with compliance badges
    ├── vendor.html          # vendor detail + edit + compliance (W9/WC/GL) section
    ├── categories.html      # category admin (owners only)
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
| `GET`    | `/api/vendors` | Filters: `status`, `q` (name search), `compliance` (csv of `w9_missing` \| `wc_missing` \| `gl_missing` \| `expiring_soon` \| `expired`). Always joins `vendor_compliance_status` view. |
| `GET`    | `/api/vendors/:id` | Vendor + counts (`expense_count`, `lifetime_total`, `last_paid_on`) + full compliance status block + list of `vendor_documents`. |
| `POST`   | `/api/vendors` | Create. |
| `PATCH`  | `/api/vendors/:id` | Update. Includes exemption flags + exemption reasons. |
| `POST`   | `/api/vendors/:id/archive` | status='archived'. Doesn't touch existing expenses. |
| `POST`   | `/api/vendors/:id/unarchive` | status='active'. |

No DELETE — archive only. Hard delete would break referential history; this matches QuickBooks behavior anyway (QB vendors archive, never delete).

### 6.3 Vendor documents (W9 / Workers Comp / General Liability)

| Method | Path | Notes |
|---|---|---|
| `POST`   | `/api/vendors/:vendorId/documents` | multipart, field `file`. Body: `doc_type` (required: `w9` \| `workers_comp` \| `general_liability` \| `other`), `label`, `policy_number`, `carrier`, `effective_date`, `expires_on`, `notes`. Uploads to Cloudinary `folder=vendor-documents`. `uploaded_via='staff'`, `uploaded_by=req.userId`. |
| `GET`    | `/api/vendors/:vendorId/documents` | Lists all docs for a vendor, ordered by `(doc_type, created_at DESC)`. Optional `?type=workers_comp` filter. |
| `GET`    | `/api/vendor-documents/:id` | Single doc. |
| `PATCH`  | `/api/vendor-documents/:id` | Update metadata (label, policy_number, carrier, effective_date, expires_on, notes). The file itself is immutable — to "replace" you upload a new row. |
| `DELETE` | `/api/vendor-documents/:id` | Removes Cloudinary asset + row. The next most recent doc of the same type (if any) automatically becomes "current" because the view picks latest. |
| `GET`    | `/api/vendors/compliance-summary` | Optional dashboard endpoint: returns `{ expired: [...], expiring_soon: [...], missing_w9: [...] }`. Drives a Phase 1.5 dashboard widget. |

Multer config same as expense documents: 20 MB cap, mime allowlist (pdf, image/*, doc, docx, xls, xlsx, txt). W9 forms and insurance certs are typically PDF or image.

### 6.4 Categories

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/categories` | Public. Ordered by sort_order. |
| `PATCH`  | `/api/categories/:slug` | Owner-only. Updates label, sort_order, enabled, qb_account. |
| `POST`   | `/api/categories` | Owner-only. Adds a new category. |

### 6.5 Expense documents (invoices)

| Method | Path | Notes |
|---|---|---|
| `POST`   | `/api/expenses/:expenseId/documents` | multipart, field `file`. Uploads to Cloudinary `folder=expenses`. |
| `GET`    | `/api/documents?expense_id=…&property_id=…` | List. |
| `PATCH`  | `/api/documents/:id` | Update label, doc_type, notes. |
| `DELETE` | `/api/documents/:id` | Removes Cloudinary asset + row. |

Multer config copied from holdings: 20 MB cap, mime allowlist (pdf, image/*, doc, docx, xls, xlsx, txt).

No import endpoints. The Salesforce backfill is a Node script — see §9.

## 7. UI flows

### 7.1 List view (`index.html`)

Sortable table:

```
[ Status ] [ Date Paid ▼ ] [ Vendor ] [ Property ] [ Category ] [ Amount ] [ Method ] [ Ref ] [ 📎 ] [ ⋮ ]
```

Filter chips above the table: `Property ⌄  Vendor ⌄  Category ⌄  Status ⌄  Date range ⌄  Pending my approval`.

Header tile row above filters: `This month: $X · YTD: $Y · Pending: N bills · Unpaid: $Z`.

Top-right buttons: **+ New Expense** (opens `new.html` as a modal overlay), **Export CSV** (downloads current filtered set). No Import button — the Salesforce backfill is operator-only (see §9).

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

Table columns:

```
[ Name ] [ Default category ] [ # expenses ] [ Lifetime $ ] [ Last paid ] [ Compliance ] [ ⋮ ]
```

The **Compliance** column renders three small color-coded dots in a fixed order — **W9 · WC · GL**:

| Dot color | State |
|---|---|
| 🟢 green | on file (no expiry, or expires > 30 days out) |
| 🟡 yellow | expiring within 30 days |
| 🔴 red | expired or missing |
| ⚪ gray | exempt (WC/GL only) |

Hover/tap any dot → tooltip with the doc's status text ("Expires 2026-08-14" / "Missing" / "Exempt — sole proprietor"). Click a dot → opens that vendor's compliance section in the detail page anchored to the relevant doc type.

Filter chips above the table: `Status ⌄`, `Compliance ⌄` (multi-select: "Missing W9 / Missing WC / Missing GL / Expiring soon / Expired"), `Search`.

Row click → navigates to `vendor.html?id=<uuid>` (the detail page below).

### 7.5 Vendor detail (`vendor.html`)

Two-pane layout.

**Left pane — Vendor info.** Standard edit form: name, display name, contact (email/phone/website), address, default category, default payment method, account number, tax ID, `is_1099` checkbox, notes, archive button. Below contact info, an "Activity" panel: expense count, lifetime total, last paid on, link to filtered expense list ("View 47 expenses").

**Right pane — Compliance.** Three stacked sub-cards in fixed order — **W9**, **Workers Comp**, **General Liability**. Each card looks like:

```
┌─ Workers Comp Insurance ──────────── 🟡 Expiring 2026-06-08 ──┐
│                                                                │
│ Policy #   ABC-12345-WC                                       │
│ Carrier    The Hartford                                       │
│ Effective  2025-06-08    Expires  2026-06-08                  │
│                                                                │
│ 📄 wc-cert-2025.pdf  (2.1 MB · uploaded by jordan · 11 mo ago)│
│    [ View ] [ Download ] [ Replace with new cert ]            │
│                                                                │
│ Past certs (1) ▾                                              │
│                                                                │
│ ☐ This vendor is exempt from workers comp                     │
└────────────────────────────────────────────────────────────────┘
```

- **No file uploaded** state: card shows the upload area instead of policy fields, with a button **[ Upload Workers Comp ]** that opens a modal with file + metadata fields.
- **Exempt** checkbox toggles the `workers_comp_exempt` flag. When checked, a small text input appears for `workers_comp_exempt_reason`. The card collapses to: "Exempt — *(reason)*". Card switches to gray status.
- **"Replace with new cert"** opens the upload modal pre-filled with a renewal helper (suggests `effective_date = today`, expiration = 1 year out, blank policy/carrier). Submitting creates a new `vendor_documents` row — does NOT overwrite the prior one. The new row becomes "current."
- **"Past certs"** disclosure expands to show prior `vendor_documents` rows of the same type, each viewable/downloadable. Used for audit history.
- The **W9 card** has no policy_number / carrier / expires_on fields — just upload area + "Date received" input that maps to `effective_date`. No exempt checkbox.
- The **General Liability card** is identical in shape to the Workers Comp card.

Upload modal fields:

```
┌─ Upload [W9 | Workers Comp | General Liability] ──┐
│ File:           [ drag-drop or pick ]              │
│ Policy #:       [ ___________ ]   (insurance only) │
│ Carrier:        [ ___________ ]   (insurance only) │
│ Effective:      [ 2026-05-22 ]                     │
│ Expires:        [ 2027-05-22 ]    (insurance only) │
│ Label:          [ optional ]                       │
│ Notes:          [ ... ]                            │
│                                                    │
│ [ Cancel ]  [ Upload ]                             │
└────────────────────────────────────────────────────┘
```

### 7.6 Category admin (`categories.html`)

Owners only. Drag-to-reorder; toggle enabled; edit label; set `qb_account` text field (unused in v1).

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

## 9. Salesforce backfill (one-time operator script)

**Not user-facing.** No UI, no menu item, no HTTP endpoint. The Expenses app ships *without* an import surface to keep things simple for everyone except Jordan. Backfill happens once via a Node.js script that Jordan and Claude run together — Jordan provides the CSV, Claude runs the script, the historical data lands in the table.

### 9.1 Script location and invocation

`propspot/expenses/scripts/import-salesforce-expenses.js`

Invocation:

```
cd expenses
node scripts/import-salesforce-expenses.js <path/to/salesforce-export.csv> [--dry-run] [--create-missing-vendors] [--mapping=path/to/mapping.json]
```

Flags:

- `--dry-run` — parses, matches, and reports counts without writing. Use to sanity-check before committing.
- `--create-missing-vendors` — when a vendor name from CSV doesn't exist in the DB, create a stub vendor row (just name + `notes='Created from Salesforce backfill'`). Without this flag, those rows are skipped and listed in the error report.
- `--mapping=<path>` — supply a JSON file mapping CSV column names → expense fields. If omitted, the script uses the best-guess defaults below and prints a "here's what I mapped" summary up top for manual review before processing.

The script connects to the same `DATABASE_URL` the deployed app uses — read from env. Can run locally (against Railway's hosted DB) or as a Railway one-off command (`railway run node scripts/import-salesforce-expenses.js ...`).

### 9.2 Expected CSV shape

The script assumes a CSV with a header row. Real columns depend on Jordan's Salesforce custom-object export — we'll inspect the actual file once and either hardcode the mapping or pass it via `--mapping`.

Best-guess column→field heuristics (used when no mapping file supplied):

| Expense field | Heuristic match (case-insensitive, contains) |
|---|---|
| amount | "amount", "total", "cost" |
| bill_date | "bill date", "invoice date", "date" (only if no paid-date column matches) |
| paid_on | "paid", "paid on", "payment date" |
| vendor (name) | "vendor", "payee", "supplier" |
| property (address or display name) | "property", "address", "house" |
| category | "category", "type" |
| payment_method | "method", "payment method", "paid with" |
| reference | "ref", "reference", "check", "transaction" |
| memo | "memo", "description", "name" |
| notes | "notes", "comments" |
| source_external_id | "id" (always; SF Id is 15 or 18 chars) |

A `--mapping` file overrides heuristics:

```json
{
  "amount":             "Cost__c",
  "paid_on":            "Payment_Date__c",
  "vendor":             "Vendor_Name__c",
  "property":           "Property__r.Address__c",
  "category":           "Category__c",
  "payment_method":     "How_Paid__c",
  "reference":          "Check_Number__c",
  "memo":               "Description__c",
  "source_external_id": "Id"
}
```

### 9.3 Vendor matching

For each row's vendor column:

1. Exact case-insensitive match on `vendors.name` → use that vendor_id.
2. No match + `--create-missing-vendors` → INSERT a new vendor with just the name.
3. No match + no flag → row is skipped, added to the error report.

### 9.4 Property matching

For each row's property column:

1. Exact case-insensitive match on `properties.display_name` → use.
2. Otherwise exact match on `properties.address_line1` (disambiguated by `city`/`state` if multiple match) → use.
3. No match → row is skipped, added to the error report. No "create property" — properties are a heavier object owned by propspot-os and would need addresses/coords/parcels we don't have in the export.

### 9.5 Idempotency

The `(source, source_external_id)` unique constraint catches re-imports. If the script is re-run with the same CSV (e.g. after fixing missing vendors), already-imported rows hit the constraint and are reported in `skipped`, not re-inserted. Other rows commit. Safe to run multiple times.

### 9.6 Imported row defaults

- `source='salesforce_import'`
- `source_external_id=<row's SF Id>`
- `status='paid'`
- `requires_approval=FALSE`
- `approved_by=NULL`, `approved_at=NULL` (script didn't approve — these are pre-approved by definition of being historical)
- `paid_on` populated from the mapped column. If neither paid_on nor bill_date maps and amount is present → row skipped with error "row has amount but no date column."

### 9.7 Output

After running, the script prints:

```
Salesforce Expense Backfill
───────────────────────────
Source file:  ~/Desktop/sf-expenses-2026-05.csv
Total rows:   1,243

Mapping used (auto-detected):
  amount           ← "Cost__c"
  paid_on          ← "Payment_Date__c"
  ...

Results:
  ✓ Imported:           1,201
  ⊘ Skipped (dup):          5    (already imported in a prior run)
  ✗ Errors:               37
     - 22 rows: vendor not matched (use --create-missing-vendors)
     - 11 rows: property not matched
     -  4 rows: missing required field (amount or date)

Error detail written to: ./import-errors-2026-05-22.csv
```

The error CSV contains the original row + the error reason so Jordan can fix in Salesforce and re-export, or hand-fix in DB.

### 9.8 After backfill

The script is left in the repo for reference / future audit. It can be re-run safely if more historical data shows up (the unique constraint protects against double-inserts). No need to remove it — but it never gets a UI surface in the Expenses app.

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
CREATE TABLE IF NOT EXISTS vendor_documents   ( ... );
CREATE TABLE IF NOT EXISTS expenses           ( ... );
CREATE TABLE IF NOT EXISTS expense_documents  ( ... );
CREATE TABLE IF NOT EXISTS expense_categories ( ... );
CREATE INDEX IF NOT EXISTS ...;
CREATE OR REPLACE VIEW vendor_compliance_status AS ( ... );
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
4. **Backfill historical Salesforce data**: Jordan exports his SF expense object as CSV → hands the file to Claude → Claude runs `node scripts/import-salesforce-expenses.js <file>` (locally or via `railway run`) → done. No user-facing import surface. Re-runnable safely if more historical data turns up.
5. **(Optional v1.5)** propspot-os property-detail page gets an "Expenses" tab. Small change; one new fetch + render block on the existing property page.

Each step is backwards-compatible with the previous deployed version. Step 3 can ship before any data is in the table — empty state UI is the first thing users see.

### 11.2 Backout

If something goes wrong after deploy: disable the app in the registry (`UPDATE apps SET enabled=FALSE WHERE slug='expenses'`) — sidebar tile vanishes for everyone, but the Railway service stays up. To fully back out: drop the five new tables and the view (no other table references them). The phase 2 holdings_item_id FK in `expenses` is one-way (expenses → holdings), so holdings is unaffected.

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
10. **Backfill script — happy path** — run `node scripts/import-salesforce-expenses.js sample.csv` against a 10-row test CSV with all expected columns. Verify all 10 land as `status='paid'`, `source='salesforce_import'`, `requires_approval=FALSE`, with the SF Id captured in `source_external_id`.
11. **Backfill script — missing vendor** — include a row whose vendor name doesn't match any `vendors.name`. Without `--create-missing-vendors`, verify the row appears in the error report and is NOT inserted. With the flag, verify the vendor is created and the row imports.
12. **Backfill script — idempotency** — re-run the same CSV. Verify all 10 rows are reported in "Skipped (dup)" and the table count is unchanged.
13. **Approval edit-locking** — verify you can't change amount on a `paid` expense via the UI; verify the API also rejects with 409.
14. **Owner-only routes** — non-owner hits `POST /api/expenses/:id/approve` → 403.
15. **Schema constraint** — try inserting an expense with `status='paid'` and `paid_on=NULL` directly via SQL; verify CHECK constraint blocks it.
16. **Vendor compliance — upload W9** — open a vendor with no compliance, click "Upload W9", attach a PDF, set Date received, save. Card status flips green, file appears with View/Download.
17. **Vendor compliance — upload WC + expiration math** — upload a Workers Comp cert with expires_on=today+45 → status `on_file` (green). Edit expires_on to today+10 → status `expiring_soon` (yellow). Edit to yesterday → status `expired` (red).
18. **Vendor compliance — replace cert keeps history** — upload a renewal WC cert; verify "current" is the new one and "Past certs (1)" shows the previous. Both files still downloadable.
19. **Vendor compliance — exempt flag** — check "exempt from workers comp" with a reason; verify WC dot turns gray on list view and card collapses to the exempt state on the vendor detail.
20. **Vendor compliance — list filter** — filter vendor list by "Missing W9"; verify only vendors with no W9 row and (no W9-exempt — W9 has no exempt) show up.
21. **Vendor compliance — view computes status correctly** — query `SELECT * FROM vendor_compliance_status WHERE vendor_id = '...'` directly; verify all three statuses match what the UI shows.

Tests #1–9 are the v1 happy path; #10–12 cover the operator-only backfill script (not user-facing); #13–15 cover edge / security; #16–21 cover vendor compliance.

## 13. Open questions

None. Design locked in:
- Holdings untouched in v1 (parallel ledger; phase 2 reconciles).
- New `vendors` table (not reused `contacts`).
- One expense row = one transaction (`bill_date` + nullable `paid_on`).
- AP approval workflow with owner-only approvers and back-entry bypass when `paid_on` is set at create time.
- No vendor-level auto-approve and no approval thresholds in v1.
- Salesforce backfill is an **operator-only Node.js script** (not a user-facing wizard, no UI, no API). Run once by Claude with Jordan's CSV; imported rows land as `paid` with `requires_approval=FALSE`. Re-runnable safely via the unique constraint on `(source, source_external_id)`.
- QuickBooks columns stubbed now, sync deferred to phase 2.
- Vendor compliance tracked via `vendor_documents` table with type ∈ {w9, workers_comp, general_liability, other}, expiration-aware status computed by `vendor_compliance_status` view, exempt flags on vendors for WC/GL only, history preserved on renewal, schema ready for phase-2 vendor self-upload portal.
