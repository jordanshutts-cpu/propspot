# Ink'd — In-PropSpot Document Signing App

**Status:** Design approved — ready for implementation plan
**Date:** 2026-05-26
**Owner:** Jordan Shutts

---

## 1. Overview

Ink'd is a document-signing app built inside PropSpot, similar to DocuSign / SignNow / SignWell, but native to the PropSpot data model. It handles:

- **PDF form-filling** for one-off documents (address, price, contingencies, etc.)
- **Templates** for recurring documents (purchase agreements, property disclosures, lead buyer addendums, etc.)
- **Multi-party e-signature** with sequential or parallel signing order
- **Email-based delivery** of signing links (SMS deferred to a later phase)
- **Audit trail + tamper-evident certificate** on every completed envelope
- **Review-before-Files** workflow — signed docs stage in Ink'd until a user promotes them to the property's Files page

The engine is built in-house — no third-party signing API (DocuSign, BoldSign, Dropbox Sign). All compliance, audit, and PDF flattening is implemented within PropSpot.

---

## 2. Goals

1. Send a purchase agreement from a property page in under 60 seconds (template + auto-fill + 2-click send).
2. Recipients sign without creating a PropSpot account (magic link in email).
3. Every completed envelope produces a legally defensible record: signed PDF + certificate page + SHA-256 hash + audit event log.
4. Completed envelopes are never auto-published to property Files — a human reviews + promotes.
5. Add no new paid third-party dependencies in v1 (Cloudinary, nodemailer, Postgres already in place).

## 3. Non-goals (explicit YAGNI for v1)

