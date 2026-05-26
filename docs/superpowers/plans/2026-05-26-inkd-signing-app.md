# Ink'd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-PropSpot document signing app (Ink'd) that supports PDF templates with PropSpot data autofill, multi-party email signing via magic links, audit trail + SHA-256 hashed certificate, and a review-before-Files queue — all inside `propspot-os` with no new Railway service.

**Architecture:** All code lives inside `propspot-os/` — routes under `routes/inkd/`, UI pages under `public/inkd*.html`, helpers under `lib/inkd-*.js`, schema appended to `db/schema.sql`. The signing engine is fully in-house using pdf-lib (server) + PDF.js (browser) + signature_pad (canvas). No third-party signing API (DocuSign, BoldSign, etc.). Email delivery via existing nodemailer; SMS deferred. Completed envelopes stage in an Ink'd "Completed (review)" lane and require explicit user promotion to push into the property's Files page.

**Tech Stack:** Node 18 + Express + Postgres (existing) · pdf-lib · PDF.js · signature_pad · nodemailer · Cloudinary · bcryptjs · `node:test` (built-in) for pure-logic tests

**Spec:** `docs/superpowers/specs/2026-05-26-inkd-signing-app-design.md`

**Testing convention (existing PropSpot pattern):**
- `node:test` (Node 18+ built-in, zero install) is used for pure-logic units in `propspot-os/tests/inkd/` — only for high-risk math, hashing, coordinate conversion, autofill resolution, token verification
- Run a single test: `cd propspot-os && node --test tests/inkd/<name>.test.js`
- DB/HTTP integration is verified manually via the gitignored `propspot-os/preview-server.js` and live testing in Railway preview deploys
- Each non-trivial UI/route task ends with a **manual verification** checklist instead of an automated test

**Branch convention:** This plan should be executed on `claude/inkd-implementation` (or a sub-branch per phase if work is split across multiple PRs). Each phase ends with a commit; phases 1–6 should each become their own PR for review.

---

## Phase 0 — Project setup

Goal: pdf-lib, signature_pad installed; test directory created; Cloudinary folder convention defined.

### Task 0.1: Install runtime dependencies

**Files:**
- Modify: `propspot-os/package.json`

- [ ] **Step 1: Install pdf-lib and signature_pad**

```bash
cd propspot-os
npm install pdf-lib@^1.17.1 signature_pad@^4.2.0
```

- [ ] **Step 2: Verify the install added both to dependencies**

Run: `cd propspot-os && grep -E "pdf-lib|signature_pad" package.json`
Expected: both lines present in the `dependencies` block.

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add package.json package-lock.json
git commit -m "deps: add pdf-lib and signature_pad for Ink'd"
```

### Task 0.2: Create test directory + first sanity test

**Files:**
- Create: `propspot-os/tests/inkd/sanity.test.js`

- [ ] **Step 1: Write a sanity test using node:test**

```js
// propspot-os/tests/inkd/sanity.test.js
const test = require('node:test');
const assert = require('node:assert');