- SMS delivery — schema-ready, sender not wired
- Bulk send (one template → N recipients in a batch)
- Conditional fields (if X then show Y)
- In-line payment collection at signing
- In-person signing ("hand the iPad" mode)
- KBA / SSN-based identity verification
- Body-text editing of the PDF (fields only; PDF text + layout are immutable once uploaded)
- Template version history UI (we'll store last-edited timestamp but no diff/restore)
- Cross-org shared template library
- Mobile-optimized signer UX beyond responsive layout (no native app)

These can be layered in later without schema breaks.

---

## 4. Where it lives

Ink'd is **not** a separate Railway service. It lives inside `propspot-os`:

```
propspot-os/
├── routes/inkd/
│   ├── templates.js          # CRUD on templates + their fields
│   ├── envelopes.js          # create, send, void, list envelopes
│   ├── recipients.js         # per-envelope recipient management
│   ├── signing.js            # public (no-auth) signer endpoints
│   ├── files-promotion.js    # "Save to Files" → property_files copy
│   └── workers.js            # reminder + expiry workers (cron-like)
├── public/
│   ├── inkd.html                  # dashboard (5 lanes)
│   ├── inkd-template-editor.html  # drag fields onto a PDF
│   ├── inkd-send.html             # compose an envelope from a template
│   ├── inkd-envelope.html         # detail view of one envelope
│   └── inkd-sign.html             # public signer page (no login)
├── lib/
│   ├── inkd-pdf.js           # pdf-lib wrapper: stamp fields, append certificate
│   ├── inkd-audit.js         # write to inkd_audit_events
│   ├── inkd-autofill.js      # resolve "property.address" → actual value
│   └── inkd-tokens.js        # mint + verify magic-link signing tokens
└── db/schema.sql             # all new tables appended here
```

Reuses propspot-os infrastructure: `requireAuth` middleware, the Postgres pool, nodemailer, Cloudinary, the activity logger.

**Launch points elsewhere in PropSpot:**

- **Sidebar entry** → Ink'd dashboard
- **Property page** → "Send document" button → opens `inkd-send.html?property_id=...`
- **Opportunity / acquisition card** → "Send document" → opens `inkd-send.html?opportunity_id=...`
- **Contact page** → "Request signature" → opens `inkd-send.html?contact_id=...`
- **Files page** → "Send for signature" on any uploaded PDF → opens one-time doc flow

---

## 5. Data model

All tables in `propspot-os/db/schema.sql` with `CREATE TABLE IF NOT EXISTS` guards.

### `inkd_templates`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT NOT NULL | "Purchase Agreement — FL" |
| category | TEXT | e.g. 'purchase-agreement', 'disclosure', 'addendum' |
| description | TEXT | freeform |
| source_pdf_url | TEXT NOT NULL | Cloudinary URL of the blank PDF |
| source_pdf_id | TEXT NOT NULL | Cloudinary public_id |
| page_count | INT NOT NULL | snapshot at upload |
| created_by | UUID FK users(id) | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| archived_at | TIMESTAMPTZ | soft delete |

### `inkd_template_fields`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| template_id | UUID FK inkd_templates(id) ON DELETE CASCADE | |
| page_number | INT NOT NULL | 1-indexed |
| x_pct | NUMERIC(6,4) | 0.0–1.0 relative position (resolution-independent) |
| y_pct | NUMERIC(6,4) | |
| width_pct | NUMERIC(6,4) | |
| height_pct | NUMERIC(6,4) | |
| field_type | TEXT NOT NULL | 'text', 'signature', 'initial', 'date', 'checkbox' |
| label | TEXT | "Buyer signature", "Purchase price", etc. |
| recipient_role | TEXT | 'buyer', 'seller', 'agent', 'witness', or custom slot name |
| required | BOOLEAN DEFAULT TRUE | |
| autofill_source | TEXT | e.g. 'property.address', 'opportunity.purchase_price', 'recipient.buyer.full_name' — NULL = no autofill |
| display_order | INT | for tab-order on signer page |

### `inkd_envelopes`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| template_id | UUID FK inkd_templates(id) | NULL for one-time docs |
| source_pdf_url | TEXT NOT NULL | snapshot of the PDF used (so template edits don't change in-flight envelopes) |
| source_pdf_id | TEXT NOT NULL | |
| page_count | INT NOT NULL | |
| name | TEXT NOT NULL | defaults to template name + property address |
| property_id | UUID FK properties(id) | nullable |
| opportunity_id | UUID FK opportunities(id) | nullable |
| contact_id | UUID FK contacts(id) | nullable |
| status | TEXT NOT NULL | 'draft', 'sent', 'partial', 'completed', 'voided', 'expired' |
| reminders_enabled | BOOLEAN DEFAULT TRUE | per-envelope toggle, set at send time |
| reminder_schedule | JSONB DEFAULT '[3,7]' | days after send to remind |
| expires_at | TIMESTAMPTZ | default send_time + 30 days |
| sent_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | all signers done |
| filed_at | TIMESTAMPTZ | when user clicked "Save to Files" |
| filed_property_file_id | UUID FK property_files(id) | the resulting Files entry |
| final_pdf_url | TEXT | Cloudinary URL of signed-and-stamped PDF (set when status → 'completed') |
| final_pdf_id | TEXT | Cloudinary public_id |
| final_pdf_hash | TEXT | SHA-256 hex of final_pdf bytes |
| created_by | UUID FK users(id) | |
| created_at | TIMESTAMPTZ | |

### `inkd_recipients`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| envelope_id | UUID FK inkd_envelopes(id) ON DELETE CASCADE | |
| role | TEXT NOT NULL | matches inkd_template_fields.recipient_role |
| full_name | TEXT NOT NULL | |
| email | TEXT NOT NULL | |
| phone | TEXT | SMS-ready column, unused in v1 |
| contact_id | UUID FK contacts(id) | nullable — populated when recipient maps to a PropSpot contact |
| signing_order | INT NOT NULL | same number = parallel; ascending = sequential |
| status | TEXT NOT NULL | 'pending', 'notified', 'viewed', 'signed', 'declined', 'expired' |
| sign_token | TEXT NOT NULL UNIQUE | magic-link token (cryptographically random, hashed in db) |
| sign_token_expires_at | TIMESTAMPTZ | |
| notified_at | TIMESTAMPTZ | |
| viewed_at | TIMESTAMPTZ | |
| signed_at | TIMESTAMPTZ | |
| signed_ip | INET | |
| signed_user_agent | TEXT | |
| decline_reason | TEXT | |

### `inkd_field_values`
Stores the actual filled-in values per envelope per field. Populated at draft creation (autofill) + as recipients sign.

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| envelope_id | UUID FK inkd_envelopes(id) ON DELETE CASCADE | |
| template_field_id | UUID FK inkd_template_fields(id) | NULL for ad-hoc fields on one-time docs |
| page_number | INT | denormalized for one-time docs |
| x_pct, y_pct, width_pct, height_pct | NUMERIC | denormalized for one-time docs |
| field_type | TEXT | |
| label | TEXT | |
| recipient_id | UUID FK inkd_recipients(id) | which recipient owns this field (NULL for sender-filled) |
| value | TEXT | text content, ISO date, 'true'/'false', or signature image URL |
| value_filled_at | TIMESTAMPTZ | |
| value_filled_by | UUID FK users(id) | NULL when filled by a recipient (signer) |
| autofilled | BOOLEAN DEFAULT FALSE | true if pulled from autofill_source at draft creation |

Signature/initial fields store the canvas drawing as a transparent PNG in Cloudinary; `value` holds the URL.

### `inkd_audit_events`
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | |
| envelope_id | UUID FK inkd_envelopes(id) ON DELETE CASCADE | |
| recipient_id | UUID FK inkd_recipients(id) | nullable (sender-initiated events have no recipient) |
| event_type | TEXT NOT NULL | 'created', 'sent', 'viewed', 'started', 'field_filled', 'signed', 'declined', 'reminder_sent', 'voided', 'expired', 'filed_to_property' |
| event_at | TIMESTAMPTZ DEFAULT now() | |
| ip | INET | |
| user_agent | TEXT | |
| user_id | UUID FK users(id) | sender / admin user, when applicable |
| details | JSONB | event-specific payload (e.g. {field_id, label} for field_filled) |

Indexes: `(envelope_id, event_at)` for the audit timeline query.

---

## 6. Modules

### 6.1 Template editor — `public/inkd-template-editor.html`
- Upload a PDF → server stores in Cloudinary, returns `source_pdf_url` + `page_count`
- PDF.js renders pages in a scrollable view
- User drags field rectangles onto pages: pick type (text / signature / initial / date / checkbox), label, recipient role, autofill source
- Coordinates stored as **percentages** (0.0–1.0) of page width/height so they're resolution-independent
- Autofill source dropdown lists every available path (see §8)
- Save → POST to `/api/inkd/templates` (creates template + all fields)

### 6.2 Envelope composer — `public/inkd-send.html`
- Entered from a template + an entity (property / opportunity / contact) — or from an uploaded one-time PDF
- **One-time docs:** instead of picking a template, the composer lets the user upload a PDF and drop fields directly. Fields are stored as `inkd_field_values` rows with denormalized coords (template_field_id = NULL). No `inkd_template` row is created.
- Server pre-computes autofilled values for every field with an `autofill_source`
- UI shows PDF preview with fields overlaid + a sidebar of recipient slots and field values
- Sender can edit any autofilled value before sending
- Sender adds recipient details (name, email, signing_order) for each role
- **Reminders toggle** at the bottom — on by default, can be flipped off per envelope
- Hit **Send** → POST `/api/inkd/envelopes` with status='sent', kicks off delivery worker

### 6.3 Signer page — `public/inkd-sign.html?token=...` (public, no auth)
- Token resolves to recipient + envelope
- Renders PDF with only THIS recipient's fields highlighted/enabled
- Other recipients' fields shown in faded read-only state
- Sender-filled fields shown read-only with their values baked in
- Signature/initial fields open a modal: draw on canvas OR type cursive
- On Finish → POST `/api/inkd/signing/complete` → updates `inkd_field_values` + `inkd_recipients.signed_at` + writes audit event
- If sequential and more recipients remain → triggers next recipient's notification
- If all signed → triggers signing engine (§6.4)

### 6.4 Signing engine — `lib/inkd-pdf.js`
Triggered when the last recipient signs.

1. Load `source_pdf_url` from Cloudinary as bytes (pdf-lib)
2. For each `inkd_field_values` row: stamp text / signature image / checkbox onto the right page at the percentage coords (convert to absolute coords using each page's actual pt dimensions)
3. Append a **certificate page** at the end:
   - Envelope ID + name + creation date
   - Table of recipients: name, email, IP, signed_at (UTC)
   - Audit event timeline (created → sent → views → signs)
   - "Document hash (SHA-256): [hex]"
4. Serialize → bytes
5. SHA-256 the bytes → store as `final_pdf_hash`
6. Upload to Cloudinary → store URL + public_id on envelope
7. Update envelope status → `completed`, `completed_at = now()`
8. **DO NOT** auto-add to `property_files` (the review gate is the user clicking "Save to Files")
9. Send "envelope completed" email to the sender

### 6.5 Files promotion — `lib/files-promotion.js` (one route handler)
When user clicks "Save to Files" on a completed envelope:
1. Verify envelope status is `completed`
2. Re-hash the `final_pdf_url` bytes, compare to stored `final_pdf_hash` (paranoia check — Cloudinary is trusted, but if hashes diverge we error out)
3. Insert into `property_files` with property_id = envelope.property_id (or opportunity → property mapping)
4. Set `envelope.filed_at`, `envelope.filed_property_file_id`
5. Write `filed_to_property` audit event

### 6.6 Delivery + reminder worker — `routes/inkd/workers.js`
Triggered on a `setInterval` (every 5 min) inside server.js — same pattern propspot-os uses for the activity logger.

- For envelopes with status='sent' or 'partial' AND reminders_enabled=true: check if `(now - sent_at).days` is in `reminder_schedule` AND the recipient hasn't been reminded yet today → send reminder email, write `reminder_sent` event
- For envelopes with `expires_at < now` AND status in ('sent','partial') → mark expired, write event, notify sender
- Daily cleanup: nothing to delete (audit trail is permanent)

### 6.7 Audit logger — `lib/inkd-audit.js`
Single helper: `logAudit({ envelopeId, recipientId, eventType, req, details })`. Pulls IP + user-agent from `req`. Every state-changing route calls this.

---

## 7. Tech stack

| Need | Library | Notes |
|---|---|---|
| Render PDFs in the browser | **PDF.js** (Mozilla, Apache 2.0) | already battle-tested, supports lazy page render |
| Stamp + flatten PDFs server-side | **pdf-lib** (npm, MIT) | pure JS, no native deps, runs fine on Railway |
| Capture signature drawings | **signature_pad** (npm, MIT) | canvas-based, smooth curves, exports PNG |
| Email | **nodemailer** | already in propspot-os |
| File storage | **Cloudinary** | already in propspot-os, handles non-image resources fine |
| Database | **Postgres** | already the propspot-os primary store |
| Magic-link tokens | Node's `crypto.randomBytes(32)` + bcrypt-hashed for storage | no new lib |
| SMS (deferred) | (none) | `inkd_recipients.phone` column reserved for future |

**No new paid services for v1.**

---

## 8. Field types + autofill

### Field types (v1)
- **text** — free text input
- **signature** — full signature drawing
- **initial** — abbreviated signature drawing
- **date** — date picker, stored as ISO 8601
- **checkbox** — true/false

Future: dropdown, radio, attachment-upload, number-with-validation. None for v1.

### Autofill source library
The template editor exposes a dropdown of available autofill paths. Sources:

- **Property** — every column on `properties`: address, city, state, zip, parcel_id, year_built, square_feet, beds, baths, etc.
- **Opportunity** — every column on `opportunities`: purchase_price, earnest_money, closing_date, contingency_period_days, etc.
- **Contact (by role)** — `recipient.<role>.full_name`, `.email`, `.phone`, `.company`, etc. Resolves to the recipient assigned to that role on the envelope.
- **Current user / sender** — `user.full_name`, `user.email`, `user.license_number` (if we add this to users) — for the agent-name field
- **Computed** — `today` (ISO date), `today_long` ("May 26, 2026"), `envelope.id`

Resolution happens server-side at draft creation. Unresolvable paths → field left blank with a yellow "needs attention" highlight in the composer.

---

## 9. Recipient flow

- Each recipient row has a `signing_order` integer (default = 1 if the composer doesn't set it; the composer assigns 1, 2, 3, … as recipients are added).
- **Ascending order = sequential.** Recipient with order=1 is notified first. When they finish, the worker checks if there are more recipients with the same order (parallel batch) — if not, advances to next order and notifies them.
- **Same order = parallel.** All recipients with order=2 get notified at the same time.
- **Default for new envelopes:** order=1 for the sender's primary counterparty (buyer or seller), order=2 for the second party, order=3 for agents/witnesses.
- Recipients do **not** need a PropSpot account. The magic-link URL is sufficient identity.
- Magic-link tokens: 32 bytes of crypto.randomBytes, hex-encoded, hashed with bcrypt before storage. Verified by comparing the URL token against the bcrypt hash. Expires after 30 days (configurable per envelope).

---

## 10. Audit trail + tamper evidence

Every legally-relevant action writes a row to `inkd_audit_events`:

```
created → sent → viewed → started → field_filled (N) → signed
                                                       ↘ declined
                                                       ↘ expired
                                                       ↘ voided (by sender)
```

Plus: `reminder_sent`, `filed_to_property`.

**Certificate page** appended to the final PDF includes:
- Envelope name + ID + creation date
- Each recipient: name, email, IP at signing, user-agent, signed-at timestamp (UTC)
- Full audit event list with timestamps
- SHA-256 hash of the rest of the PDF (everything except the certificate page itself)

**Tamper detection:** the stored `final_pdf_hash` lets anyone re-download the PDF, re-hash it, and verify nothing's been altered after signing.

---

## 11. Delivery

### Email (v1)
- Initial send: nodemailer via propspot-os's existing transport
- Reminder schedule: default `[3, 7]` days after send (configurable per envelope, on/off toggle at send time)
- Templates: 4 email types — initial invite, reminder, "your turn" (when sequential turn flips), "envelope completed" (to sender)
- Each contains a unique magic-link URL to `/inkd/sign?token=...`

### SMS (deferred)
- `inkd_recipients.phone` column reserved
- Schema accommodates a future `delivery_channel` field if needed (or per-recipient toggle)
- Wiring Twilio (or alternative) post-v1 is purely additive

---

## 12. Dashboard + Review-before-Files

`public/inkd.html` shows 5 lanes (Kanban-style, matching the Acquisitions lane pattern):

1. **Drafts** — envelopes not yet sent
2. **Out for Signature** — sent, awaiting signers
3. **Action Needed** — sender's attention required (declined, expired, error)
4. **Completed (review)** — fully signed but NOT yet on the property's Files page
5. **Filed** — pushed to Files

Each Completed envelope card has:
- **Download** — get the signed PDF
- **Save to Files** — promotes to `property_files` and moves to Filed lane
- **Email a copy** — send the signed PDF to any address (used for sending the completed doc to all parties)
- **Void** — only available pre-completion

**Lane order is fixed.** Don't reorder later — follow the same convention as the Acquisitions kanban (lane order is treated as semantic, not stylistic).

---

## 13. Permissions

- All Ink'd routes (except the public `/inkd/sign` signer page) require `requireAuth`
- Any logged-in user can create templates and send envelopes (no org-role gating in v1; can layer in later via the existing `authz.js` patterns)
- Signer page: token-authenticated only — no PropSpot login required
- Promoting to Files is gated by whoever has access to that property (uses existing property ACL via `property_files` insert)

---

## 14. Open questions / future work

These don't block v1 but are worth flagging:

- **Multi-language signer UX** — currently English only
- **Mobile signing experience** — responsive, but a tap-to-sign UX on phone could be improved
- **Template categories / folders** — flat list in v1; folders if Jordan ever has >30 templates
- **Bulk send** — explicitly out for v1; design accommodates by allowing multiple envelopes from the same template
- **SMS delivery** — schema-ready; needs Twilio or alternative wired in
- **Template diff / version restore** — currently no version history; if a state form changes, the recommended path is to clone-and-edit, archive the old template

---

## 15. Success criteria

We'll know v1 is done when:

1. A user can upload a blank Florida Purchase Agreement PDF, drag ~25 fields onto it, save it as a template, tag autofill sources, and send it from a property page with all autofilled values correct.
2. Two recipients (buyer, seller) receive emails, click links, sign in browser (no login), and the envelope reaches "Completed (review)" status.
3. The signed PDF includes all field values, both signatures rendered cleanly, and a certificate page with the audit trail.
4. SHA-256 of the final PDF matches the stored hash.
5. Clicking "Save to Files" moves the PDF to that property's Files page and the envelope moves to the "Filed" lane.
6. A declined or expired envelope shows up in "Action Needed" with no data loss.

---

## 16. References

- PropSpot deploy + local-preview workflow: `~/.claude/.../memory/reference_propspot_deploy.md`
- Acquisitions lane ordering convention: see CLAUDE.md
- Existing property_files pattern: `propspot-os/routes/property-files.js`
- pdf-lib docs: https://pdf-lib.js.org/
- PDF.js docs: https://mozilla.github.io/pdf.js/
- signature_pad: https://github.com/szimek/signature_pad