test('node:test is wired up', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 2: Run the test**

Run: `cd propspot-os && node --test tests/inkd/sanity.test.js`
Expected: `# pass 1` in output.

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add tests/inkd/sanity.test.js
git commit -m "test: scaffold node:test for Ink'd"
```

---

## Phase 1 — Data model + foundation libs

Goal: schema migration, audit logger, magic-link tokens, autofill resolver. After this phase the data layer + helpers are tested and ready for routes/UI.

### Task 1.1: Add Ink'd tables to schema.sql

**Files:**
- Modify: `propspot-os/db/schema.sql` (append at end)

- [ ] **Step 1: Append the Ink'd table block to schema.sql**

Append this exact block to the end of `propspot-os/db/schema.sql`. All `CREATE TABLE IF NOT EXISTS` guards keep it idempotent per the existing schema convention.

```sql
-- =====================================================================
-- Ink'd — in-PropSpot document signing
-- See docs/superpowers/specs/2026-05-26-inkd-signing-app-design.md
-- =====================================================================

CREATE TABLE IF NOT EXISTS inkd_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  category        TEXT,
  description     TEXT,
  source_pdf_url  TEXT NOT NULL,
  source_pdf_id   TEXT NOT NULL,
  page_count      INT NOT NULL,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inkd_templates_category ON inkd_templates(category) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS inkd_template_fields (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       UUID NOT NULL REFERENCES inkd_templates(id) ON DELETE CASCADE,
  page_number       INT NOT NULL,
  x_pct             NUMERIC(6,4) NOT NULL,
  y_pct             NUMERIC(6,4) NOT NULL,
  width_pct         NUMERIC(6,4) NOT NULL,
  height_pct        NUMERIC(6,4) NOT NULL,
  field_type        TEXT NOT NULL CHECK (field_type IN ('text','signature','initial','date','checkbox')),
  label             TEXT,
  recipient_role    TEXT,
  required          BOOLEAN NOT NULL DEFAULT TRUE,
  autofill_source   TEXT,
  display_order     INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inkd_template_fields_template ON inkd_template_fields(template_id, page_number, display_order);

CREATE TABLE IF NOT EXISTS inkd_envelopes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id              UUID REFERENCES inkd_templates(id),
  source_pdf_url           TEXT NOT NULL,
  source_pdf_id            TEXT NOT NULL,
  page_count               INT NOT NULL,
  name                     TEXT NOT NULL,
  property_id              INT REFERENCES properties(id),
  opportunity_id           INT REFERENCES opportunities(id),
  contact_id               INT REFERENCES contacts(id),
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','completed','voided','expired')),
  reminders_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_schedule        JSONB NOT NULL DEFAULT '[3,7]'::jsonb,
  expires_at               TIMESTAMPTZ,
  sent_at                  TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  filed_at                 TIMESTAMPTZ,
  filed_property_file_id   INT REFERENCES property_files(id),
  final_pdf_url            TEXT,
  final_pdf_id             TEXT,
  final_pdf_hash           TEXT,
  created_by               INT NOT NULL REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inkd_envelopes_status ON inkd_envelopes(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inkd_envelopes_property ON inkd_envelopes(property_id) WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inkd_recipients (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id            UUID NOT NULL REFERENCES inkd_envelopes(id) ON DELETE CASCADE,
  role                   TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  email                  TEXT NOT NULL,
  phone                  TEXT,
  contact_id             INT REFERENCES contacts(id),
  signing_order          INT NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','notified','viewed','signed','declined','expired')),
  sign_token_hash        TEXT NOT NULL UNIQUE,
  sign_token_expires_at  TIMESTAMPTZ NOT NULL,
  notified_at            TIMESTAMPTZ,
  viewed_at              TIMESTAMPTZ,
  signed_at              TIMESTAMPTZ,
  signed_ip              INET,
  signed_user_agent      TEXT,
  decline_reason         TEXT,
  last_reminded_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inkd_recipients_envelope ON inkd_recipients(envelope_id, signing_order);

CREATE TABLE IF NOT EXISTS inkd_field_values (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id         UUID NOT NULL REFERENCES inkd_envelopes(id) ON DELETE CASCADE,
  template_field_id   UUID REFERENCES inkd_template_fields(id),
  page_number         INT NOT NULL,
  x_pct               NUMERIC(6,4) NOT NULL,
  y_pct               NUMERIC(6,4) NOT NULL,
  width_pct           NUMERIC(6,4) NOT NULL,
  height_pct          NUMERIC(6,4) NOT NULL,
  field_type          TEXT NOT NULL CHECK (field_type IN ('text','signature','initial','date','checkbox')),
  label               TEXT,
  recipient_id        UUID REFERENCES inkd_recipients(id) ON DELETE CASCADE,
  value               TEXT,
  value_filled_at     TIMESTAMPTZ,
  value_filled_by     INT REFERENCES users(id),
  autofilled          BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_inkd_field_values_envelope ON inkd_field_values(envelope_id, page_number);

CREATE TABLE IF NOT EXISTS inkd_audit_events (
  id            BIGSERIAL PRIMARY KEY,
  envelope_id   UUID NOT NULL REFERENCES inkd_envelopes(id) ON DELETE CASCADE,
  recipient_id  UUID REFERENCES inkd_recipients(id),
  event_type    TEXT NOT NULL,
  event_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            INET,
  user_agent    TEXT,
  user_id       INT REFERENCES users(id),
  details       JSONB
);
CREATE INDEX IF NOT EXISTS idx_inkd_audit_envelope ON inkd_audit_events(envelope_id, event_at);
```

- [ ] **Step 2: Restart propspot-os locally to run initDb**

Run: `cd propspot-os && node -e "require('./db').initDb().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"`
Expected: exits cleanly with no SQL error.

- [ ] **Step 3: Spot-check the tables exist**

Run: `cd propspot-os && node -e "require('./db').query('SELECT tablename FROM pg_tables WHERE tablename LIKE \\'inkd_%\\' ORDER BY tablename').then(r=>{console.log(r.rows.map(x=>x.tablename));process.exit(0)})"`
Expected output:
```
[ 'inkd_audit_events', 'inkd_envelopes', 'inkd_field_values', 'inkd_recipients', 'inkd_template_fields', 'inkd_templates' ]
```

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add db/schema.sql
git commit -m "schema: add Ink'd tables (templates, fields, envelopes, recipients, field_values, audit_events)"
```

### Task 1.2: Magic-link token helper

**Files:**
- Create: `propspot-os/lib/inkd-tokens.js`
- Create: `propspot-os/tests/inkd/tokens.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// propspot-os/tests/inkd/tokens.test.js
const test = require('node:test');
const assert = require('node:assert');
const { mintToken, hashToken, verifyToken } = require('../../lib/inkd-tokens');

test('mintToken returns 64-char hex string', () => {
  const t = mintToken();
  assert.strictEqual(t.length, 64);
  assert.match(t, /^[0-9a-f]{64}$/);
});

test('mintToken returns a different value each call', () => {
  const a = mintToken();
  const b = mintToken();
  assert.notStrictEqual(a, b);
});

test('hashToken produces a bcrypt hash of the token', async () => {
  const t = mintToken();
  const h = await hashToken(t);
  assert.ok(h.startsWith('$2'));
  assert.ok(h.length >= 50);
});

test('verifyToken returns true for matching token + hash', async () => {
  const t = mintToken();
  const h = await hashToken(t);
  assert.strictEqual(await verifyToken(t, h), true);
});

test('verifyToken returns false for mismatched token', async () => {
  const t = mintToken();
  const h = await hashToken(t);
  const t2 = mintToken();
  assert.strictEqual(await verifyToken(t2, h), false);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd propspot-os && node --test tests/inkd/tokens.test.js`
Expected: failure with `Cannot find module '../../lib/inkd-tokens'`.

- [ ] **Step 3: Implement the helper**

```js
// propspot-os/lib/inkd-tokens.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashToken(token) {
  return bcrypt.hash(token, 10);
}

async function verifyToken(token, hash) {
  return bcrypt.compare(token, hash);
}

module.exports = { mintToken, hashToken, verifyToken };
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `cd propspot-os && node --test tests/inkd/tokens.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
cd propspot-os
git add lib/inkd-tokens.js tests/inkd/tokens.test.js
git commit -m "feat(inkd): magic-link token mint/hash/verify helper"
```

### Task 1.3: Audit logger

**Files:**
- Create: `propspot-os/lib/inkd-audit.js`

This module writes rows to `inkd_audit_events`. It's pure I/O against Postgres, so no node:test — manual verification via a query at the end.

- [ ] **Step 1: Implement the logger**

```js
// propspot-os/lib/inkd-audit.js
const { query } = require('../db');

const VALID_EVENTS = new Set([
  'created','sent','viewed','started','field_filled',
  'signed','declined','reminder_sent','voided','expired',
  'filed_to_property'
]);

function ipFromReq(req) {
  if (!req) return null;
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket?.remoteAddress || null;
}

async function logAudit({ envelopeId, recipientId = null, eventType, req = null, userId = null, details = null }) {
  if (!envelopeId) throw new Error('logAudit: envelopeId is required');
  if (!VALID_EVENTS.has(eventType)) throw new Error(`logAudit: unknown event_type ${eventType}`);
  const ip = ipFromReq(req);
  const ua = req?.headers['user-agent'] || null;
  await query(
    `INSERT INTO inkd_audit_events (envelope_id, recipient_id, event_type, ip, user_agent, user_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [envelopeId, recipientId, eventType, ip, ua, userId, details ? JSON.stringify(details) : null]
  );
}

module.exports = { logAudit };
```

- [ ] **Step 2: Manually verify it writes a row**

Run from `propspot-os/`:
```bash
node -e "
const { logAudit } = require('./lib/inkd-audit');
const { query } = require('./db');
(async () => {
  // Use an existing envelope id if you have one, else skip this manual step.
  const { rows } = await query('SELECT id FROM inkd_envelopes LIMIT 1');
  if (!rows[0]) { console.log('no envelopes yet — skip manual audit test'); process.exit(0); }
  await logAudit({ envelopeId: rows[0].id, eventType: 'created', details: { source: 'manual smoke test' } });
  const { rows: events } = await query('SELECT * FROM inkd_audit_events WHERE envelope_id=\$1 ORDER BY event_at DESC LIMIT 1', [rows[0].id]);
  console.log(events[0]);
  process.exit(0);
})();
"
```
Expected: one row printed with `event_type: 'created'`.

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add lib/inkd-audit.js
git commit -m "feat(inkd): audit logger writing to inkd_audit_events"
```

### Task 1.4: Autofill resolver

**Files:**
- Create: `propspot-os/lib/inkd-autofill.js`
- Create: `propspot-os/tests/inkd/autofill.test.js`

The resolver takes an `autofill_source` path like `property.address` or `recipient.buyer.full_name` and resolves it against a context object containing property, opportunity, contact, sender user, and recipients-by-role.

- [ ] **Step 1: Write the failing tests**

```js
// propspot-os/tests/inkd/autofill.test.js
const test = require('node:test');
const assert = require('node:assert');
const { resolvePath } = require('../../lib/inkd-autofill');

const ctx = {
  property:    { address: '123 Main St', city: 'Tampa', state: 'FL', zip: '33602' },
  opportunity: { purchase_price: 250000, closing_date: '2026-07-01' },
  user:        { full_name: 'Jordan Shutts', email: 'jordan@example.com' },
  recipients:  { buyer: { full_name: 'Alice Buyer', email: 'a@b.com' },
                 seller: { full_name: 'Bob Seller' } },
  today:       '2026-05-26',
  today_long:  'May 26, 2026',
  envelope:    { id: 'env-1' },
};

test('resolves a simple property path', () => {
  assert.strictEqual(resolvePath('property.address', ctx), '123 Main St');
});

test('resolves an opportunity numeric value as string', () => {
  assert.strictEqual(resolvePath('opportunity.purchase_price', ctx), '250000');
});

test('resolves a nested recipient-by-role path', () => {
  assert.strictEqual(resolvePath('recipient.buyer.full_name', ctx), 'Alice Buyer');
});

test('resolves user path', () => {
  assert.strictEqual(resolvePath('user.full_name', ctx), 'Jordan Shutts');
});

test('resolves computed today path', () => {
  assert.strictEqual(resolvePath('today', ctx), '2026-05-26');
});

test('returns null for unknown root', () => {
  assert.strictEqual(resolvePath('unknown.foo', ctx), null);
});

test('returns null for missing leaf', () => {
  assert.strictEqual(resolvePath('property.parcel_id', ctx), null);
});

test('returns null for recipient role not present', () => {
  assert.strictEqual(resolvePath('recipient.witness.full_name', ctx), null);
});

test('returns null for null / empty path', () => {
  assert.strictEqual(resolvePath('', ctx), null);
  assert.strictEqual(resolvePath(null, ctx), null);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd propspot-os && node --test tests/inkd/autofill.test.js`
Expected: failure with `Cannot find module '../../lib/inkd-autofill'`.

- [ ] **Step 3: Implement the resolver**

```js
// propspot-os/lib/inkd-autofill.js
// Resolves an autofill_source string against a context object.
//
// Recognized roots:
//   property.<col>
//   opportunity.<col>
//   contact.<col>          (the contact_id on the envelope, if any)
//   user.<col>             (the sender / current user)
//   recipient.<role>.<col> (looks up ctx.recipients[role][col])
//   today                  ISO date string YYYY-MM-DD
//   today_long             "May 26, 2026"
//   envelope.id            UUID

function resolvePath(path, ctx) {
  if (!path || typeof path !== 'string') return null;
  const parts = path.split('.');
  const root = parts[0];

  if (root === 'today')      return ctx.today ?? null;
  if (root === 'today_long') return ctx.today_long ?? null;

  if (root === 'envelope' && parts[1] === 'id') return ctx.envelope?.id ?? null;

  if (root === 'recipient') {
    const role = parts[1];
    const col  = parts[2];
    if (!role || !col) return null;
    const r = ctx.recipients?.[role];
    if (!r || r[col] == null) return null;
    return String(r[col]);
  }

  if (['property','opportunity','contact','user'].includes(root)) {
    const obj = ctx[root];
    const col = parts[1];
    if (!obj || !col || obj[col] == null) return null;
    return String(obj[col]);
  }

  return null;
}

// Resolve every template field's autofill_source against the same ctx.
// Returns { [template_field_id]: resolved_value_or_null }
function resolveAllFields(templateFields, ctx) {
  const out = {};
  for (const f of templateFields) {
    out[f.id] = f.autofill_source ? resolvePath(f.autofill_source, ctx) : null;
  }
  return out;
}

module.exports = { resolvePath, resolveAllFields };
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd propspot-os && node --test tests/inkd/autofill.test.js`
Expected: `# pass 9`.

- [ ] **Step 5: Commit**

```bash
cd propspot-os
git add lib/inkd-autofill.js tests/inkd/autofill.test.js
git commit -m "feat(inkd): autofill path resolver"
```

### Task 1.5: Document the autofill source library (a reference users will see in the editor)

**Files:**
- Create: `propspot-os/lib/inkd-autofill-sources.js`

The template editor needs a list of every available autofill path to show in a dropdown.

- [ ] **Step 1: Implement the source list**

```js
// propspot-os/lib/inkd-autofill-sources.js
// Static list of autofill source paths available in the template editor.
// Add new entries here when extending the data model.

const SOURCES = [
  { group: 'Property', paths: [
    { value: 'property.address',  label: 'Property — Street address' },
    { value: 'property.city',     label: 'Property — City' },
    { value: 'property.state',    label: 'Property — State' },
    { value: 'property.zip',      label: 'Property — ZIP' },
    { value: 'property.parcel_id',label: 'Property — Parcel ID' },
    { value: 'property.year_built', label: 'Property — Year built' },
    { value: 'property.square_feet', label: 'Property — Square feet' },
    { value: 'property.beds',     label: 'Property — Bedrooms' },
    { value: 'property.baths',    label: 'Property — Bathrooms' },
  ]},
  { group: 'Opportunity', paths: [
    { value: 'opportunity.purchase_price',         label: 'Opportunity — Purchase price' },
    { value: 'opportunity.earnest_money',          label: 'Opportunity — Earnest money' },
    { value: 'opportunity.closing_date',           label: 'Opportunity — Closing date' },
    { value: 'opportunity.contingency_period_days',label: 'Opportunity — Contingency period (days)' },
  ]},
  { group: 'Contact (per-role)', paths: [
    { value: 'recipient.buyer.full_name',  label: 'Buyer — Full name' },
    { value: 'recipient.buyer.email',      label: 'Buyer — Email' },
    { value: 'recipient.buyer.phone',      label: 'Buyer — Phone' },
    { value: 'recipient.seller.full_name', label: 'Seller — Full name' },
    { value: 'recipient.seller.email',     label: 'Seller — Email' },
    { value: 'recipient.seller.phone',     label: 'Seller — Phone' },
    { value: 'recipient.agent.full_name',  label: 'Agent — Full name' },
    { value: 'recipient.agent.email',      label: 'Agent — Email' },
    { value: 'recipient.witness.full_name',label: 'Witness — Full name' },
  ]},
  { group: 'Current user / sender', paths: [
    { value: 'user.full_name', label: 'Sender — Full name' },
    { value: 'user.email',     label: 'Sender — Email' },
  ]},
  { group: 'Computed', paths: [
    { value: 'today',      label: "Today's date (ISO)" },
    { value: 'today_long', label: "Today's date (May 26, 2026)" },
    { value: 'envelope.id',label: 'Envelope ID' },
  ]},
];

module.exports = { SOURCES };
```

- [ ] **Step 2: Smoke test that the list is importable**

Run: `cd propspot-os && node -e "console.log(require('./lib/inkd-autofill-sources').SOURCES.length + ' groups')"`
Expected: `5 groups`.

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add lib/inkd-autofill-sources.js
git commit -m "feat(inkd): autofill source library for the template editor"
```

---

## Phase 2 — Templates (upload + field editor)

Goal: by end of phase, a user can upload a PDF, drag fields onto pages, save as a template, and re-open it for editing. Auto-fill sources are tagged per field.

### Task 2.1: Templates router skeleton + mount

**Files:**
- Create: `propspot-os/routes/inkd/templates.js`
- Modify: `propspot-os/server.js` (mount router)

- [ ] **Step 1: Create the router skeleton**

```js
// propspot-os/routes/inkd/templates.js
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { SOURCES } = require('../../lib/inkd-autofill-sources');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 30 * 1024 * 1024 }  // 30 MB PDFs allowed
});

// GET /api/inkd/templates  — list (non-archived)
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, category, description, page_count, created_at, updated_at
         FROM inkd_templates
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list templates' }); }
});

// GET /api/inkd/templates/autofill-sources  — return the dropdown list
router.get('/autofill-sources', (_req, res) => res.json(SOURCES));

// GET /api/inkd/templates/:id  — full template with fields
router.get('/:id', async (req, res) => {
  try {
    const t = await query('SELECT * FROM inkd_templates WHERE id=$1', [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const f = await query(
      `SELECT * FROM inkd_template_fields
        WHERE template_id=$1
        ORDER BY page_number, display_order`, [req.params.id]);
    res.json({ ...t.rows[0], fields: f.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load template' }); }
});

// POST /api/inkd/templates  — create a new template by uploading a PDF
// multipart: file (pdf), name, category, description
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file required' });
  const { name, category, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    // Count pages from the PDF using pdf-lib (server-side, cheap)
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pageCount = pdfDoc.getPageCount();

    const cloud = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'raw', folder: 'propspot/inkd/templates', format: 'pdf' },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    const { rows } = await query(
      `INSERT INTO inkd_templates
        (name, category, description, source_pdf_url, source_pdf_id, page_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [name, category || null, description || null, cloud.secure_url, cloud.public_id, pageCount, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PATCH /api/inkd/templates/:id  — update name/category/description
router.patch('/:id', async (req, res) => {
  const { name, category, description } = req.body;
  try {
    const { rows } = await query(
      `UPDATE inkd_templates
          SET name=COALESCE($2,name),
              category=COALESCE($3,category),
              description=COALESCE($4,description),
              updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [req.params.id, name, category, description]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update template' }); }
});

// DELETE /api/inkd/templates/:id  — soft archive
router.delete('/:id', async (req, res) => {
  try {
    await query('UPDATE inkd_templates SET archived_at=now() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to archive template' }); }
});

// PUT /api/inkd/templates/:id/fields  — replace the full field set for a template
router.put('/:id/fields', async (req, res) => {
  const fields = Array.isArray(req.body.fields) ? req.body.fields : null;
  if (!fields) return res.status(400).json({ error: 'fields array required' });
  try {
    await query('DELETE FROM inkd_template_fields WHERE template_id=$1', [req.params.id]);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await query(
        `INSERT INTO inkd_template_fields
          (template_id, page_number, x_pct, y_pct, width_pct, height_pct,
           field_type, label, recipient_role, required, autofill_source, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.params.id, f.page_number, f.x_pct, f.y_pct, f.width_pct, f.height_pct,
         f.field_type, f.label || null, f.recipient_role || null,
         f.required !== false, f.autofill_source || null, i]
      );
    }
    await query('UPDATE inkd_templates SET updated_at=now() WHERE id=$1', [req.params.id]);
    const { rows } = await query(
      'SELECT * FROM inkd_template_fields WHERE template_id=$1 ORDER BY page_number, display_order',
      [req.params.id]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save fields' }); }
});

module.exports = router;
```

- [ ] **Step 2: Mount the router in server.js**

Find the section of `propspot-os/server.js` where other routers are mounted (look for `app.use('/api/property-files'`). Add this line in the same block:

```js
app.use('/api/inkd/templates', require('./routes/inkd/templates'));
```

- [ ] **Step 3: Smoke test the list endpoint**

Start the server: `cd propspot-os && npm run dev`
In another terminal: `curl -s -H "Cookie: <your_jwt_cookie>" http://localhost:3000/api/inkd/templates`
Expected: `[]` (empty array — no templates yet).

If the cookie/JWT approach doesn't work in your env, use the preview-server: `cd propspot-os && node preview-server.js` and `curl http://localhost:3000/api/inkd/templates` (preview-server bypasses auth).

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add routes/inkd/templates.js server.js
git commit -m "feat(inkd): templates router with CRUD + autofill-sources endpoint"
```

### Task 2.2: Template editor UI page

**Files:**
- Create: `propspot-os/public/inkd-template-editor.html`
- Create: `propspot-os/public/inkd-template-editor.js`
- Create: `propspot-os/public/inkd-template-editor.css`

This is the largest UI piece. It uses PDF.js to render the PDF, lets the user drag rectangles onto pages, and saves them via the PUT endpoint above.

- [ ] **Step 1: Create the HTML scaffold**

```html
<!-- propspot-os/public/inkd-template-editor.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ink'd Template Editor</title>
<link rel="stylesheet" href="/chrome.css">
<link rel="stylesheet" href="/inkd-template-editor.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
</head>
<body class="inkd-editor">
  <header class="inkd-editor-header">
    <a class="back" href="/inkd.html">← Ink'd</a>
    <input id="tpl-name" placeholder="Template name (e.g., Purchase Agreement — FL)">
    <select id="tpl-category">
      <option value="">No category</option>
      <option value="purchase-agreement">Purchase Agreement</option>
      <option value="disclosure">Disclosure</option>
      <option value="addendum">Addendum</option>
      <option value="listing-agreement">Listing Agreement</option>
      <option value="other">Other</option>
    </select>
    <button id="btn-save">Save</button>
  </header>

  <aside class="inkd-editor-toolbox">
    <h3>Fields</h3>
    <p>Click a field type, then click-and-drag on the PDF to place it.</p>
    <button class="field-btn" data-type="text">Text</button>
    <button class="field-btn" data-type="signature">Signature</button>
    <button class="field-btn" data-type="initial">Initial</button>
    <button class="field-btn" data-type="date">Date</button>
    <button class="field-btn" data-type="checkbox">Checkbox</button>

    <h3>Selected field</h3>
    <div id="selected-empty" class="muted">Click a field on the PDF to edit it.</div>
    <div id="selected-form" hidden>
      <label>Label <input id="f-label"></label>
      <label>Recipient role
        <select id="f-role">
          <option value="">(no recipient)</option>
          <option value="buyer">Buyer</option>
          <option value="seller">Seller</option>
          <option value="agent">Agent</option>
          <option value="witness">Witness</option>
        </select>
      </label>
      <label>Autofill source
        <select id="f-autofill"></select>
      </label>
      <label><input type="checkbox" id="f-required" checked> Required</label>
      <button id="btn-delete-field">Delete field</button>
    </div>
  </aside>

  <main id="pdf-stage"><div id="upload-prompt">
    <input type="file" id="pdf-upload" accept="application/pdf">
    <p>Upload a PDF to start.</p>
  </div></main>

  <script src="/inkd-template-editor.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create the CSS**

```css
/* propspot-os/public/inkd-template-editor.css */
body.inkd-editor { display: grid; grid-template-columns: 280px 1fr; grid-template-rows: 56px 1fr; height: 100vh; margin: 0; font-family: system-ui, sans-serif; }
.inkd-editor-header { grid-column: 1 / span 2; display: flex; gap: 12px; align-items: center; padding: 0 16px; border-bottom: 1px solid #e3e3e3; background: #fff; }
.inkd-editor-header input, .inkd-editor-header select { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; }
.inkd-editor-header #btn-save { margin-left: auto; padding: 8px 16px; background: #2563eb; color: white; border: 0; border-radius: 4px; cursor: pointer; }
.inkd-editor-toolbox { padding: 16px; border-right: 1px solid #e3e3e3; overflow-y: auto; }
.inkd-editor-toolbox h3 { margin-top: 0; font-size: 13px; text-transform: uppercase; color: #666; }
.field-btn { display: block; width: 100%; padding: 8px; margin-bottom: 4px; background: #f3f4f6; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; text-align: left; }
.field-btn.active { background: #dbeafe; border-color: #2563eb; }
#pdf-stage { overflow: auto; background: #f5f6f8; padding: 24px; position: relative; }
.pdf-page { position: relative; margin: 0 auto 16px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
.pdf-page canvas { display: block; }
.pdf-field { position: absolute; border: 2px solid #2563eb; background: rgba(37,99,235,.12); cursor: move; font-size: 11px; color: #1e40af; padding: 2px 4px; box-sizing: border-box; }
.pdf-field.selected { outline: 2px solid #f59e0b; }
.pdf-field .resize-handle { position: absolute; right: -4px; bottom: -4px; width: 8px; height: 8px; background: #2563eb; cursor: nwse-resize; }
.muted { color: #888; font-size: 12px; }
#selected-form label { display: block; margin: 8px 0; font-size: 12px; }
#selected-form input[type=text], #selected-form select { width: 100%; padding: 4px; }
#btn-delete-field { background: #ef4444; color: white; border: 0; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-top: 8px; }
#upload-prompt { text-align: center; padding: 80px 20px; color: #666; }
```

- [ ] **Step 3: Create the JS — Part 1, PDF rendering**

```js
// propspot-os/public/inkd-template-editor.js
const params = new URLSearchParams(location.search);
const templateId = params.get('id'); // null = new template

const state = {
  template: null,           // template row from server (set on load or after save)
  fields: [],               // [{ id?, page_number, x_pct, y_pct, width_pct, height_pct, field_type, label, recipient_role, required, autofill_source }]
  selectedFieldIndex: null,
  toolMode: null,           // 'text' | 'signature' | 'initial' | 'date' | 'checkbox' | null
  pages: [],                // [{ pageNum, width, height, container }]
  autofillSources: [],      // groups from server
  pdfBytes: null,           // ArrayBuffer if a new PDF was just uploaded but not saved yet
};

async function init() {
  // Load autofill sources for the dropdown
  const ar = await fetch('/api/inkd/templates/autofill-sources');
  state.autofillSources = await ar.json();
  populateAutofillDropdown();

  if (templateId) {
    const r = await fetch(`/api/inkd/templates/${templateId}`);
    if (!r.ok) { alert('Template not found'); return; }
    state.template = await r.json();
    document.getElementById('tpl-name').value = state.template.name;
    document.getElementById('tpl-category').value = state.template.category || '';
    state.fields = state.template.fields || [];
    await loadAndRenderPdf(state.template.source_pdf_url);
  } else {
    document.getElementById('pdf-upload').addEventListener('change', onPdfPicked);
  }

  document.querySelectorAll('.field-btn').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.type)));
  document.getElementById('btn-save').addEventListener('click', save);
  document.getElementById('btn-delete-field').addEventListener('click', deleteSelectedField);
  ['f-label','f-role','f-autofill','f-required'].forEach(id =>
    document.getElementById(id).addEventListener('change', applySelectedFieldEdits));
}

function populateAutofillDropdown() {
  const sel = document.getElementById('f-autofill');
  sel.innerHTML = '<option value="">(no autofill)</option>';
  for (const grp of state.autofillSources) {
    const og = document.createElement('optgroup');
    og.label = grp.group;
    for (const p of grp.paths) {
      const o = document.createElement('option');
      o.value = p.value; o.textContent = p.label;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

async function onPdfPicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  state.pdfBytes = await file.arrayBuffer();
  document.getElementById('upload-prompt').remove();
  const dataUrl = URL.createObjectURL(file);
  await renderPdfFromUrl(dataUrl);
}

async function loadAndRenderPdf(url) {
  document.querySelector('#upload-prompt')?.remove();
  await renderPdfFromUrl(url);
}

async function renderPdfFromUrl(url) {
  const stage = document.getElementById('pdf-stage');
  stage.querySelectorAll('.pdf-page').forEach(n => n.remove());
  state.pages = [];

  const pdf = await pdfjsLib.getDocument(url).promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const container = document.createElement('div');
    container.className = 'pdf-page';
    container.dataset.pageNumber = p;
    container.style.width  = viewport.width + 'px';
    container.style.height = viewport.height + 'px';
    stage.appendChild(container);

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    state.pages.push({ pageNum: p, width: viewport.width, height: viewport.height, container });
    wireFieldPlacement(container, p);
  }
  renderAllFields();
}

init();
```

- [ ] **Step 4: Create the JS — Part 2, field placement + selection**

Append this to the same file `propspot-os/public/inkd-template-editor.js`:

```js
function setTool(type) {
  document.querySelectorAll('.field-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  state.toolMode = type;
}

function wireFieldPlacement(pageEl, pageNumber) {
  let dragStart = null;
  let dragRect = null;
  pageEl.addEventListener('mousedown', (e) => {
    if (!state.toolMode) return;
    if (e.target !== pageEl && e.target.tagName !== 'CANVAS') return;
    const rect = pageEl.getBoundingClientRect();
    dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragRect = document.createElement('div');
    dragRect.className = 'pdf-field';
    dragRect.style.left = dragStart.x + 'px';
    dragRect.style.top  = dragStart.y + 'px';
    pageEl.appendChild(dragRect);
    e.preventDefault();
  });
  pageEl.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    const rect = pageEl.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    dragRect.style.left   = Math.min(x, dragStart.x) + 'px';
    dragRect.style.top    = Math.min(y, dragStart.y) + 'px';
    dragRect.style.width  = Math.abs(x - dragStart.x) + 'px';
    dragRect.style.height = Math.abs(y - dragStart.y) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragStart || !dragRect) { dragStart = null; return; }
    const pageInfo = state.pages.find(p => p.pageNum === pageNumber);
    const x = parseFloat(dragRect.style.left), y = parseFloat(dragRect.style.top);
    const w = parseFloat(dragRect.style.width) || 80, h = parseFloat(dragRect.style.height) || 24;
    const field = {
      page_number: pageNumber,
      x_pct: x / pageInfo.width,
      y_pct: y / pageInfo.height,
      width_pct: w / pageInfo.width,
      height_pct: h / pageInfo.height,
      field_type: state.toolMode,
      label: defaultLabelForType(state.toolMode),
      recipient_role: null,
      required: true,
      autofill_source: null,
    };
    dragRect.remove();
    state.fields.push(field);
    state.selectedFieldIndex = state.fields.length - 1;
    setTool(null);
    renderAllFields();
    showSelectedForm();
    dragStart = null; dragRect = null;
  });
}

function defaultLabelForType(t) {
  return { text: 'Text', signature: 'Signature', initial: 'Initial', date: 'Date', checkbox: 'Checkbox' }[t] || t;
}

function renderAllFields() {
  for (const page of state.pages) {
    page.container.querySelectorAll('.pdf-field').forEach(n => n.remove());
  }
  state.fields.forEach((f, i) => {
    const page = state.pages.find(p => p.pageNum === f.page_number);
    if (!page) return;
    const div = document.createElement('div');
    div.className = 'pdf-field' + (i === state.selectedFieldIndex ? ' selected' : '');
    div.style.left   = (f.x_pct * page.width) + 'px';
    div.style.top    = (f.y_pct * page.height) + 'px';
    div.style.width  = (f.width_pct * page.width) + 'px';
    div.style.height = (f.height_pct * page.height) + 'px';
    div.textContent  = (f.label || f.field_type) + (f.recipient_role ? ` (${f.recipient_role})` : '');
    div.addEventListener('click', (e) => { e.stopPropagation(); state.selectedFieldIndex = i; renderAllFields(); showSelectedForm(); });
    page.container.appendChild(div);
  });
}

function showSelectedForm() {
  const i = state.selectedFieldIndex;
  const isOpen = i != null && state.fields[i];
  document.getElementById('selected-empty').hidden = isOpen;
  document.getElementById('selected-form').hidden = !isOpen;
  if (!isOpen) return;
  const f = state.fields[i];
  document.getElementById('f-label').value = f.label || '';
  document.getElementById('f-role').value = f.recipient_role || '';
  document.getElementById('f-autofill').value = f.autofill_source || '';
  document.getElementById('f-required').checked = f.required !== false;
}

function applySelectedFieldEdits() {
  const i = state.selectedFieldIndex; if (i == null) return;
  const f = state.fields[i];
  f.label = document.getElementById('f-label').value || null;
  f.recipient_role = document.getElementById('f-role').value || null;
  f.autofill_source = document.getElementById('f-autofill').value || null;
  f.required = document.getElementById('f-required').checked;
  renderAllFields();
}

function deleteSelectedField() {
  const i = state.selectedFieldIndex; if (i == null) return;
  state.fields.splice(i, 1);
  state.selectedFieldIndex = null;
  renderAllFields();
  showSelectedForm();
}
```

- [ ] **Step 5: Create the JS — Part 3, save**

Append this to the same file:

```js
async function save() {
  const name = document.getElementById('tpl-name').value.trim();
  const category = document.getElementById('tpl-category').value;
  if (!name) { alert('Template name is required'); return; }

  // Step A: if new template, upload the PDF + create the template
  if (!state.template) {
    if (!state.pdfBytes) { alert('Upload a PDF first'); return; }
    const fd = new FormData();
    fd.append('file', new Blob([state.pdfBytes], { type: 'application/pdf' }), 'template.pdf');
    fd.append('name', name);
    fd.append('category', category);
    const r = await fetch('/api/inkd/templates', { method: 'POST', body: fd });
    if (!r.ok) { alert('Failed to upload PDF'); return; }
    state.template = await r.json();
    history.replaceState({}, '', `?id=${state.template.id}`);
  } else {
    await fetch(`/api/inkd/templates/${state.template.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, category }),
    });
  }

  // Step B: save fields
  const r2 = await fetch(`/api/inkd/templates/${state.template.id}/fields`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: state.fields }),
  });
  if (!r2.ok) { alert('Failed to save fields'); return; }
  alert('Template saved');
}
```

- [ ] **Step 6: Manual verification**

1. Start the server (`npm run dev` from `propspot-os/`)
2. Sign in to PropSpot normally
3. Navigate to `http://localhost:3000/inkd-template-editor.html`
4. Upload any PDF (a sample purchase agreement works)
5. Click "Text", click-and-drag a rectangle on page 1 → field appears
6. Edit its label to "Property Address", set autofill to "Property — Street address"
7. Add a Signature field, set role to "Buyer"
8. Type a template name and click Save → expect "Template saved"
9. Reload the page (with `?id=...` now in URL) → fields persist, positions match

- [ ] **Step 7: Commit**

```bash
cd propspot-os
git add public/inkd-template-editor.html public/inkd-template-editor.js public/inkd-template-editor.css
git commit -m "feat(inkd): template editor UI — upload PDF, drag fields, save"
```

---

## Phase 3 — Envelopes (composer + autofill draft)

Goal: by end of phase, a user can start a new envelope from a template + property combo, see autofilled values, edit them, add recipients, save as draft. Sending is in phase 4.

### Task 3.1: Envelopes router (create draft + autofill)

**Files:**
- Create: `propspot-os/routes/inkd/envelopes.js`
- Modify: `propspot-os/server.js` (mount router)

- [ ] **Step 1: Implement the router**

```js
// propspot-os/routes/inkd/envelopes.js
const express = require('express');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { resolvePath } = require('../../lib/inkd-autofill');
const { logAudit } = require('../../lib/inkd-audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/inkd/envelopes  — list with filters (lane)
// Query: ?status=draft|sent|partial|completed|voided|expired&filed=true|false
router.get('/', async (req, res) => {
  const { status, filed } = req.query;
  const args = [];
  const where = ['1=1'];
  if (status)               { args.push(status);             where.push(`status = $${args.length}`); }
  if (filed === 'true')     {                                where.push(`filed_at IS NOT NULL`); }
  else if (filed === 'false'){                               where.push(`filed_at IS NULL`); }
  try {
    const { rows } = await query(
      `SELECT e.*, p.address AS property_address, t.name AS template_name
         FROM inkd_envelopes e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN inkd_templates t ON t.id = e.template_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT 200`,
      args);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list envelopes' }); }
});

// GET /api/inkd/envelopes/:id  — full envelope with recipients + field_values
router.get('/:id', async (req, res) => {
  try {
    const e = await query('SELECT * FROM inkd_envelopes WHERE id=$1', [req.params.id]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Envelope not found' });
    const r = await query('SELECT id, role, full_name, email, phone, contact_id, signing_order, status, notified_at, viewed_at, signed_at FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order', [req.params.id]);
    const v = await query('SELECT * FROM inkd_field_values WHERE envelope_id=$1', [req.params.id]);
    res.json({ ...e.rows[0], recipients: r.rows, field_values: v.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load envelope' }); }
});

// POST /api/inkd/envelopes  — create draft (from a template + optional property/opportunity/contact)
// body: { template_id, property_id?, opportunity_id?, contact_id?, name? }
router.post('/', async (req, res) => {
  const { template_id, property_id, opportunity_id, contact_id, name } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  try {
    const t = await query('SELECT * FROM inkd_templates WHERE id=$1 AND archived_at IS NULL', [template_id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const tpl = t.rows[0];

    // Pull entity rows for autofill context
    const ctx = await buildAutofillContext({ property_id, opportunity_id, contact_id, userId: req.user.id });
    const fields = (await query('SELECT * FROM inkd_template_fields WHERE template_id=$1', [template_id])).rows;

    // Default envelope name
    let envName = name;
    if (!envName) {
      envName = ctx.property?.address ? `${tpl.name} — ${ctx.property.address}` : tpl.name;
    }

    const env = (await query(
      `INSERT INTO inkd_envelopes
         (template_id, source_pdf_url, source_pdf_id, page_count, name,
          property_id, opportunity_id, contact_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [template_id, tpl.source_pdf_url, tpl.source_pdf_id, tpl.page_count, envName,
       property_id || null, opportunity_id || null, contact_id || null, req.user.id])).rows[0];

    // Seed field_values with snapshotted coords + autofill where available
    for (const f of fields) {
      const value = f.autofill_source ? resolvePath(f.autofill_source, ctx) : null;
      await query(
        `INSERT INTO inkd_field_values
           (envelope_id, template_field_id, page_number,
            x_pct, y_pct, width_pct, height_pct,
            field_type, label, recipient_id, value, value_filled_at, value_filled_by, autofilled)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12,$13)`,
        [env.id, f.id, f.page_number,
         f.x_pct, f.y_pct, f.width_pct, f.height_pct,
         f.field_type, f.label,
         value, value ? new Date() : null, value ? req.user.id : null, !!value]);
    }

    await logAudit({ envelopeId: env.id, eventType: 'created', req, userId: req.user.id });
    res.status(201).json(env);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create envelope' }); }
});

// PATCH /api/inkd/envelopes/:id  — update name, reminders, expiry (only while draft)
router.patch('/:id', async (req, res) => {
  const { name, reminders_enabled, reminder_schedule, expires_at } = req.body;
  try {
    const e = await query('SELECT status FROM inkd_envelopes WHERE id=$1', [req.params.id]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (e.rows[0].status !== 'draft') return res.status(400).json({ error: 'Can only edit drafts' });
    const { rows } = await query(
      `UPDATE inkd_envelopes
          SET name = COALESCE($2, name),
              reminders_enabled = COALESCE($3, reminders_enabled),
              reminder_schedule = COALESCE($4::jsonb, reminder_schedule),
              expires_at = COALESCE($5, expires_at)
        WHERE id=$1
        RETURNING *`,
      [req.params.id, name, reminders_enabled,
       reminder_schedule ? JSON.stringify(reminder_schedule) : null,
       expires_at]);
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update envelope' }); }
});

// PUT /api/inkd/envelopes/:id/field-values  — update field values (during composition)
// body: { values: [{ id, value }] }
router.put('/:id/field-values', async (req, res) => {
  const items = Array.isArray(req.body.values) ? req.body.values : null;
  if (!items) return res.status(400).json({ error: 'values array required' });
  try {
    for (const it of items) {
      await query(
        `UPDATE inkd_field_values
            SET value=$2, value_filled_at=now(), value_filled_by=$3, autofilled=FALSE
          WHERE id=$1 AND envelope_id=$4`,
        [it.id, it.value ?? null, req.user.id, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update field values' }); }
});

// POST /api/inkd/envelopes/:id/void  — manual void by sender
router.post('/:id/void', async (req, res) => {
  try {
    await query(`UPDATE inkd_envelopes SET status='voided' WHERE id=$1`, [req.params.id]);
    await logAudit({ envelopeId: req.params.id, eventType: 'voided', req, userId: req.user.id, details: { reason: req.body?.reason || null } });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to void' }); }
});

async function buildAutofillContext({ property_id, opportunity_id, contact_id, userId }) {
  const ctx = { property: null, opportunity: null, contact: null, user: null, recipients: {} };
  if (property_id) {
    const r = await query('SELECT * FROM properties WHERE id=$1', [property_id]);
    ctx.property = r.rows[0] || null;
  }
  if (opportunity_id) {
    const r = await query('SELECT * FROM opportunities WHERE id=$1', [opportunity_id]);
    ctx.opportunity = r.rows[0] || null;
  }
  if (contact_id) {
    const r = await query('SELECT * FROM contacts WHERE id=$1', [contact_id]);
    ctx.contact = r.rows[0] || null;
  }
  if (userId) {
    const r = await query('SELECT id, full_name, email FROM users WHERE id=$1', [userId]);
    ctx.user = r.rows[0] || null;
  }
  const now = new Date();
  ctx.today      = now.toISOString().slice(0, 10);
  ctx.today_long = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return ctx;
}

module.exports = router;
```

- [ ] **Step 2: Mount in server.js**

Add to the same router-mount section of `propspot-os/server.js`:

```js
app.use('/api/inkd/envelopes', require('./routes/inkd/envelopes'));
```

- [ ] **Step 3: Smoke test (assumes Task 2.2 produced at least one template + you have one property in the DB)**

```bash
cd propspot-os
# replace UUIDs / IDs with values you have
node -e "
const { query } = require('./db');
(async () => {
  const tpl = (await query('SELECT id FROM inkd_templates LIMIT 1')).rows[0];
  const prop = (await query('SELECT id FROM properties LIMIT 1')).rows[0];
  if (!tpl || !prop) { console.log('Need at least one template and one property in db'); process.exit(0); }
  console.log({ template_id: tpl.id, property_id: prop.id });
})();
"
# Then POST manually via curl or the composer UI (next task).
```

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add routes/inkd/envelopes.js server.js
git commit -m "feat(inkd): envelopes router — create draft with autofill, update fields, void"
```

### Task 3.2: Recipients router

**Files:**
- Create: `propspot-os/routes/inkd/recipients.js`
- Modify: `propspot-os/server.js`

- [ ] **Step 1: Implement the router**

```js
// propspot-os/routes/inkd/recipients.js
const express = require('express');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { mintToken, hashToken } = require('../../lib/inkd-tokens');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/inkd/envelopes/:envelopeId/recipients
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, role, full_name, email, phone, contact_id, signing_order, status,
              notified_at, viewed_at, signed_at, decline_reason
         FROM inkd_recipients
        WHERE envelope_id=$1
        ORDER BY signing_order`, [req.params.envelopeId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list recipients' }); }
});

// POST /api/inkd/envelopes/:envelopeId/recipients  — add a recipient
// body: { role, full_name, email, phone?, contact_id?, signing_order? }
router.post('/', async (req, res) => {
  const { role, full_name, email, phone, contact_id, signing_order } = req.body;
  if (!role || !full_name || !email) return res.status(400).json({ error: 'role, full_name, email required' });
  try {
    const token = mintToken();
    const hashedToken = await hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days
    const { rows } = await query(
      `INSERT INTO inkd_recipients
         (envelope_id, role, full_name, email, phone, contact_id, signing_order,
          sign_token_hash, sign_token_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, role, full_name, email, phone, contact_id, signing_order, status`,
      [req.params.envelopeId, role, full_name, email, phone || null, contact_id || null,
       signing_order || 1, hashedToken, expiresAt]);
    // Return the clear-text token ONCE so the composer can show preview URL if wanted
    res.status(201).json({ ...rows[0], sign_token: token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add recipient' }); }
});

// PATCH /api/inkd/envelopes/:envelopeId/recipients/:id
router.patch('/:id', async (req, res) => {
  const { role, full_name, email, phone, signing_order } = req.body;
  try {
    const { rows } = await query(
      `UPDATE inkd_recipients
          SET role          = COALESCE($2, role),
              full_name     = COALESCE($3, full_name),
              email         = COALESCE($4, email),
              phone         = COALESCE($5, phone),
              signing_order = COALESCE($6, signing_order)
        WHERE id=$1 AND envelope_id=$7
        RETURNING id, role, full_name, email, phone, signing_order, status`,
      [req.params.id, role, full_name, email, phone, signing_order, req.params.envelopeId]);
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update recipient' }); }
});

// DELETE /api/inkd/envelopes/:envelopeId/recipients/:id  (only while draft)
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM inkd_recipients
                  WHERE id=$1 AND envelope_id=$2
                    AND $2 IN (SELECT id FROM inkd_envelopes WHERE status='draft')`,
      [req.params.id, req.params.envelopeId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete recipient' }); }
});

// PATCH /api/inkd/envelopes/:envelopeId/recipients/:id/assign-fields
// body: { field_value_ids: [uuid, …] }  — assign these fields to this recipient
router.patch('/:id/assign-fields', async (req, res) => {
  const ids = Array.isArray(req.body.field_value_ids) ? req.body.field_value_ids : null;
  if (!ids) return res.status(400).json({ error: 'field_value_ids array required' });
  try {
    await query(
      `UPDATE inkd_field_values
          SET recipient_id=$1
        WHERE envelope_id=$2 AND id = ANY($3::uuid[])`,
      [req.params.id, req.params.envelopeId, ids]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to assign fields' }); }
});

module.exports = router;
```

- [ ] **Step 2: Mount in server.js**

```js
app.use('/api/inkd/envelopes/:envelopeId/recipients', require('./routes/inkd/recipients'));
```

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add routes/inkd/recipients.js server.js
git commit -m "feat(inkd): recipients router with token mint, role assignment, field assignment"
```

### Task 3.3: Envelope composer UI

**Files:**
- Create: `propspot-os/public/inkd-send.html`
- Create: `propspot-os/public/inkd-send.js`

The composer is a single page that handles three entry flows:
- `?template_id=...&property_id=...` (from template + property)
- `?template_id=...&opportunity_id=...` (from template + opportunity)
- `?envelope_id=...` (reopening a draft)

- [ ] **Step 1: Create the HTML**

```html
<!-- propspot-os/public/inkd-send.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ink'd — Send Document</title>
<link rel="stylesheet" href="/chrome.css">
<link rel="stylesheet" href="/inkd-template-editor.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
<style>
  body.inkd-send { display: grid; grid-template-columns: 1fr 340px; grid-template-rows: 56px 1fr; height: 100vh; margin: 0; font-family: system-ui, sans-serif; }
  .inkd-send-header { grid-column: 1 / span 2; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid #e3e3e3; }
  .inkd-send-header h1 { font-size: 15px; margin: 0; }
  .inkd-send-header #btn-send { margin-left: auto; padding: 8px 16px; background: #16a34a; color: white; border: 0; border-radius: 4px; cursor: pointer; }
  .inkd-send-header #btn-draft { padding: 8px 14px; background: #f3f4f6; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; }
  aside.right { padding: 16px; border-left: 1px solid #e3e3e3; overflow-y: auto; }
  aside.right h3 { font-size: 12px; text-transform: uppercase; color: #666; margin-top: 16px; }
  .recip { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; padding: 8px; margin-bottom: 8px; }
  .recip input { width: 100%; margin: 2px 0; padding: 4px; box-sizing: border-box; }
  .field-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 3px; }
  .field-row.highlight-yellow { background: #fef3c7; }
  .field-row input { flex: 1; padding: 4px; }
  .field-row .label { font-size: 11px; color: #666; width: 110px; flex-shrink: 0; }
  #reminders-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee; }
</style>
</head>
<body class="inkd-send">
  <header class="inkd-send-header">
    <a href="/inkd.html">← Ink'd</a>
    <h1 id="env-name">Loading…</h1>
    <button id="btn-draft">Save as draft</button>
    <button id="btn-send">Send</button>
  </header>

  <main id="pdf-stage" style="overflow: auto; background: #f5f6f8; padding: 24px;"></main>

  <aside class="right">
    <h3>Recipients</h3>
    <div id="recipients"></div>
    <button id="btn-add-recip">+ Add recipient</button>

    <h3>Field values</h3>
    <p class="muted" style="font-size:11px">Yellow = missing data. Edit any value here.</p>
    <div id="fields-list"></div>

    <div id="reminders-row">
      <label><input type="checkbox" id="reminders-toggle" checked> Send reminders (day 3 + day 7)</label>
    </div>
  </aside>

  <script src="/inkd-send.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create the JS**

```js
// propspot-os/public/inkd-send.js
const params = new URLSearchParams(location.search);

const state = {
  envelope: null,
  recipients: [],
  fieldValues: [],
  pages: [],
};

async function init() {
  let envId = params.get('envelope_id');
  if (!envId) {
    // Create draft from template + entity
    const body = {
      template_id:   params.get('template_id'),
      property_id:   params.get('property_id'),
      opportunity_id:params.get('opportunity_id'),
      contact_id:    params.get('contact_id'),
    };
    if (!body.template_id) { alert('Missing template_id'); return; }
    const r = await fetch('/api/inkd/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { alert('Failed to create envelope'); return; }
    const env = await r.json();
    envId = env.id;
    history.replaceState({}, '', `?envelope_id=${envId}`);
  }

  await loadEnvelope(envId);
  await renderPdf();
  renderRecipients();
  renderFields();

  document.getElementById('btn-add-recip').addEventListener('click', addRecipient);
  document.getElementById('btn-draft').addEventListener('click', saveDraft);
  document.getElementById('btn-send').addEventListener('click', send);
  document.getElementById('reminders-toggle').addEventListener('change', toggleReminders);
}

async function loadEnvelope(id) {
  const r = await fetch(`/api/inkd/envelopes/${id}`);
  if (!r.ok) { alert('Envelope not found'); return; }
  const e = await r.json();
  state.envelope = e;
  state.recipients = e.recipients || [];
  state.fieldValues = e.field_values || [];
  document.getElementById('env-name').textContent = e.name;
  document.getElementById('reminders-toggle').checked = !!e.reminders_enabled;
}

async function renderPdf() {
  const stage = document.getElementById('pdf-stage');
  stage.innerHTML = '';
  state.pages = [];
  const pdf = await pdfjsLib.getDocument(state.envelope.source_pdf_url).promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const container = document.createElement('div');
    container.className = 'pdf-page';
    container.dataset.pageNumber = p;
    container.style.width = viewport.width + 'px'; container.style.height = viewport.height + 'px';
    stage.appendChild(container);
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    state.pages.push({ pageNum: p, width: viewport.width, height: viewport.height, container });
  }
  drawFieldOverlays();
}

function drawFieldOverlays() {
  for (const fv of state.fieldValues) {
    const page = state.pages.find(p => p.pageNum === fv.page_number);
    if (!page) continue;
    const div = document.createElement('div');
    div.className = 'pdf-field';
    div.style.left   = (fv.x_pct * page.width) + 'px';
    div.style.top    = (fv.y_pct * page.height) + 'px';
    div.style.width  = (fv.width_pct * page.width) + 'px';
    div.style.height = (fv.height_pct * page.height) + 'px';
    div.textContent  = fv.value || (fv.label || fv.field_type);
    if (!fv.value && fv.autofilled === false) div.style.background = 'rgba(245, 158, 11, .2)';
    page.container.appendChild(div);
  }
}

function renderRecipients() {
  const wrap = document.getElementById('recipients');
  wrap.innerHTML = '';
  state.recipients.forEach((r, i) => {
    const div = document.createElement('div'); div.className = 'recip';
    div.innerHTML = `
      <input data-k="full_name" placeholder="Full name" value="${r.full_name || ''}">
      <input data-k="email"     placeholder="Email"     value="${r.email || ''}">
      <input data-k="phone"     placeholder="Phone (optional)" value="${r.phone || ''}">
      <label>Role
        <select data-k="role">
          <option value="buyer"   ${r.role==='buyer' ?'selected':''}>Buyer</option>
          <option value="seller"  ${r.role==='seller'?'selected':''}>Seller</option>
          <option value="agent"   ${r.role==='agent' ?'selected':''}>Agent</option>
          <option value="witness" ${r.role==='witness'?'selected':''}>Witness</option>
        </select>
      </label>
      <label>Order <input type="number" data-k="signing_order" value="${r.signing_order || 1}" min="1" style="width:60px"></label>
      <button data-act="del">Delete</button>`;
    div.querySelectorAll('[data-k]').forEach(inp => {
      inp.addEventListener('change', () => updateRecipient(r.id, inp.dataset.k, inp.value));
    });
    div.querySelector('[data-act=del]').addEventListener('click', () => deleteRecipient(r.id));
    wrap.appendChild(div);
  });
}

function renderFields() {
  const wrap = document.getElementById('fields-list');
  wrap.innerHTML = '';
  state.fieldValues
    .filter(fv => fv.field_type !== 'signature' && fv.field_type !== 'initial')  // signature/initial are recipient-filled, hide from sender editor
    .forEach(fv => {
      const row = document.createElement('div');
      row.className = 'field-row' + ((!fv.value) ? ' highlight-yellow' : '');
      const lbl = fv.label || fv.field_type;
      row.innerHTML = `<div class="label">${lbl}</div>`;
      const input = document.createElement('input');
      input.value = fv.value || '';
      input.addEventListener('change', () => updateFieldValue(fv.id, input.value));
      row.appendChild(input);
      wrap.appendChild(row);
    });
}

async function addRecipient() {
  const r = await fetch(`/api/inkd/envelopes/${state.envelope.id}/recipients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'buyer', full_name: '', email: '', signing_order: state.recipients.length + 1 }),
  });
  if (!r.ok) return alert('Failed');
  const created = await r.json();
  state.recipients.push(created);
  renderRecipients();
}
async function updateRecipient(id, key, value) {
  await fetch(`/api/inkd/envelopes/${state.envelope.id}/recipients/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  const r = state.recipients.find(x => x.id === id);
  if (r) r[key] = value;
}
async function deleteRecipient(id) {
  await fetch(`/api/inkd/envelopes/${state.envelope.id}/recipients/${id}`, { method: 'DELETE' });
  state.recipients = state.recipients.filter(r => r.id !== id);
  renderRecipients();
}
async function updateFieldValue(id, value) {
  await fetch(`/api/inkd/envelopes/${state.envelope.id}/field-values`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: [{ id, value }] }),
  });
  const fv = state.fieldValues.find(x => x.id === id);
  if (fv) { fv.value = value; }
  renderFields();
  // Re-draw the overlay text
  for (const page of state.pages) page.container.querySelectorAll('.pdf-field').forEach(n => n.remove());
  drawFieldOverlays();
}
async function toggleReminders() {
  const v = document.getElementById('reminders-toggle').checked;
  await fetch(`/api/inkd/envelopes/${state.envelope.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reminders_enabled: v }),
  });
}
async function saveDraft() {
  // No-op — every edit already saves. Just acknowledge.
  alert('Draft saved');
}
async function send() {
  if (!state.recipients.length) return alert('Add at least one recipient before sending');
  const missing = state.recipients.find(r => !r.email || !r.full_name);
  if (missing) return alert('Every recipient needs a name + email');
  const r = await fetch(`/api/inkd/envelopes/${state.envelope.id}/send`, { method: 'POST' });
  if (!r.ok) { const j = await r.json().catch(()=>({})); return alert('Send failed: ' + (j.error || r.statusText)); }
  alert('Envelope sent');
  location.href = `/inkd.html?lane=out`;
}

init();
```

- [ ] **Step 3: Manual verification (sending will 404 until Phase 4 — the rest should work)**

1. Open `http://localhost:3000/inkd-send.html?template_id=<UUID>&property_id=<INT>` using values from your DB.
2. The page should load the PDF, show autofilled values in the right rail (any field with `property.*` should be filled), and let you edit them.
3. Add a recipient, set role + email, see it persist on reload.
4. Toggle the reminders checkbox — refresh, observe it persists.

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add public/inkd-send.html public/inkd-send.js
git commit -m "feat(inkd): envelope composer UI"
```

---

## Phase 4 — Send + Public signer page

Goal: after this phase, the sender can click Send, recipients receive email with magic link, click → sign → done. Status progresses draft → sent → partial → completed. PDF flattening + certificate is in Phase 5; here the data flow works but the final PDF isn't generated yet.

### Task 4.1: Email helper for Ink'd

**Files:**
- Create: `propspot-os/lib/inkd-email.js`

- [ ] **Step 1: Implement**

```js
// propspot-os/lib/inkd-email.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

const FROM = process.env.SMTP_FROM || 'no-reply@propspot.io';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function signerUrl(token) {
  return `${APP_URL}/inkd-sign.html?token=${token}`;
}

async function sendInvite({ to, recipientName, envelopeName, senderName, token }) {
  const url = signerUrl(token);
  return transporter.sendMail({
    from: FROM, to,
    subject: `${senderName} sent you "${envelopeName}" to sign`,
    text: `Hi ${recipientName},\n\n${senderName} has sent you a document to review and sign:\n\n${envelopeName}\n\nSign it here: ${url}\n\nThis link will expire in 30 days.`,
    html: `<p>Hi ${recipientName},</p><p>${escapeHtml(senderName)} has sent you a document to review and sign: <strong>${escapeHtml(envelopeName)}</strong>.</p><p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:white;text-decoration:none;border-radius:4px">Review &amp; sign</a></p><p style="color:#666;font-size:12px">This link will expire in 30 days.</p>`,
  });
}

async function sendReminder({ to, recipientName, envelopeName, senderName, token, dayNumber }) {
  const url = signerUrl(token);
  return transporter.sendMail({
    from: FROM, to,
    subject: `Reminder: please sign "${envelopeName}"`,
    text: `Hi ${recipientName},\n\nThis is a friendly reminder that ${senderName} is waiting on your signature for:\n\n${envelopeName}\n\nSign it here: ${url}`,
    html: `<p>Hi ${recipientName},</p><p>This is a friendly reminder that ${escapeHtml(senderName)} is waiting on your signature for <strong>${escapeHtml(envelopeName)}</strong>.</p><p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:white;text-decoration:none;border-radius:4px">Review &amp; sign</a></p>`,
  });
}

async function sendYourTurn({ to, recipientName, envelopeName, senderName, token }) {
  return sendInvite({ to, recipientName, envelopeName, senderName, token });
}

async function sendCompletedToSender({ to, senderName, envelopeName }) {
  return transporter.sendMail({
    from: FROM, to,
    subject: `"${envelopeName}" has been signed by all parties`,
    text: `Hi ${senderName},\n\nAll parties have signed "${envelopeName}". Open Ink'd to review and save the signed copy to Files.`,
    html: `<p>Hi ${escapeHtml(senderName)},</p><p>All parties have signed <strong>${escapeHtml(envelopeName)}</strong>.</p><p>Open Ink'd to review and save the signed copy to the property's Files.</p>`,
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = { sendInvite, sendReminder, sendYourTurn, sendCompletedToSender };
```

- [ ] **Step 2: Commit**

```bash
cd propspot-os
git add lib/inkd-email.js
git commit -m "feat(inkd): email helper (invite, reminder, your-turn, completed)"
```

### Task 4.2: Send endpoint + role binding + sequential turn-flipping

**Files:**
- Modify: `propspot-os/routes/inkd/envelopes.js`

This task ALSO contains the critical role-to-recipient binding pass that links each field_value to its actual recipient (via the role string), and re-resolves any `recipient.*` autofills now that recipients exist.

- [ ] **Step 1: Add send + binding + notify-next handlers**

Add this above the `module.exports = router` line in `propspot-os/routes/inkd/envelopes.js`:

```js
const { sendInvite, sendYourTurn } = require('../../lib/inkd-email');
const { mintToken, hashToken } = require('../../lib/inkd-tokens');
const { resolvePath } = require('../../lib/inkd-autofill');

// Internal: bind field_values to recipients by role + resolve recipient.* autofills.
// Called at send time (and could be called from recipient add/update if we want live binding later).
async function bindFieldsAndResolveRecipientAutofills(envelopeId) {
  // 1. Build a role -> recipient row map
  const recipients = (await query(
    'SELECT id, role, full_name, email, phone FROM inkd_recipients WHERE envelope_id=$1',
    [envelopeId])).rows;
  const byRole = {};
  for (const r of recipients) { byRole[r.role] = r; }

  // 2. Pull template fields (for recipient_role + autofill_source) joined with field_values
  const fields = (await query(
    `SELECT fv.id AS fv_id, fv.value, fv.autofilled,
            tf.recipient_role, tf.autofill_source
       FROM inkd_field_values fv
       LEFT JOIN inkd_template_fields tf ON tf.id = fv.template_field_id
      WHERE fv.envelope_id=$1`, [envelopeId])).rows;

  // 3. For each field: set recipient_id from role; resolve recipient.* autofills if value still empty
  const ctxRecipients = byRole; // shape: { buyer: {...}, seller: {...}, ... }
  const today = new Date();
  const ctxBase = {
    recipients: ctxRecipients,
    today:      today.toISOString().slice(0, 10),
    today_long: today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    envelope:   { id: envelopeId },
  };

  for (const f of fields) {
    const role = f.recipient_role;
    const recipientId = role && byRole[role] ? byRole[role].id : null;

    // Resolve recipient.* autofills (only if value is currently empty / not autofilled with real data)
    let newValue = null;
    if (f.autofill_source && f.autofill_source.startsWith('recipient.') && !f.value) {
      newValue = resolvePath(f.autofill_source, ctxBase);
    }

    if (recipientId || newValue != null) {
      await query(
        `UPDATE inkd_field_values
            SET recipient_id = COALESCE($2, recipient_id),
                value        = COALESCE($3, value),
                autofilled   = CASE WHEN $3 IS NOT NULL THEN TRUE ELSE autofilled END
          WHERE id=$1`,
        [f.fv_id, recipientId, newValue]);
    }
  }
}

// POST /api/inkd/envelopes/:id/send  — kick off the envelope
router.post('/:id/send', async (req, res) => {
  try {
    const env = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [req.params.id])).rows[0];
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'draft') return res.status(400).json({ error: 'Already sent' });

    const recipients = (await query(
      'SELECT * FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order', [req.params.id])).rows;
    if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient' });

    // Bind fields to recipients by role + resolve recipient.* autofills NOW that recipients exist
    await bindFieldsAndResolveRecipientAutofills(req.params.id);

    const sender = (await query('SELECT full_name, email FROM users WHERE id=$1', [env.created_by])).rows[0];

    await query(`UPDATE inkd_envelopes SET status='sent', sent_at=now(),
                  expires_at=COALESCE(expires_at, now() + interval '30 days') WHERE id=$1`,
      [req.params.id]);
    await logAudit({ envelopeId: req.params.id, eventType: 'sent', req, userId: req.user.id });

    const firstOrder = recipients[0].signing_order;
    const firstBatch = recipients.filter(r => r.signing_order === firstOrder);
    for (const r of firstBatch) {
      const newToken = mintToken();
      await query('UPDATE inkd_recipients SET sign_token_hash=$2, notified_at=now(), status=$3 WHERE id=$1',
        [r.id, await hashToken(newToken), 'notified']);
      try {
        await sendInvite({
          to: r.email, recipientName: r.full_name, envelopeName: env.name,
          senderName: sender?.full_name || 'PropSpot user', token: newToken,
        });
      } catch (e) { console.error('Email send failed for', r.email, e); }
    }

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to send envelope' }); }
});

// Internal helper: notify the next batch in sequence after one signs.
// Called by the signing router (Task 4.4) when a recipient finishes.
async function notifyNextBatchIfReady(envelopeId) {
  const env = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [envelopeId])).rows[0];
  if (!env) return;
  const recipients = (await query(
    'SELECT * FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order, id', [envelopeId])).rows;
  // Find lowest order with any non-signed recipients
  const orders = [...new Set(recipients.map(r => r.signing_order))].sort((a, b) => a - b);
  let nextOrder = null;
  for (const o of orders) {
    const batch = recipients.filter(r => r.signing_order === o);
    if (batch.every(r => r.status === 'signed')) continue;
    if (batch.some(r => r.status === 'notified' || r.status === 'viewed')) return; // already notified
    nextOrder = o; break;
  }
  if (nextOrder == null) {
    // All signed — engine will flip to 'completed' via the signing route
    return;
  }
  const sender = (await query('SELECT full_name FROM users WHERE id=$1', [env.created_by])).rows[0];
  const batch = recipients.filter(r => r.signing_order === nextOrder);
  for (const r of batch) {
    const newToken = mintToken();
    await query('UPDATE inkd_recipients SET sign_token_hash=$2, notified_at=now(), status=$3 WHERE id=$1',
      [r.id, await hashToken(newToken), 'notified']);
    try {
      await sendYourTurn({
        to: r.email, recipientName: r.full_name, envelopeName: env.name,
        senderName: sender?.full_name || 'PropSpot user', token: newToken,
      });
    } catch (e) { console.error('Your-turn email failed for', r.email, e); }
  }
}

router.notifyNextBatchIfReady = notifyNextBatchIfReady;
```

- [ ] **Step 2: Commit**

```bash
cd propspot-os
git add routes/inkd/envelopes.js
git commit -m "feat(inkd): send endpoint + sequential turn-flipping helper"
```

### Task 4.3: Public signer router (no auth)

**Files:**
- Create: `propspot-os/routes/inkd/signing.js`
- Modify: `propspot-os/server.js`

- [ ] **Step 1: Implement the public signing router**

```js
// propspot-os/routes/inkd/signing.js
// PUBLIC routes — DO NOT use requireAuth. Token-authenticated only.
const express = require('express');
const cloudinary = require('cloudinary').v2;
const { query } = require('../../db');
const { verifyToken } = require('../../lib/inkd-tokens');
const { logAudit } = require('../../lib/inkd-audit');
const envelopesRouter = require('./envelopes');

const router = express.Router();

// Helper: resolve a clear-text token to a recipient by checking all candidates
// (we don't know which row matches without comparing). Recipients are scoped by
// indexed envelopes — but for simplicity v1 scans by hash candidates.
// For better perf later: store a prefix index.
async function findRecipientByToken(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const { rows } = await query(
    `SELECT id, envelope_id, sign_token_hash, sign_token_expires_at, status, full_name, email, role
       FROM inkd_recipients
      WHERE sign_token_expires_at > now()
        AND status IN ('notified','viewed')`);
  for (const r of rows) {
    if (await verifyToken(token, r.sign_token_hash)) return r;
  }
  return null;
}

// GET /inkd/sign/:token  — load the doc + this recipient's fields
router.get('/:token', async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });

  if (rec.status === 'notified') {
    await query('UPDATE inkd_recipients SET viewed_at=now(), status=$2 WHERE id=$1', [rec.id, 'viewed']);
    await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'viewed', req });
  }
  const env = (await query('SELECT id, name, source_pdf_url, page_count, status FROM inkd_envelopes WHERE id=$1', [rec.envelope_id])).rows[0];
  const allRecips = (await query('SELECT id, role, full_name, signing_order FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order', [rec.envelope_id])).rows;
  const fields = (await query('SELECT * FROM inkd_field_values WHERE envelope_id=$1 ORDER BY page_number', [rec.envelope_id])).rows;
  res.json({
    envelope: env,
    me: { id: rec.id, role: rec.role, full_name: rec.full_name },
    other_recipients: allRecips.filter(r => r.id !== rec.id),
    fields,
  });
});

// POST /inkd/sign/:token/upload-signature
// body: { dataUrl: 'data:image/png;base64,...' }
// Returns: { url }
router.post('/:token/upload-signature', express.json({ limit: '4mb' }), async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });
  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return res.status(400).json({ error: 'dataUrl required' });
  try {
    const cloud = await cloudinary.uploader.upload(dataUrl, {
      folder: `propspot/inkd/signatures/${rec.envelope_id}`,
      resource_type: 'image',
    });
    res.json({ url: cloud.secure_url });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Upload failed' }); }
});

// POST /inkd/sign/:token/submit
// body: { values: [{ id, value }] }   — value is text, ISO date, 'true'/'false', or signature image URL
router.post('/:token/submit', express.json(), async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });

  const items = Array.isArray(req.body.values) ? req.body.values : [];
  try {
    for (const it of items) {
      await query(
        `UPDATE inkd_field_values
            SET value=$2, value_filled_at=now(), autofilled=FALSE
          WHERE id=$1 AND envelope_id=$3 AND recipient_id=$4`,
        [it.id, it.value ?? null, rec.envelope_id, rec.id]);
      await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'field_filled', req, details: { field_value_id: it.id } });
    }

    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress || null;
    await query(`UPDATE inkd_recipients
                    SET status='signed', signed_at=now(), signed_ip=$2, signed_user_agent=$3
                  WHERE id=$1`, [rec.id, ip, req.headers['user-agent'] || null]);
    await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'signed', req });

    // Update envelope status
    const counts = await query(
      `SELECT
          COUNT(*) FILTER (WHERE status='signed')   AS signed,
          COUNT(*)                                   AS total
         FROM inkd_recipients WHERE envelope_id=$1`, [rec.envelope_id]);
    const { signed, total } = counts.rows[0];
    if (Number(signed) === Number(total)) {
      await query(`UPDATE inkd_envelopes SET status='completed', completed_at=now() WHERE id=$1`, [rec.envelope_id]);
      // Phase 5 will hook into this point to call the signing engine.
      // For now we just mark completed and stop.
    } else {
      await query(`UPDATE inkd_envelopes SET status='partial' WHERE id=$1 AND status<>'partial'`, [rec.envelope_id]);
      await envelopesRouter.notifyNextBatchIfReady(rec.envelope_id);
    }

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Submit failed' }); }
});

// POST /inkd/sign/:token/decline
// body: { reason? }
router.post('/:token/decline', express.json(), async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });
  try {
    await query(`UPDATE inkd_recipients SET status='declined', decline_reason=$2 WHERE id=$1`, [rec.id, req.body?.reason || null]);
    await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'declined', req, details: { reason: req.body?.reason || null } });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Decline failed' }); }
});

module.exports = router;
```

- [ ] **Step 2: Mount the router in server.js (no requireAuth)**

```js
app.use('/api/inkd/signing', require('./routes/inkd/signing'));
```

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add routes/inkd/signing.js server.js
git commit -m "feat(inkd): public signer router (token auth, fetch/upload-signature/submit/decline)"
```

### Task 4.4: Signer page UI

**Files:**
- Create: `propspot-os/public/inkd-sign.html`
- Create: `propspot-os/public/inkd-sign.js`

- [ ] **Step 1: Create HTML**

```html
<!-- propspot-os/public/inkd-sign.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Review &amp; Sign</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
<script src="https://cdn.jsdelivr.net/npm/signature_pad@4.2.0/dist/signature_pad.umd.min.js"></script>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f5f6f8; }
  header { background: #fff; padding: 16px; border-bottom: 1px solid #e3e3e3; display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  #btn-finish { padding: 10px 20px; background: #16a34a; color: white; border: 0; border-radius: 4px; cursor: pointer; font-weight: 600; }
  #btn-finish:disabled { background: #9ca3af; cursor: not-allowed; }
  #btn-decline { padding: 8px 14px; background: #f3f4f6; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; }
  #pdf-stage { padding: 24px; overflow: auto; height: calc(100vh - 65px); }
  .pdf-page { position: relative; margin: 0 auto 16px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
  .pdf-page canvas { display: block; }
  .field { position: absolute; box-sizing: border-box; font-size: 12px; }
  .field.theirs { background: rgba(150,150,150,.18); border: 1px dashed #aaa; color: #555; padding: 2px 4px; }
  .field.mine   { background: rgba(34,197,94,.18); border: 2px solid #16a34a; cursor: pointer; padding: 2px 4px; }
  .field.mine.filled { background: rgba(34,197,94,.06); }
  .field.mine input, .field.mine select { width: 100%; height: 100%; border: 0; background: transparent; padding: 2px 4px; box-sizing: border-box; }
  .field.preview-only { background: rgba(0,0,0,.04); border: 1px dotted #ddd; color: #333; padding: 2px 4px; }
  .sig-img { width: 100%; height: 100%; object-fit: contain; }

  /* Signature modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
  .modal { background: white; padding: 24px; border-radius: 8px; min-width: 420px; }
  .modal h2 { margin-top: 0; }
  #sig-canvas { border: 1px solid #ccc; border-radius: 4px; width: 400px; height: 160px; background: #fafafa; cursor: crosshair; }
  .modal button { padding: 8px 14px; margin-right: 8px; cursor: pointer; }
</style>
</head>
<body>
  <header>
    <h1 id="env-title">Loading…</h1>
    <button id="btn-decline">Decline</button>
    <button id="btn-finish" disabled>Finish &amp; Sign</button>
  </header>
  <main id="pdf-stage"></main>

  <div id="sig-modal" hidden>
    <div class="modal-backdrop">
      <div class="modal">
        <h2>Draw your <span id="sig-kind">signature</span></h2>
        <canvas id="sig-canvas" width="400" height="160"></canvas>
        <div style="margin-top: 12px;">
          <button id="sig-clear">Clear</button>
          <button id="sig-cancel">Cancel</button>
          <button id="sig-save" style="background: #16a34a; color: white; border: 0;">Apply</button>
        </div>
      </div>
    </div>
  </div>

  <script src="/inkd-sign.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create JS — Part 1, load + render**

```js
// propspot-os/public/inkd-sign.js
const params = new URLSearchParams(location.search);
const token = params.get('token');
let state = { envelope: null, me: null, fields: [], pages: [], pendingSigField: null };
let sigPad = null;

async function init() {
  if (!token) { document.body.innerHTML = '<p style="padding:40px">Missing signing token.</p>'; return; }
  const r = await fetch(`/api/inkd/signing/${token}`);
  if (!r.ok) { document.body.innerHTML = '<p style="padding:40px">This signing link is invalid or expired.</p>'; return; }
  const data = await r.json();
  state.envelope = data.envelope;
  state.me = data.me;
  state.fields = data.fields;
  document.getElementById('env-title').textContent = `${state.envelope.name} — signing as ${state.me.full_name} (${state.me.role})`;
  await renderPdf();
  drawFields();
  updateFinishButton();
  document.getElementById('btn-finish').addEventListener('click', submit);
  document.getElementById('btn-decline').addEventListener('click', decline);
  wireSigModal();
}

async function renderPdf() {
  const stage = document.getElementById('pdf-stage');
  const pdf = await pdfjsLib.getDocument(state.envelope.source_pdf_url).promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const container = document.createElement('div');
    container.className = 'pdf-page'; container.dataset.pageNumber = p;
    container.style.width = viewport.width + 'px'; container.style.height = viewport.height + 'px';
    stage.appendChild(container);
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    state.pages.push({ pageNum: p, width: viewport.width, height: viewport.height, container });
  }
}

function drawFields() {
  for (const page of state.pages) page.container.querySelectorAll('.field').forEach(n => n.remove());
  for (const fv of state.fields) {
    const page = state.pages.find(p => p.pageNum === fv.page_number);
    if (!page) continue;
    const div = document.createElement('div');
    div.className = 'field';
    div.style.left = (fv.x_pct * page.width) + 'px';
    div.style.top  = (fv.y_pct * page.height) + 'px';
    div.style.width  = (fv.width_pct * page.width) + 'px';
    div.style.height = (fv.height_pct * page.height) + 'px';

    const isMine    = fv.recipient_id === state.me.id;
    const isTheirs  = fv.recipient_id && fv.recipient_id !== state.me.id;
    const isPreview = !fv.recipient_id; // sender-filled, read-only

    if (isMine) {
      div.classList.add('mine');
      if (fv.value) div.classList.add('filled');
      mountMineEditor(div, fv);
    } else if (isTheirs) {
      div.classList.add('theirs');
      div.textContent = fv.value ? '(filled)' : (fv.label || fv.field_type);
    } else {
      div.classList.add('preview-only');
      div.textContent = fv.value || fv.label || '';
    }
    page.container.appendChild(div);
  }
}

function mountMineEditor(div, fv) {
  if (fv.field_type === 'text') {
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = fv.value || '';
    inp.addEventListener('input', () => { fv.value = inp.value; updateFinishButton(); div.classList.toggle('filled', !!inp.value); });
    div.appendChild(inp);
  } else if (fv.field_type === 'date') {
    const inp = document.createElement('input'); inp.type = 'date'; inp.value = fv.value || '';
    inp.addEventListener('change', () => { fv.value = inp.value; updateFinishButton(); div.classList.toggle('filled', !!inp.value); });
    div.appendChild(inp);
  } else if (fv.field_type === 'checkbox') {
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = fv.value === 'true';
    inp.addEventListener('change', () => { fv.value = inp.checked ? 'true' : 'false'; updateFinishButton(); });
    div.appendChild(inp);
  } else if (fv.field_type === 'signature' || fv.field_type === 'initial') {
    if (fv.value) {
      const img = document.createElement('img'); img.src = fv.value; img.className = 'sig-img';
      div.appendChild(img);
    } else {
      div.textContent = fv.field_type === 'signature' ? 'Click to sign' : 'Click to initial';
    }
    div.addEventListener('click', () => openSigModal(fv, div));
  }
}

function updateFinishButton() {
  const mine = state.fields.filter(f => f.recipient_id === state.me.id);
  const allFilled = mine.every(f => f.value && f.value !== '');
  document.getElementById('btn-finish').disabled = !allFilled;
}
```

- [ ] **Step 3: Create JS — Part 2, signature modal + submit + decline**

Append to the same file:

```js
function wireSigModal() {
  const canvas = document.getElementById('sig-canvas');
  sigPad = new SignaturePad(canvas, { backgroundColor: '#fafafa' });
  document.getElementById('sig-clear').addEventListener('click', () => sigPad.clear());
  document.getElementById('sig-cancel').addEventListener('click', closeSigModal);
  document.getElementById('sig-save').addEventListener('click', applySignature);
}

function openSigModal(fv, divEl) {
  state.pendingSigField = { fv, divEl };
  document.getElementById('sig-kind').textContent = fv.field_type === 'initial' ? 'initials' : 'signature';
  document.getElementById('sig-modal').hidden = false;
  sigPad.clear();
}
function closeSigModal() { document.getElementById('sig-modal').hidden = true; state.pendingSigField = null; }

async function applySignature() {
  if (sigPad.isEmpty()) { alert('Please draw your signature first'); return; }
  const dataUrl = sigPad.toDataURL('image/png');
  const r = await fetch(`/api/inkd/signing/${token}/upload-signature`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!r.ok) { alert('Failed to upload signature'); return; }
  const { url } = await r.json();
  const { fv, divEl } = state.pendingSigField;
  fv.value = url;
  divEl.classList.add('filled');
  divEl.innerHTML = '';
  const img = document.createElement('img'); img.src = url; img.className = 'sig-img';
  divEl.appendChild(img);
  closeSigModal();
  updateFinishButton();
}

async function submit() {
  const mine = state.fields.filter(f => f.recipient_id === state.me.id);
  const values = mine.map(f => ({ id: f.id, value: f.value }));
  const r = await fetch(`/api/inkd/signing/${token}/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) { alert('Submit failed'); return; }
  document.body.innerHTML = '<div style="padding:80px;text-align:center"><h1>Thank you!</h1><p>Your signature has been recorded. You may close this window.</p></div>';
}

async function decline() {
  const reason = prompt('Why are you declining? (optional)');
  const r = await fetch(`/api/inkd/signing/${token}/decline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!r.ok) { alert('Decline failed'); return; }
  document.body.innerHTML = '<div style="padding:80px;text-align:center"><h1>Declined</h1><p>The sender has been notified.</p></div>';
}

init();
```

- [ ] **Step 4: Manual end-to-end verification**

1. Have at least one template (with fields tagged to recipient roles) + one property.
2. Create an envelope via the composer, add 2 recipients (Buyer + Seller), give them YOUR email so you receive both.
3. Click Send.
4. Check email for the invite, click the link.
5. Fill in your fields (text, date, signature drawn on canvas).
6. Click Finish.
7. Verify the second recipient (Seller) receives the "your turn" email automatically.
8. Sign as Seller too.
9. Query: `SELECT status, completed_at FROM inkd_envelopes WHERE id='<id>'` → expect `'completed'` with a timestamp.

- [ ] **Step 5: Commit**

```bash
cd propspot-os
git add public/inkd-sign.html public/inkd-sign.js
git commit -m "feat(inkd): signer page (PDF + signature_pad + submit/decline)"
```

---

## Phase 5 — Signing engine + tamper-proof certificate

Goal: when the last signer finishes, the engine flattens all field values onto the PDF, appends a certificate page, computes SHA-256, uploads the final PDF to Cloudinary, and stores the URL+hash on the envelope. After this phase, completed envelopes have a downloadable signed PDF.

### Task 5.1: Coordinate conversion helper

**Files:**
- Create: `propspot-os/lib/inkd-pdf-coords.js`
- Create: `propspot-os/tests/inkd/pdf-coords.test.js`

The browser editor uses percentages relative to the rendered viewport (origin top-left). pdf-lib uses points with origin bottom-left. We need a single converter.

- [ ] **Step 1: Write the failing tests**

```js
// propspot-os/tests/inkd/pdf-coords.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pctToPdfRect } = require('../../lib/inkd-pdf-coords');

test('converts top-left percent rect to pdf-lib (bottom-left origin)', () => {
  // Page is 600pt wide, 800pt tall.
  // Field at x_pct=0.1, y_pct=0.2, width=0.3, height=0.05
  // Top-left of field in browser space: (60, 160). Bottom-left in PDF space: (60, 800 - 160 - 40) = (60, 600)
  // Width=180, height=40.
  const r = pctToPdfRect({ x_pct: 0.1, y_pct: 0.2, width_pct: 0.3, height_pct: 0.05 }, 600, 800);
  assert.deepStrictEqual(r, { x: 60, y: 600, width: 180, height: 40 });
});

test('handles 0,0 top-left correctly', () => {
  const r = pctToPdfRect({ x_pct: 0, y_pct: 0, width_pct: 0.1, height_pct: 0.1 }, 600, 800);
  // y = 800 - 0 - 80 = 720
  assert.deepStrictEqual(r, { x: 0, y: 720, width: 60, height: 80 });
});

test('handles bottom-right corner', () => {
  const r = pctToPdfRect({ x_pct: 0.9, y_pct: 0.9, width_pct: 0.1, height_pct: 0.1 }, 600, 800);
  // x = 540, y = 800 - 720 - 80 = 0
  assert.deepStrictEqual(r, { x: 540, y: 0, width: 60, height: 80 });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `cd propspot-os && node --test tests/inkd/pdf-coords.test.js`
Expected: failure with `Cannot find module`.

- [ ] **Step 3: Implement**

```js
// propspot-os/lib/inkd-pdf-coords.js
// Convert a field's top-left-origin percent rect into pdf-lib's bottom-left-origin point rect.
//
// Input  rect: { x_pct, y_pct, width_pct, height_pct }  (numbers between 0 and 1)
// Input  page: pageWidthPt, pageHeightPt
// Output rect: { x, y, width, height }  (in PDF points, origin bottom-left)
function pctToPdfRect(rect, pageWidthPt, pageHeightPt) {
  const width  = rect.width_pct  * pageWidthPt;
  const height = rect.height_pct * pageHeightPt;
  const x = rect.x_pct * pageWidthPt;
  // Browser y is from top; pdf-lib y is from bottom.
  const y = pageHeightPt - (rect.y_pct * pageHeightPt) - height;
  return { x, y, width, height };
}

module.exports = { pctToPdfRect };
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd propspot-os && node --test tests/inkd/pdf-coords.test.js`
Expected: `# pass 3`.

- [ ] **Step 5: Commit**

```bash
cd propspot-os
git add lib/inkd-pdf-coords.js tests/inkd/pdf-coords.test.js
git commit -m "feat(inkd): pct-to-pdf coord converter with tests"
```

### Task 5.2: PDF flattening + certificate + hash

**Files:**
- Create: `propspot-os/lib/inkd-pdf.js`

This is the heaviest module. It:
1. Loads the source PDF
2. Stamps every field value (text, date, signature image, checkbox)
3. Appends a certificate page
4. Hashes
5. Returns { bytes, hash }

- [ ] **Step 1: Implement**

```js
// propspot-os/lib/inkd-pdf.js
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { pctToPdfRect } = require('./inkd-pdf-coords');

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

// Flatten field_values onto a PDF + append a certificate page.
// Returns { bytes: Uint8Array, hash: hex string }
async function buildSignedPdf({ sourcePdfUrl, envelope, recipients, fieldValues, auditEvents }) {
  const srcBytes = await fetchBytes(sourcePdfUrl);
  const pdf = await PDFDocument.load(srcBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Group field values by page
  const byPage = new Map();
  for (const fv of fieldValues) {
    if (!byPage.has(fv.page_number)) byPage.set(fv.page_number, []);
    byPage.get(fv.page_number).push(fv);
  }

  const pages = pdf.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width: pw, height: ph } = page.getSize();
    const fields = byPage.get(i + 1) || [];
    for (const fv of fields) {
      const r = pctToPdfRect(fv, pw, ph);
      const v = fv.value;
      if (v == null || v === '') continue;
      if (fv.field_type === 'text') {
        page.drawText(String(v), {
          x: r.x + 2, y: r.y + 4, size: Math.min(r.height - 4, 11), font: helv, color: rgb(0,0,0),
        });
      } else if (fv.field_type === 'date') {
        page.drawText(String(v), { x: r.x + 2, y: r.y + 4, size: 11, font: helv, color: rgb(0,0,0) });
      } else if (fv.field_type === 'checkbox') {
        if (String(v) === 'true') {
          page.drawText('X', { x: r.x + 2, y: r.y + 2, size: r.height - 2, font: helvBold, color: rgb(0,0,0) });
        }
      } else if (fv.field_type === 'signature' || fv.field_type === 'initial') {
        try {
          const imgBytes = await fetchBytes(String(v));
          const img = await pdf.embedPng(imgBytes);
          page.drawImage(img, { x: r.x, y: r.y, width: r.width, height: r.height });
        } catch (e) {
          // Fall back to drawing the signer name as text if image fails
          page.drawText('(signature)', { x: r.x, y: r.y, size: 10, font: helv, color: rgb(0,0,0) });
        }
      }
    }
  }

  // Append certificate page
  const certPage = pdf.addPage([612, 792]); // US Letter
  let cy = 750;
  certPage.drawText('Certificate of Completion', { x: 50, y: cy, size: 18, font: helvBold });
  cy -= 28;
  certPage.drawText(`Envelope: ${envelope.name}`, { x: 50, y: cy, size: 11, font: helv });
  cy -= 16;
  certPage.drawText(`Envelope ID: ${envelope.id}`, { x: 50, y: cy, size: 10, font: helv });
  cy -= 14;
  certPage.drawText(`Created: ${new Date(envelope.created_at).toISOString()}`, { x: 50, y: cy, size: 10, font: helv });
  cy -= 14;
  certPage.drawText(`Completed: ${new Date(envelope.completed_at || Date.now()).toISOString()}`, { x: 50, y: cy, size: 10, font: helv });
  cy -= 28;

  certPage.drawText('Signers', { x: 50, y: cy, size: 14, font: helvBold });
  cy -= 18;
  for (const r of recipients) {
    certPage.drawText(`• ${r.full_name} (${r.role}) — ${r.email}`, { x: 50, y: cy, size: 10, font: helv });
    cy -= 12;
    certPage.drawText(`  Signed at ${r.signed_at ? new Date(r.signed_at).toISOString() : '—'} from ${r.signed_ip || '—'}`, { x: 50, y: cy, size: 9, font: helv, color: rgb(.3,.3,.3) });
    cy -= 14;
  }

  cy -= 14;
  certPage.drawText('Audit trail', { x: 50, y: cy, size: 14, font: helvBold });
  cy -= 18;
  for (const ev of auditEvents) {
    if (cy < 80) { // wrap to a new cert page if needed
      const more = pdf.addPage([612, 792]); cy = 750;
      Object.setPrototypeOf(certPage, Object.getPrototypeOf(more)); // no-op safety
    }
    const ts = new Date(ev.event_at).toISOString();
    const line = `${ts}  ${ev.event_type}${ev.recipient_id ? ' (recipient)' : ''}${ev.ip ? '  ip=' + ev.ip : ''}`;
    certPage.drawText(line, { x: 50, y: cy, size: 9, font: helv });
    cy -= 11;
  }

  // We compute the hash AFTER we save, but the hash field shown ON the certificate
  // can only describe everything else. Conventional approach: print "Hash: see envelope record"
  // and store the canonical hash on the envelope row. Verifiers re-hash the entire downloaded PDF
  // and compare to the stored value.
  cy -= 14;
  certPage.drawText('Hash (SHA-256 of full document): stored on the PropSpot envelope record', { x: 50, y: cy, size: 9, font: helv });

  const bytes = await pdf.save();
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return { bytes, hash };
}

module.exports = { buildSignedPdf };
```

- [ ] **Step 2: Smoke test (manual since DB+Cloudinary involved)**

Create a fake envelope context and verify the function returns bytes:
```bash
cd propspot-os
node -e "
const { buildSignedPdf } = require('./lib/inkd-pdf');
(async () => {
  // Use a real source PDF URL from one of your existing templates
  const { query } = require('./db');
  const t = (await query('SELECT source_pdf_url FROM inkd_templates LIMIT 1')).rows[0];
  if (!t) { console.log('No template found'); process.exit(0); }
  const { bytes, hash } = await buildSignedPdf({
    sourcePdfUrl: t.source_pdf_url,
    envelope:    { id: 'test', name: 'Smoke', created_at: new Date(), completed_at: new Date() },
    recipients:  [{ full_name: 'Alice Buyer', role: 'buyer', email: 'a@b.com', signed_at: new Date(), signed_ip: '127.0.0.1' }],
    fieldValues: [],
    auditEvents: [{ event_type: 'created', event_at: new Date() }, { event_type: 'sent', event_at: new Date() }],
  });
  console.log('PDF bytes:', bytes.length, 'hash:', hash.slice(0,16) + '…');
  require('fs').writeFileSync('/tmp/inkd-smoke.pdf', bytes);
  process.exit(0);
})();
"
```
Expected: prints byte count + hash prefix; `/tmp/inkd-smoke.pdf` opens in a viewer and shows the certificate page appended to the source PDF.

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add lib/inkd-pdf.js
git commit -m "feat(inkd): PDF flattening engine + certificate page + SHA-256 hashing"
```

### Task 5.3: Wire the engine into signing.js completion

**Files:**
- Modify: `propspot-os/routes/inkd/signing.js`

- [ ] **Step 1: Add a finalization helper that uploads + stores the signed PDF**

Add this above `module.exports = router;` in `propspot-os/routes/inkd/signing.js`:

```js
const cloudinaryV2 = require('cloudinary').v2;
const { buildSignedPdf } = require('../../lib/inkd-pdf');
const { sendCompletedToSender } = require('../../lib/inkd-email');

async function finalizeEnvelope(envelopeId) {
  const env       = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [envelopeId])).rows[0];
  const recips    = (await query('SELECT * FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order, id', [envelopeId])).rows;
  const fvs       = (await query('SELECT * FROM inkd_field_values WHERE envelope_id=$1', [envelopeId])).rows;
  const events    = (await query('SELECT * FROM inkd_audit_events WHERE envelope_id=$1 ORDER BY event_at', [envelopeId])).rows;
  const sender    = (await query('SELECT full_name, email FROM users WHERE id=$1', [env.created_by])).rows[0];

  const { bytes, hash } = await buildSignedPdf({
    sourcePdfUrl: env.source_pdf_url,
    envelope: env, recipients: recips, fieldValues: fvs, auditEvents: events,
  });

  // Upload to Cloudinary
  const cloud = await new Promise((resolve, reject) => {
    cloudinaryV2.uploader.upload_stream(
      { resource_type: 'raw', folder: 'propspot/inkd/signed', format: 'pdf' },
      (e, out) => e ? reject(e) : resolve(out)
    ).end(Buffer.from(bytes));
  });

  await query(
    `UPDATE inkd_envelopes
        SET final_pdf_url=$2, final_pdf_id=$3, final_pdf_hash=$4
      WHERE id=$1`,
    [envelopeId, cloud.secure_url, cloud.public_id, hash]);

  if (sender?.email) {
    try { await sendCompletedToSender({ to: sender.email, senderName: sender.full_name, envelopeName: env.name }); }
    catch (e) { console.error('sender completion email failed', e); }
  }
}
```

- [ ] **Step 2: Call finalizeEnvelope when all signed**

In the `/submit` handler in the same file, find the block that transitions to `'completed'`:

```js
if (Number(signed) === Number(total)) {
  await query(`UPDATE inkd_envelopes SET status='completed', completed_at=now() WHERE id=$1`, [rec.envelope_id]);
  // Phase 5 will hook into this point to call the signing engine.
  // For now we just mark completed and stop.
}
```

Replace the comment + closing brace with the finalize call:

```js
if (Number(signed) === Number(total)) {
  await query(`UPDATE inkd_envelopes SET status='completed', completed_at=now() WHERE id=$1`, [rec.envelope_id]);
  try { await finalizeEnvelope(rec.envelope_id); }
  catch (e) { console.error('finalizeEnvelope failed', e); }
}
```

- [ ] **Step 3: Manual end-to-end verification**

1. Reset / start a fresh envelope (Phase 4 flow).
2. Have all recipients sign.
3. Query: `SELECT status, final_pdf_url, final_pdf_hash FROM inkd_envelopes WHERE id='<id>'`
4. Expect: status='completed', `final_pdf_url` is set, `final_pdf_hash` is a 64-char hex string.
5. Open `final_pdf_url` in browser → see field values stamped on the doc and certificate page appended.
6. Sender receives the "envelope completed" email.

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add routes/inkd/signing.js
git commit -m "feat(inkd): finalize envelope on last signature — flatten, certify, hash, store"
```

---

## Phase 6 — Dashboard + Files promotion + entry points

Goal: complete the loop. 5-lane dashboard, "Save to Files" button, sidebar entry, "Send document" buttons on property/opportunity/contact/files pages.

### Task 6.1: Files-promotion endpoint

**Files:**
- Create: `propspot-os/routes/inkd/files-promotion.js`
- Modify: `propspot-os/server.js`

- [ ] **Step 1: Implement**

```js
// propspot-os/routes/inkd/files-promotion.js
const express = require('express');
const crypto = require('crypto');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { logAudit } = require('../../lib/inkd-audit');

const router = express.Router();
router.use(requireAuth);

// POST /api/inkd/envelopes/:id/save-to-files
router.post('/:id/save-to-files', async (req, res) => {
  try {
    const env = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [req.params.id])).rows[0];
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'completed') return res.status(400).json({ error: 'Envelope not completed' });
    if (env.filed_at) return res.status(400).json({ error: 'Already filed' });
    if (!env.property_id) return res.status(400).json({ error: 'Envelope has no property — cannot save to property Files' });

    // Re-verify hash (paranoia)
    const buf = Buffer.from(await (await fetch(env.final_pdf_url)).arrayBuffer());
    const recomputed = crypto.createHash('sha256').update(buf).digest('hex');
    if (recomputed !== env.final_pdf_hash) return res.status(500).json({ error: 'Hash mismatch — refusing to save' });

    const filename = `${env.name}.pdf`.replace(/[\/\\]/g, '-');
    const pf = (await query(
      `INSERT INTO property_files
         (property_id, filename, url, cloudinary_id, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [env.property_id, filename, env.final_pdf_url, env.final_pdf_id, 'application/pdf', buf.length, req.user.id])).rows[0];

    await query(`UPDATE inkd_envelopes SET filed_at=now(), filed_property_file_id=$2 WHERE id=$1`,
      [req.params.id, pf.id]);
    await logAudit({ envelopeId: req.params.id, eventType: 'filed_to_property', req, userId: req.user.id, details: { property_file_id: pf.id } });
    res.json({ ok: true, property_file: pf });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Save to Files failed' }); }
});

module.exports = router;
```

- [ ] **Step 2: Mount in server.js**

```js
app.use('/api/inkd/envelopes', require('./routes/inkd/files-promotion'));
```

(Note: this mounts at the same prefix as `envelopes.js`. Both export different sub-paths. Express handles the routing correctly.)

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add routes/inkd/files-promotion.js server.js
git commit -m "feat(inkd): Save-to-Files endpoint with hash re-verification"
```

### Task 6.2: Dashboard UI (5 lanes)

**Files:**
- Create: `propspot-os/public/inkd.html`
- Create: `propspot-os/public/inkd.js`
- Create: `propspot-os/public/inkd.css`

- [ ] **Step 1: Create HTML**

```html
<!-- propspot-os/public/inkd.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ink'd</title>
<link rel="stylesheet" href="/chrome.css">
<link rel="stylesheet" href="/inkd.css">
</head>
<body class="inkd-dash">
<header class="inkd-dash-header">
  <h1>Ink'd</h1>
  <a class="primary" href="/inkd-template-editor.html">+ New template</a>
  <a class="secondary" href="/inkd-templates.html">Templates</a>
</header>
<main class="lanes">
  <section class="lane" data-lane="draft">       <h2>Drafts</h2>            <div class="cards"></div></section>
  <section class="lane" data-lane="out">         <h2>Out for Signature</h2> <div class="cards"></div></section>
  <section class="lane" data-lane="action">      <h2>Action Needed</h2>     <div class="cards"></div></section>
  <section class="lane" data-lane="review">      <h2>Completed (review)</h2><div class="cards"></div></section>
  <section class="lane" data-lane="filed">       <h2>Filed</h2>             <div class="cards"></div></section>
</main>
<script src="/inkd.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create CSS**

```css
/* propspot-os/public/inkd.css */
body.inkd-dash { margin: 0; font-family: system-ui, sans-serif; background: #f5f6f8; }
.inkd-dash-header { display: flex; gap: 12px; align-items: center; padding: 16px 24px; background: white; border-bottom: 1px solid #e3e3e3; }
.inkd-dash-header h1 { margin: 0; flex: 1; font-size: 18px; }
.inkd-dash-header a { text-decoration: none; padding: 8px 14px; border-radius: 4px; }
.inkd-dash-header a.primary   { background: #2563eb; color: white; }
.inkd-dash-header a.secondary { background: #f3f4f6; color: #111; border: 1px solid #ccc; }
.lanes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; padding: 16px; height: calc(100vh - 72px); }
.lane { background: #ececec; border-radius: 6px; padding: 12px; overflow-y: auto; }
.lane h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; color: #555; }
.card { background: white; border-radius: 4px; padding: 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.card h3 { margin: 0 0 4px; font-size: 14px; }
.card p { margin: 2px 0; font-size: 12px; color: #666; }
.card .actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.card .actions button, .card .actions a { font-size: 11px; padding: 4px 8px; background: #f3f4f6; border: 1px solid #ccc; border-radius: 3px; text-decoration: none; color: #111; cursor: pointer; }
.card .actions .file { background: #16a34a; color: white; border-color: #16a34a; }
.card .actions .void { background: #ef4444; color: white; border-color: #ef4444; }
```

- [ ] **Step 3: Create JS**

```js
// propspot-os/public/inkd.js
async function load() {
  const r = await fetch('/api/inkd/envelopes');
  const list = await r.json();
  const buckets = { draft: [], out: [], action: [], review: [], filed: [] };
  for (const e of list) {
    if (e.status === 'draft')                                   buckets.draft.push(e);
    else if (e.status === 'sent' || e.status === 'partial')     buckets.out.push(e);
    else if (e.status === 'voided' || e.status === 'expired')   buckets.action.push(e);
    else if (e.status === 'completed' && !e.filed_at)           buckets.review.push(e);
    else if (e.filed_at)                                        buckets.filed.push(e);
  }
  for (const lane of Object.keys(buckets)) {
    const section = document.querySelector(`[data-lane="${lane}"] .cards`);
    section.innerHTML = '';
    for (const e of buckets[lane]) section.appendChild(card(e, lane));
  }
}

function card(e, lane) {
  const div = document.createElement('div'); div.className = 'card';
  const title = document.createElement('h3'); title.textContent = e.name; div.appendChild(title);
  if (e.property_address) { const p = document.createElement('p'); p.textContent = e.property_address; div.appendChild(p); }
  if (e.template_name)    { const p = document.createElement('p'); p.textContent = e.template_name;    div.appendChild(p); }
  const meta = document.createElement('p'); meta.textContent = new Date(e.created_at).toLocaleDateString(); div.appendChild(meta);

  const actions = document.createElement('div'); actions.className = 'actions';
  if (lane === 'draft') {
    actions.innerHTML = `<a href="/inkd-send.html?envelope_id=${e.id}">Open</a>`;
  } else if (lane === 'out') {
    actions.innerHTML = `<a href="/inkd-envelope.html?id=${e.id}">View</a> <button class="void" data-id="${e.id}">Void</button>`;
  } else if (lane === 'action') {
    actions.innerHTML = `<a href="/inkd-envelope.html?id=${e.id}">View</a>`;
  } else if (lane === 'review') {
    actions.innerHTML = `<a href="${e.final_pdf_url}" target="_blank">Download</a> <button class="file" data-id="${e.id}" data-act="file">Save to Files</button>`;
  } else if (lane === 'filed') {
    actions.innerHTML = `<a href="${e.final_pdf_url}" target="_blank">Download</a>`;
  }
  div.appendChild(actions);
  actions.querySelector('.void')?.addEventListener('click', () => voidEnv(e.id));
  actions.querySelector('[data-act=file]')?.addEventListener('click', () => saveToFiles(e.id));
  return div;
}

async function voidEnv(id) {
  if (!confirm('Void this envelope?')) return;
  await fetch(`/api/inkd/envelopes/${id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  load();
}

async function saveToFiles(id) {
  const r = await fetch(`/api/inkd/envelopes/${id}/save-to-files`, { method: 'POST' });
  if (!r.ok) { const j = await r.json().catch(()=>({})); alert('Save failed: ' + (j.error || r.statusText)); return; }
  alert('Saved to property Files');
  load();
}

load();
```

- [ ] **Step 4: Manual verification**

1. Open `http://localhost:3000/inkd.html`
2. Verify cards appear in the correct lanes given your envelope statuses
3. From the "Completed (review)" lane, click "Save to Files" on a completed envelope
4. Open that envelope's property page — verify the PDF appears under Files
5. Check the envelope card moved to "Filed"

- [ ] **Step 5: Commit**

```bash
cd propspot-os
git add public/inkd.html public/inkd.js public/inkd.css
git commit -m "feat(inkd): 5-lane dashboard with Save-to-Files action"
```

### Task 6.3: Templates list page

**Files:**
- Create: `propspot-os/public/inkd-templates.html`
- Create: `propspot-os/public/inkd-templates.js`

- [ ] **Step 1: Create HTML**

```html
<!-- propspot-os/public/inkd-templates.html -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Ink'd — Templates</title>
<link rel="stylesheet" href="/chrome.css"><link rel="stylesheet" href="/inkd.css">
</head>
<body class="inkd-dash">
<header class="inkd-dash-header">
  <a href="/inkd.html">← Ink'd</a>
  <h1>Templates</h1>
  <a class="primary" href="/inkd-template-editor.html">+ New template</a>
</header>
<main style="padding: 16px;">
  <table id="tpl-table" style="width:100%; background:white; border-collapse: collapse;">
    <thead><tr style="background:#f3f4f6">
      <th style="text-align:left;padding:10px">Name</th><th style="text-align:left;padding:10px">Category</th>
      <th style="text-align:left;padding:10px">Pages</th><th style="text-align:left;padding:10px">Updated</th><th></th>
    </tr></thead>
    <tbody></tbody>
  </table>
</main>
<script src="/inkd-templates.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create JS**

```js
// propspot-os/public/inkd-templates.js
(async () => {
  const r = await fetch('/api/inkd/templates');
  const tpls = await r.json();
  const tbody = document.querySelector('#tpl-table tbody');
  for (const t of tpls) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="padding:10px"><a href="/inkd-template-editor.html?id=${t.id}">${escapeHtml(t.name)}</a></td>
      <td style="padding:10px">${escapeHtml(t.category||'')}</td>
      <td style="padding:10px">${t.page_count}</td>
      <td style="padding:10px">${new Date(t.updated_at).toLocaleDateString()}</td>
      <td style="padding:10px"><button data-id="${t.id}">Archive</button></td>`;
    tr.querySelector('button').addEventListener('click', async () => {
      if (!confirm('Archive this template?')) return;
      await fetch(`/api/inkd/templates/${t.id}`, { method: 'DELETE' });
      location.reload();
    });
    tbody.appendChild(tr);
  }
})();

function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
```

- [ ] **Step 3: Commit**

```bash
cd propspot-os
git add public/inkd-templates.html public/inkd-templates.js
git commit -m "feat(inkd): templates list page"
```

### Task 6.4: Sidebar + entry points from other pages

**Files:**
- Modify: `propspot-os/public/app-frame.html` (or wherever the sidebar is defined — search for "Holdings" or "Pulse" to find the existing sidebar)
- Modify: `propspot-os/public/property.html` (or whichever page renders a property — search for `property-files` to locate)
- Modify: `propspot-os/public/files.html` (add "Send for signature" on uploaded PDFs)

- [ ] **Step 1: Find the sidebar definition**

Run: `cd propspot-os && grep -lE "Pulse|Holdings|Inbox" public/*.html | head -5`
Expected: a small set of files. The file containing the existing sidebar nav is the one to edit.

- [ ] **Step 2: Add Ink'd to the sidebar**

In the sidebar file, find the block that lists the app links (look for a `<a href="/pulse.html">` or similar). Add a sibling entry:

```html
<a href="/inkd.html" class="app-link">
  <!-- match the icon/styling pattern used for other apps -->
  <span>Ink'd</span>
</a>
```

- [ ] **Step 3: Add "Send document" button to the property page**

Find the property detail page. Add this UI fragment near the existing action buttons (e.g., next to "Upload file"):

```html
<button id="btn-send-document" onclick="openSendDocument()">Send document</button>

<script>
async function openSendDocument() {
  const r = await fetch('/api/inkd/templates');
  const tpls = await r.json();
  if (!tpls.length) { alert('No templates yet — create one first'); return; }
  // Simple dropdown picker; could be a modal later
  const choice = prompt('Pick template:\n' + tpls.map((t, i) => `${i+1}. ${t.name}`).join('\n'));
  const idx = parseInt(choice, 10) - 1;
  const t = tpls[idx];
  if (!t) return;
  const propertyId = new URLSearchParams(location.search).get('id') || window.PROPERTY_ID;
  location.href = `/inkd-send.html?template_id=${t.id}&property_id=${propertyId}`;
}
</script>
```

- [ ] **Step 4: Add "Send for signature" action to files.html**

In `propspot-os/public/files.html`, find where each file row is rendered. For rows where mime_type === 'application/pdf', add a "Send for signature" button that opens `/inkd-send.html` with a special one-time-doc flag (Phase 7 enhancement — for now, this can just be a link to the template editor pre-loaded with the file). The minimum for v1:

```html
<!-- Inside the file row template, for PDF mime types -->
<button onclick="window.location.href='/inkd.html'">Send for signature</button>
```

(One-time-doc-from-existing-PDF flow is out of scope for v1; the Files-page button just routes to Ink'd where the user can upload again. Cleaner integration in a later iteration.)

- [ ] **Step 5: Manual verification**

1. Reload the app. Click "Ink'd" in the sidebar → lands on dashboard.
2. Open a property page. Click "Send document" → picks a template → lands on composer with autofilled values.
3. Files page shows the button on PDF rows (even if functionality is minimal).

- [ ] **Step 6: Commit**

```bash
cd propspot-os
git add public/  # plus whichever files you actually modified
git commit -m "feat(inkd): sidebar entry + Send-document button on property page + Files page hook"
```

### Task 6.5: Single envelope detail page (read-only)

**Files:**
- Create: `propspot-os/public/inkd-envelope.html`
- Create: `propspot-os/public/inkd-envelope.js`

- [ ] **Step 1: Create HTML**

```html
<!-- propspot-os/public/inkd-envelope.html -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Envelope detail</title>
<link rel="stylesheet" href="/chrome.css"><link rel="stylesheet" href="/inkd.css">
<style>
  .detail { display: grid; grid-template-columns: 1fr 360px; gap: 16px; padding: 16px; }
  .pdf-frame { background: white; border: 1px solid #e3e3e3; height: calc(100vh - 120px); }
  .pdf-frame iframe { width: 100%; height: 100%; border: 0; }
  .meta { background: white; padding: 16px; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  .recipient-row { padding: 8px; border-bottom: 1px solid #eee; }
  .recipient-row .status { font-size: 11px; color: #666; }
  .recipient-row .status.signed { color: #16a34a; }
  .audit { font-size: 11px; max-height: 240px; overflow-y: auto; background: #f9fafb; padding: 8px; border-radius: 4px; }
  .audit div { padding: 2px 0; border-bottom: 1px solid #f3f4f6; }
</style>
</head>
<body class="inkd-dash">
<header class="inkd-dash-header"><a href="/inkd.html">← Ink'd</a><h1 id="env-title">Loading…</h1></header>
<main class="detail">
  <div class="pdf-frame"><iframe id="pdf-iframe" src=""></iframe></div>
  <aside>
    <div class="meta">
      <h3>Status</h3>
      <p id="env-status"></p>
      <h3>Recipients</h3>
      <div id="recipients"></div>
      <h3>Audit trail</h3>
      <div class="audit" id="audit"></div>
    </div>
  </aside>
</main>
<script src="/inkd-envelope.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create JS**

```js
// propspot-os/public/inkd-envelope.js
(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const r = await fetch(`/api/inkd/envelopes/${id}`);
  const e = await r.json();
  document.getElementById('env-title').textContent = e.name;
  document.getElementById('env-status').textContent = e.status + (e.filed_at ? ' (filed)' : '');
  document.getElementById('pdf-iframe').src = e.final_pdf_url || e.source_pdf_url;
  const rec = document.getElementById('recipients');
  for (const r of e.recipients || []) {
    const div = document.createElement('div'); div.className = 'recipient-row';
    div.innerHTML = `<strong>${r.full_name}</strong> (${r.role}) — <span class="status ${r.status}">${r.status}</span><br><span style="font-size:11px;color:#666">${r.email}</span>`;
    rec.appendChild(div);
  }
  // Audit (fetched separately for clean separation; could be folded in)
  const a = await fetch(`/api/inkd/audit/${id}`).then(x => x.ok ? x.json() : []);
  const auditEl = document.getElementById('audit');
  for (const ev of a) {
    const d = document.createElement('div');
    d.textContent = `${new Date(ev.event_at).toLocaleString()}  ·  ${ev.event_type}${ev.ip ? ' · ' + ev.ip : ''}`;
    auditEl.appendChild(d);
  }
})();
```

- [ ] **Step 3: Add the audit fetch endpoint**

Add to `propspot-os/routes/inkd/envelopes.js` above `module.exports`:

```js
// GET /api/inkd/envelopes/:id/audit
router.get('/:id/audit', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT event_type, event_at, ip, user_agent, details
         FROM inkd_audit_events WHERE envelope_id=$1 ORDER BY event_at`, [req.params.id]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load audit' }); }
});
```

Update the JS in `inkd-envelope.js` to call `/api/inkd/envelopes/${id}/audit` instead of `/api/inkd/audit/${id}`.

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add public/inkd-envelope.html public/inkd-envelope.js routes/inkd/envelopes.js
git commit -m "feat(inkd): envelope detail page + audit endpoint"
```

---

## Phase 7 — Workers (reminders + expiry)

Goal: automated reminder emails fire on schedule; expired envelopes get cleaned up.

### Task 7.1: Worker module

**Files:**
- Create: `propspot-os/routes/inkd/workers.js`
- Modify: `propspot-os/server.js`

- [ ] **Step 1: Implement the worker**

```js
// propspot-os/routes/inkd/workers.js
const { query } = require('../../db');
const { mintToken, hashToken } = require('../../lib/inkd-tokens');
const { sendReminder } = require('../../lib/inkd-email');
const { logAudit } = require('../../lib/inkd-audit');

// Run-once: send overdue reminders + mark expired envelopes.
async function runReminderTick() {
  // 1. Reminders
  const candidates = (await query(
    `SELECT e.id AS envelope_id, e.name AS envelope_name, e.reminder_schedule, e.sent_at,
            r.id AS recipient_id, r.full_name, r.email, r.last_reminded_at, r.sign_token_hash,
            u.full_name AS sender_name
       FROM inkd_envelopes e
       JOIN inkd_recipients r ON r.envelope_id=e.id
       JOIN users u ON u.id=e.created_by
      WHERE e.status IN ('sent','partial')
        AND e.reminders_enabled = TRUE
        AND r.status IN ('notified','viewed')
        AND e.sent_at IS NOT NULL`)).rows;

  const now = Date.now();
  for (const c of candidates) {
    const schedule = c.reminder_schedule || [3, 7];
    const sentMs = new Date(c.sent_at).getTime();
    const daysSent = Math.floor((now - sentMs) / 86400000);
    const dayMatch = schedule.find(d => d === daysSent);
    if (!dayMatch) continue;
    // Don't re-remind the same day twice
    if (c.last_reminded_at && new Date(c.last_reminded_at).toDateString() === new Date(now).toDateString()) continue;

    // Mint a fresh token so the link is always live
    const newToken = mintToken();
    await query('UPDATE inkd_recipients SET sign_token_hash=$2, last_reminded_at=now() WHERE id=$1',
      [c.recipient_id, await hashToken(newToken)]);
    try {
      await sendReminder({
        to: c.email, recipientName: c.full_name, envelopeName: c.envelope_name,
        senderName: c.sender_name, token: newToken, dayNumber: dayMatch,
      });
      await logAudit({ envelopeId: c.envelope_id, recipientId: c.recipient_id, eventType: 'reminder_sent', details: { day: dayMatch } });
    } catch (e) { console.error('Reminder failed', e); }
  }

  // 2. Expiry
  const expired = (await query(
    `UPDATE inkd_envelopes
        SET status='expired'
      WHERE status IN ('sent','partial')
        AND expires_at < now()
      RETURNING id`)).rows;
  for (const e of expired) {
    await logAudit({ envelopeId: e.id, eventType: 'expired' });
  }
}

function startWorker() {
  // Tick every 5 minutes — matches the lightweight cadence the rest of propspot-os uses
  const FIVE_MIN = 5 * 60 * 1000;
  setInterval(() => {
    runReminderTick().catch(e => console.error('Ink’d reminder tick failed', e));
  }, FIVE_MIN);
}

module.exports = { runReminderTick, startWorker };
```

- [ ] **Step 2: Start the worker on server boot**

In `propspot-os/server.js`, near the bottom (after the `app.listen(...)` callback or after `initDb()` resolves), add:

```js
require('./routes/inkd/workers').startWorker();
```

- [ ] **Step 3: Manual verification**

1. Pick an in-flight envelope. Manually set its `sent_at` back 3 days:
   ```sql
   UPDATE inkd_envelopes SET sent_at = now() - interval '3 days' WHERE id = '<uuid>';
   ```
2. In another terminal, force-run the tick:
   ```bash
   cd propspot-os && node -e "require('./routes/inkd/workers').runReminderTick().then(()=>process.exit(0))"
   ```
3. Expected: pending recipients receive a reminder email; `inkd_audit_events` has a `reminder_sent` row.
4. Test expiry: set `expires_at < now()` on an envelope, run the tick, confirm status flips to `'expired'`.

- [ ] **Step 4: Commit**

```bash
cd propspot-os
git add routes/inkd/workers.js server.js
git commit -m "feat(inkd): reminder + expiry worker (5-min tick)"
```

---

## Final verification + PR

### Task F.1: End-to-end smoke

- [ ] **Step 1: Full happy path**

  1. Create a template with text + signature fields, tag autofills
  2. Send envelope from a property page with 2 recipients (yourself x2 different emails)
  3. Both sign
  4. Verify envelope lands in Completed (review)
  5. Click Save to Files
  6. Verify PDF appears on the property's Files page
  7. Verify audit trail in envelope detail page

- [ ] **Step 2: Negative paths**

  1. Try voiding a draft → succeeds
  2. Try voiding a completed envelope → either succeed or sensibly refuse (current code allows it; that's acceptable v1)
  3. Try opening a tampered signing URL (change one hex char) → expect "Invalid or expired"
  4. Decline a signature → verify status = `declined`, envelope status remains `partial`
  5. Re-hash the downloaded final PDF and compare to `inkd_envelopes.final_pdf_hash` — must match

### Task F.2: Open a PR

- [ ] **Step 1: Push branch + open PR**

```bash
cd "/Users/jordanshutts/Library/Mobile Documents/com~apple~CloudDocs/Claude/propspot"
git push -u origin claude/inkd-implementation
gh pr create --title "Ink'd: in-PropSpot document signing app" --body "$(cat <<'EOF'
## Summary

Implements Ink'd per `docs/superpowers/specs/2026-05-26-inkd-signing-app-design.md` — a fully in-house, in-PropSpot e-signature engine with PDF templates, PropSpot autofill, email-based signing, audit trail + SHA-256 certificate, and a review-before-Files queue.

## Test plan
- [ ] Schema migrates cleanly on deploy (initDb logs)
- [ ] Create template with mixed fields + autofills
- [ ] Send envelope from property page, complete with 2 signers
- [ ] Verify final PDF has stamped fields + certificate page
- [ ] Verify hash matches between stored value and re-hashed download
- [ ] Save to Files → appears on property
- [ ] Reminders fire on a back-dated envelope
- [ ] Expiry transitions an old envelope

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Wait for Railway preview, verify deploy logs, sanity-check production**

---

## Self-review checklist (run after the plan is complete)

This is for the engineer (or planning agent) to verify before execution starts.

- [ ] Every spec section in `2026-05-26-inkd-signing-app-design.md` is covered:
  - §4 where it lives — Task 0.1 + 1.1 (no separate Railway service confirmed)
  - §5 data model — Task 1.1
  - §6 modules — Tasks across phases 1–7 (template editor 2.2, composer 3.3, signer 4.4, signing engine 5.2/5.3, files promotion 6.1, workers 7.1, audit logger 1.3)
  - §7 tech stack — pdf-lib + signature_pad installed in Task 0.1; PDF.js loaded via CDN
  - §8 field types + autofill — covered in 1.4 / 1.5 / 2.1 / 3.1
  - §9 recipient flow — sequential + parallel handled in envelopes.js + signing.js notifyNextBatchIfReady
  - §10 audit + tamper evidence — Task 1.3 logger + Task 5.2 hash + Task 6.5 audit endpoint + Task 6.1 hash re-verify on file
  - §11 delivery — Task 4.1 email helper + Task 4.2 send endpoint + Task 7.1 reminders
  - §12 dashboard + review-before-Files — Task 6.2 (5 lanes) + Task 6.1 (Save-to-Files)
  - §13 permissions — every authenticated route uses `requireAuth`; signing router is intentionally public
- [ ] No placeholders, TBDs, or "implement later" markers remain
- [ ] Function/property names used in later tasks match their definitions (e.g., `notifyNextBatchIfReady`, `runReminderTick`, `buildSignedPdf`, `pctToPdfRect`)
- [ ] Every commit ends a coherent unit of work
- [ ] Tests exist for the high-risk pure logic (tokens, autofill, coords); manual verification documented for everything else
