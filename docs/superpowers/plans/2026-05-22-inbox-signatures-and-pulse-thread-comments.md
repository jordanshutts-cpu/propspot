# Inbox HTML Signatures + Pulse Thread Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-shared-inbox HTML email signatures and @-mentioned comments under email threads — the comments built as a generic Pulse entity-comments subsystem with an embed widget Inbox drops into its existing `#pulse-slot` div.

**Architecture:** All schema changes go into the shared `propspot-os/db/schema.sql` (single source of truth, idempotent). Signatures are a column on `inbox_shared`, appended in Inbox's `lib/threading.js` send pipeline. Pulse gains a new `pulse_entity_threads` table and reuses `chat_messages` (with a new nullable `entity_thread_id` column) so all of its existing mention/SSE/edit plumbing is reused. A vanilla-JS widget at `pulse.propspot.io/widget.js` renders into Inbox's `<div id="pulse-slot">` and authenticates via an explicit `window.PULSE_AUTH` handoff.

**Tech Stack:** Express 4 + node-postgres + JWT + vanilla JS + Cloudinary (already wired). No new dependencies. No build step — propspot apps run plain JS server-side and serve plain HTML/JS/CSS to the browser.

**Test Strategy:** The propspot codebase has no automated test infrastructure (no `*.test.js`, no `package.json` test script in any satellite). Following existing conventions, each task includes explicit manual verification steps — curl commands for backend, browser walkthroughs for UI. Do NOT introduce a test framework as part of this work; that's a separate decision.

**Spec:** [docs/superpowers/specs/2026-05-22-inbox-signatures-and-pulse-thread-comments-design.md](../specs/2026-05-22-inbox-signatures-and-pulse-thread-comments-design.md)

**Branch:** `claude/inbox-signatures-pulse-comments` (already created off `main`, spec committed)

---

## File Map

**Created:**
- `pulse/lib/authz.js` — entity-thread authz helper (ambient view check + grants check)
- `pulse/lib/mentions.js` — `<@uuid>` parser + grant writer
- `pulse/routes/entity-threads.js` — REST endpoints for entity-thread comments
- `pulse/public/widget.js` — vanilla-JS embed widget
- `pulse/public/widget.css` — widget styles

**Modified:**
- `propspot-os/db/schema.sql` — append new tables / columns / view (idempotent)
- `inbox/lib/threading.js` — `buildRawMessage()` accepts `signatureHtml`
- `inbox/routes/shared-inboxes.js` — PATCH allows `signature_html`; GET returns it
- `inbox/routes/messages.js` — load signature for thread/compose, append on send
- `inbox/public/admin-shared.html` — signature editor card
- `inbox/public/app.js` — add `updateSharedInboxSignature(...)` helper if not generic enough
- `inbox/public/thread.html` — `include_signature` checkbox + `window.PULSE_AUTH` handoff + widget script tag
- `inbox/public/inbox.html` — `include_signature` checkbox in compose modal + per-thread `💬N` chips
- `pulse/server.js` — mount `entity-threads` route + expanded CORS allowlist
- `pulse/routes/stream.js` — accept `entity_thread_id` (or `entity_type`+`entity_id`) as a subscribe target with authz check
- `pulse/routes/messages.js` — extract mention parsing into the shared `lib/mentions.js` (refactor; same behavior for channel/DM messages, plus new behavior for entity-thread messages)

---

## Task 1: Schema migration — signatures + entity-threads + grants + authz view

**Files:**
- Modify: `propspot-os/db/schema.sql` (append at end, before the final updated_at trigger block)

- [ ] **Step 1: Open `propspot-os/db/schema.sql` and locate the inbox section**

The Inbox tables (`inbox_mailboxes`, `inbox_shared`, ...) live around line 750. The Pulse tables (`chat_channels`, `chat_messages`, ...) live around line 626. The `updated_at` trigger block lives near the end (~line 914). All schema additions in this task go BEFORE that trigger block but AFTER all the existing inbox/pulse table definitions.

- [ ] **Step 2: Append the migration block to `propspot-os/db/schema.sql`**

Insert this block just before the `-- ── updated_at triggers ─────...` line (~line 914):

```sql
-- ── 2026-05-22: Inbox HTML signatures + Pulse entity-comments ──────────────

-- A) Per-shared-inbox HTML signature. NULL/empty = no signature appended.
ALTER TABLE inbox_shared
  ADD COLUMN IF NOT EXISTS signature_html TEXT;

-- B) Pulse entity-threads — one row per "comments-on-external-entity" thread.
-- entity_id has no FK so Pulse stays decoupled from consumer apps' tables.
CREATE TABLE IF NOT EXISTS pulse_entity_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS pulse_entity_threads_lookup_idx
  ON pulse_entity_threads(entity_type, entity_id);

-- C) chat_messages picks up a third optional target (entity_thread_id).
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS entity_thread_id UUID
    REFERENCES pulse_entity_threads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS chat_messages_entity_thread_idx
  ON chat_messages(entity_thread_id, created_at);

-- D) Swap the channel-xor-dm check for channel-xor-dm-xor-entity_thread.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_target_check') THEN
    ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_target_check;
  END IF;
  ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_target_check
    CHECK (
      (channel_id       IS NOT NULL)::int +
      (dm_id            IS NOT NULL)::int +
      (entity_thread_id IS NOT NULL)::int = 1
    );
END $$;

-- E) Per-(user, entity_thread) read grants. Mention writes a row here;
-- ambient access (owner / inbox-grant) is computed via the authz view below.
CREATE TABLE IF NOT EXISTS pulse_entity_thread_grants (
  entity_thread_id UUID NOT NULL REFERENCES pulse_entity_threads(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id)                ON DELETE CASCADE,
  granted_via      TEXT NOT NULL,
  granted_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS pulse_entity_thread_grants_user_idx
  ON pulse_entity_thread_grants(user_id);

-- F) Ambient-authz view for entity_type='inbox_thread'.
-- Each row = "user U has ambient access to inbox_thread T because they're
-- an owner OR their inbox app_grant covers the thread's shared inbox."
CREATE OR REPLACE VIEW pulse_authz_inbox_thread AS
SELECT t.id AS entity_id, u.id AS user_id
  FROM inbox_threads t
  CROSS JOIN users u
  LEFT JOIN app_grants ag
    ON ag.user_id = u.id
   AND ag.app_id  = (SELECT id FROM apps WHERE slug = 'inbox')
 WHERE u.is_owner = TRUE
    OR (ag.scope ? 'all')
    OR (
      ag.scope ? 'inbox_ids'
      AND t.shared_inbox_id IS NOT NULL
      AND (ag.scope->'inbox_ids') @> to_jsonb(t.shared_inbox_id::text)
    );
```

- [ ] **Step 3: Add `pulse_entity_threads` to the `updated_at` trigger list**

In the `DO $$ ... LOOP` block at the bottom of `schema.sql` (around line 921), the array currently is:

```sql
'properties','contacts','prospects','leads','opportunities','purchases','projects',
'holdings_items','holdings_payments','holdings_documents',
'work_orders','lawn_maintenance',
'chat_channels',
'inbox_threads'
```

Add `'pulse_entity_threads'` so it becomes:

```sql
'properties','contacts','prospects','leads','opportunities','purchases','projects',
'holdings_items','holdings_payments','holdings_documents',
'work_orders','lawn_maintenance',
'chat_channels',
'inbox_threads',
'pulse_entity_threads'
```

- [ ] **Step 4: Apply the migration locally**

Run the schema against the dev database (or Railway preview branch):

```bash
psql "$DATABASE_URL" -f propspot-os/db/schema.sql
```

Expected: no errors. All `IF NOT EXISTS` / `DROP IF EXISTS` guards make this safe to re-run.

- [ ] **Step 5: Verify migration applied**

```bash
psql "$DATABASE_URL" -c "
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'inbox_shared' AND column_name = 'signature_html') AS sig_col,
    EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'pulse_entity_threads') AS et_table,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'chat_messages' AND column_name = 'entity_thread_id') AS et_col,
    EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'pulse_entity_thread_grants') AS grant_table,
    EXISTS (SELECT 1 FROM information_schema.views
             WHERE table_name = 'pulse_authz_inbox_thread') AS authz_view;
"
```

Expected: all five booleans return `t`.

- [ ] **Step 6: Verify the constraint swap kept the table sane**

```bash
psql "$DATABASE_URL" -c "
  SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
   WHERE conrelid = 'chat_messages'::regclass
     AND conname = 'chat_messages_target_check';
"
```

Expected: definition shows the `= 1` sum-of-target form.

- [ ] **Step 7: Commit**

```bash
git add propspot-os/db/schema.sql
git commit -m "$(cat <<'EOF'
Schema: inbox signatures + Pulse entity-comments tables

- inbox_shared.signature_html (TEXT, NULL = no signature appended)
- pulse_entity_threads (entity_type, entity_id) — one row per external-entity comment thread
- chat_messages.entity_thread_id (nullable FK) — third optional target alongside channel/DM
- Swapped chat_messages_target_check to enforce exactly-one of (channel, DM, entity_thread)
- pulse_entity_thread_grants — per-(user, thread) mention-derived read grants
- pulse_authz_inbox_thread view — owner + inbox-grant ambient access

Idempotent — safe to re-run schema.sql.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Inbox — extend `buildRawMessage()` to append signature

**Files:**
- Modify: `inbox/lib/threading.js` (function `buildRawMessage`, ~line 110)

- [ ] **Step 1: Read the current `buildRawMessage` signature**

The function currently accepts `{ from, to, cc, subject, bodyText, bodyHtml, inReplyTo, references }` and emits a multipart/alternative MIME body.

- [ ] **Step 2: Add a tiny HTML→text fallback helper**

At the top of `inbox/lib/threading.js`, add a private helper above `function parseGmailMessage(...)`:

```javascript
// Crude HTML → plain text. Strips tags, decodes a handful of entities,
// collapses whitespace. Good enough for the plain-text branch of a multipart
// email when all we have is the HTML signature. Don't reuse for arbitrary
// untrusted HTML — this isn't a sanitizer.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r?\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 3: Extend `buildRawMessage` to accept and append `signatureHtml`**

Replace the existing function body (between `function buildRawMessage(...)` and the closing `}`) with:

```javascript
function buildRawMessage({ from, to, cc, subject, bodyText, bodyHtml, inReplyTo, references, signatureHtml }) {
  const toList = Array.isArray(to) ? to.join(', ') : (to || '');
  const ccList = Array.isArray(cc) ? cc.join(', ') : (cc || '');
  const boundary = 'inbox-' + Math.random().toString(36).slice(2);

  const sig = (signatureHtml || '').trim();
  const finalHtml = bodyHtml
    ? (sig ? `${bodyHtml}<br><br>--<br>${sig}` : bodyHtml)
    : (sig
        ? `<pre>${(bodyText || '').replace(/[<>&]/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[ch]))}</pre><br><br>--<br>${sig}`
        : `<pre>${(bodyText || '').replace(/[<>&]/g, ch => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[ch]))}</pre>`);
  const finalText = sig
    ? `${bodyText || ''}\n\n-- \n${htmlToText(sig)}`
    : (bodyText || '');

  const lines = [
    `From: ${from}`,
    `To: ${toList}`,
    ccList ? `Cc: ${ccList}` : null,
    `Subject: ${subject || ''}`,
    inReplyTo  ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    finalText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    finalHtml,
    '',
    `--${boundary}--`,
    ''
  ].filter(Boolean);
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
```

- [ ] **Step 4: Sanity-check the change locally**

Open a node REPL inside `inbox/`:

```bash
cd inbox && node -e "
const { buildRawMessage } = require('./lib/threading');
const raw = buildRawMessage({
  from: 'a@b.com', to: 'c@d.com', subject: 'hi',
  bodyText: 'body', bodyHtml: '<p>body</p>',
  signatureHtml: '<p>Best,<br><b>Jordan</b></p>'
});
const decoded = Buffer.from(raw.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString();
console.log(decoded);
"
```

Expected: output contains both `<p>body</p><br><br>--<br><p>Best,<br><b>Jordan</b></p>` in the HTML part AND `body\n\n-- \nBest,\nJordan` in the text part.

- [ ] **Step 5: Verify no-signature case still works**

```bash
cd inbox && node -e "
const { buildRawMessage } = require('./lib/threading');
const raw = buildRawMessage({
  from: 'a@b.com', to: 'c@d.com', subject: 'hi',
  bodyText: 'body', bodyHtml: '<p>body</p>'
});
const decoded = Buffer.from(raw.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString();
console.log(decoded);
"
```

Expected: no `--` separator anywhere; HTML body is just `<p>body</p>`, text body is just `body`.

- [ ] **Step 6: Commit**

```bash
git add inbox/lib/threading.js
git commit -m "$(cat <<'EOF'
inbox: buildRawMessage accepts optional signatureHtml

When provided, appends after a "--" separator in both the HTML and
plain-text branches of the multipart message. Plain-text branch uses a
crude HTML-tag stripper — fine for signatures (which are owner-edited
HTML, not arbitrary input).

No behavior change for callers that don't pass signatureHtml.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Inbox — expose `signature_html` on shared-inboxes API

**Files:**
- Modify: `inbox/routes/shared-inboxes.js`

- [ ] **Step 1: Add `signature_html` to GET `/api/shared-inboxes`**

The existing GET handler `SELECT i.id, i.slug, i.name, i.description, i.icon, i.created_at, ...` (around line 21) needs to also return `signature_html`. Update the SELECT to include it:

```javascript
const { rows } = await query(`
  SELECT i.id, i.slug, i.name, i.description, i.icon, i.signature_html, i.created_at,
         (SELECT COUNT(*) FROM inbox_threads t
           WHERE t.shared_inbox_id = i.id AND t.status = 'open')::int AS open_count,
         (SELECT COUNT(*) FROM inbox_threads t
           WHERE t.shared_inbox_id = i.id AND t.status = 'open' AND t.unread = TRUE)::int AS unread_count
    FROM inbox_shared i
    ${where}
ORDER BY i.name ASC
`, params);
```

- [ ] **Step 2: Extend the PATCH allowed-fields list**

Locate the PATCH handler (~line 54). The `allowed` array currently lists `['name', 'description', 'icon']`. Add `signature_html`:

```javascript
const allowed = ['name', 'description', 'icon', 'signature_html'];
```

That's the only PATCH change — the existing dynamic-SET loop handles it.

- [ ] **Step 3: Verify locally via curl**

Start the inbox dev server (`cd inbox && npm run dev` or whatever the project uses — `npm start` if no dev script).

Get a JWT from logging in via `os.propspot.io` in a browser (copy from devtools localStorage `inbox_token`), or from the dev test login flow if one exists. Export it:

```bash
TOK="paste-token-here"
INBOX_ID=$(curl -s -H "Authorization: Bearer $TOK" http://localhost:PORT/api/shared-inboxes | jq -r '.[0].id')

# GET should include signature_html (initially null)
curl -s -H "Authorization: Bearer $TOK" http://localhost:PORT/api/shared-inboxes | jq '.[0] | {id, name, signature_html}'

# PATCH should accept signature_html
curl -s -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"signature_html":"<p>Best,<br><b>Test</b></p>"}' \
  http://localhost:PORT/api/shared-inboxes/$INBOX_ID | jq '.signature_html'

# GET again — signature_html should now be the HTML we set
curl -s -H "Authorization: Bearer $TOK" http://localhost:PORT/api/shared-inboxes | jq '.[0].signature_html'
```

Expected: PATCH returns the row including the new signature_html; GET reflects it.

- [ ] **Step 4: Commit**

```bash
git add inbox/routes/shared-inboxes.js
git commit -m "$(cat <<'EOF'
inbox: shared-inboxes API surfaces signature_html on GET + PATCH

- GET /api/shared-inboxes returns signature_html alongside name/icon/etc.
- PATCH /api/shared-inboxes/:id adds signature_html to allowed fields list.
- Existing requireOwner gate still applies to PATCH.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Inbox — apply signature when sending reply or compose

**Files:**
- Modify: `inbox/routes/messages.js`

- [ ] **Step 1: Update the reply route to load + apply signature**

In `inbox/routes/messages.js`, the `POST /threads/:id/reply` handler is around line 37. We need to:

a) Pull `signature_html` from `inbox_shared` for the thread's shared inbox.
b) Respect `req.body.include_signature` (default `true`).
c) Pass `signatureHtml` to `buildRawMessage`.

Replace the section starting with `const fromAlias = ...` (around line 51) through the `const raw = buildRawMessage(...)` block with:

```javascript
const fromAlias = req.body.from_alias || thread.reply_from_alias || thread.mailbox_email;
const subject = thread.subject?.startsWith('Re:') ? thread.subject : `Re: ${thread.subject || ''}`;
const messageIdHeader = lastHeaders['Message-Id'] || lastHeaders['Message-ID'] || null;
const referencesHeader = lastHeaders['References']
  ? `${lastHeaders['References']} ${messageIdHeader || ''}`.trim()
  : messageIdHeader || null;

// Load signature when caller didn't opt out.
const includeSig = req.body.include_signature !== false;
let signatureHtml = null;
if (includeSig && thread.shared_inbox_id) {
  const { rows: sigRows } = await query(
    `SELECT signature_html FROM inbox_shared WHERE id = $1`,
    [thread.shared_inbox_id]
  );
  signatureHtml = sigRows[0]?.signature_html || null;
}

const raw = buildRawMessage({
  from: fromAlias,
  to: replyTo,
  cc: req.body.cc,
  subject,
  bodyText: req.body.body_text,
  bodyHtml: req.body.body_html,
  inReplyTo: messageIdHeader,
  references: referencesHeader,
  signatureHtml
});
```

- [ ] **Step 2: Update the compose route the same way**

The `POST /compose` handler is around line 94. After the `routeRows` lookup (which already resolves `sharedInboxId`), update the `buildRawMessage` call. Locate this block (around line 113):

```javascript
const raw = buildRawMessage({
  from: from_alias,
  to,
  cc,
  subject,
  bodyText: body_text,
  bodyHtml: body_html
});
```

Replace with:

```javascript
const includeSig = req.body.include_signature !== false;
let signatureHtml = null;
if (includeSig && sharedInboxId) {
  const { rows: sigRows } = await query(
    `SELECT signature_html FROM inbox_shared WHERE id = $1`,
    [sharedInboxId]
  );
  signatureHtml = sigRows[0]?.signature_html || null;
}

const raw = buildRawMessage({
  from: from_alias,
  to,
  cc,
  subject,
  bodyText: body_text,
  bodyHtml: body_html,
  signatureHtml
});
```

- [ ] **Step 3: Verify the reply path with curl**

With a shared inbox that has a signature set (Task 3 left one), and a known thread id:

```bash
TOK="..."
THREAD_ID="..."
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"body_text":"hi from test","include_signature":true}' \
  http://localhost:PORT/api/messages/threads/$THREAD_ID/reply
```

Then open the corresponding Gmail thread in a browser (or fetch the message back via `GET /api/threads/$THREAD_ID`) and confirm the signature appears below the body. Repeat with `include_signature: false` — signature should be absent.

- [ ] **Step 4: Commit**

```bash
git add inbox/routes/messages.js
git commit -m "$(cat <<'EOF'
inbox: messages route loads + appends signature on send

Reply and compose both:
- look up the resolved shared_inbox's signature_html,
- pass it through to buildRawMessage,
- skip it when include_signature: false in the request body.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Inbox — signature editor in `admin-shared.html`

**Files:**
- Modify: `inbox/public/admin-shared.html`

- [ ] **Step 1: Add CSS for the signature card**

In the `<style>` block at the top of `admin-shared.html`, append (before the closing `</style>`):

```css
.sig-card { margin-top: 16px; }
.sig-editor { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 880px) { .sig-editor { grid-template-columns: 1fr; } }
.sig-editor textarea { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: .82rem; height: 220px; }
.sig-preview { border: 1px solid var(--border); border-radius: var(--radius); background: #fff; overflow: hidden; }
.sig-preview iframe { width: 100%; min-height: 220px; border: 0; }
.sig-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
```

- [ ] **Step 2: Add the signature card markup**

In the right column of `.admin-grid` — after the existing members `<section>` closes — insert a new section. Find this block (around line 45):

```html
<section>
  <div class="section-header">
    <span class="section-title" id="member-title">Pick a shared inbox →</span>
  </div>
  <div class="card"><div id="member-list"></div></div>
</section>
```

Add a new section RIGHT AFTER it, inside the same right column wrapper. So the right column becomes:

```html
<div>
  <section>
    <div class="section-header">
      <span class="section-title" id="member-title">Pick a shared inbox →</span>
    </div>
    <div class="card"><div id="member-list"></div></div>
  </section>

  <section class="sig-card" id="sig-card" style="display:none;">
    <div class="section-header">
      <span class="section-title">Email signature</span>
      <span class="text-muted text-sm">Appended to outgoing mail from this shared inbox.</span>
    </div>
    <div class="card" style="padding:14px;">
      <div class="sig-editor">
        <div>
          <label class="form-label">HTML</label>
          <textarea id="sig-html" class="form-textarea" placeholder="<p>Best,<br><b>Jordan</b></p>"></textarea>
        </div>
        <div>
          <label class="form-label">Preview</label>
          <div class="sig-preview"><iframe id="sig-preview" sandbox=""></iframe></div>
        </div>
      </div>
      <div class="sig-actions">
        <button class="btn btn-secondary" onclick="clearSignature()">Clear</button>
        <button class="btn btn-primary" onclick="saveSignature()">Save signature</button>
      </div>
    </div>
  </section>
</div>
```

You'll need to wrap the existing right-column `<section>` in a `<div>` so the new `<section>` joins it. Match the existing `.admin-grid` 2-column layout — adjust if the existing structure uses different wrappers.

- [ ] **Step 3: Wire the signature UI to load on select**

In the existing `<script>` block, locate `async function selectShared(id) { ... }` (around line 129). After it loads members, also load the signature. Update it:

```javascript
async function selectShared(id) {
  ACTIVE = SHARED.find(s => s.id === id);
  await loadShared();
  document.getElementById('member-title').textContent = `Members of "${ACTIVE.name}"`;
  await loadMembers();
  loadSignature();  // ← new
}
```

Then add new helper functions at the bottom of the `<script>` block, before the final `init();` line:

```javascript
function loadSignature() {
  const card = document.getElementById('sig-card');
  if (!ACTIVE) { card.style.display = 'none'; return; }
  card.style.display = '';
  const html = ACTIVE.signature_html || '';
  document.getElementById('sig-html').value = html;
  renderSignaturePreview(html);
}

function renderSignaturePreview(html) {
  const iframe = document.getElementById('sig-preview');
  iframe.srcdoc = html || '<p style="color:#888;font-family:sans-serif;padding:12px;">No signature set.</p>';
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'sig-html') {
    renderSignaturePreview(e.target.value);
  }
});

async function saveSignature() {
  const html = document.getElementById('sig-html').value;
  try {
    const updated = await patchSharedInbox(ACTIVE.id, { signature_html: html });
    ACTIVE.signature_html = updated.signature_html;
    // refresh in-memory list so future selects show the new value
    const i = SHARED.findIndex(s => s.id === ACTIVE.id);
    if (i >= 0) SHARED[i] = { ...SHARED[i], signature_html: updated.signature_html };
    showToast('Signature saved');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function clearSignature() {
  document.getElementById('sig-html').value = '';
  renderSignaturePreview('');
}
```

- [ ] **Step 4: Add the `patchSharedInbox` API helper**

`inbox/public/app.js` defines a thin `apiFetch(path, options)` helper around `fetch(API_BASE + path, …)` (where `API_BASE = ''` from `config.js`) and bearer-injects the token automatically. Existing CRUD helpers (`createSharedInbox`, `listSharedInboxes`, etc.) use it. Add `patchSharedInbox` next to them, following the same pattern. Open `inbox/public/app.js`, search for `async function createSharedInbox`, and append right after that function:

```javascript
async function patchSharedInbox(id, body) {
  return apiFetch(`/api/shared-inboxes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}
```

`apiFetch` already sets `Content-Type: application/json` + Authorization header + throws on non-2xx, so no need to reimplement that here.

- [ ] **Step 5: Manual verification in browser**

Start the inbox dev server. Open `http://localhost:PORT/admin-shared.html`. Pick a shared inbox. The new "Email signature" card appears below members. Type some HTML in the textarea — preview updates live. Click Save — toast shows "Signature saved." Refresh the page, re-select the same inbox — the saved HTML is still there.

- [ ] **Step 6: Commit**

```bash
git add inbox/public/admin-shared.html inbox/public/app.js
git commit -m "$(cat <<'EOF'
inbox: signature editor card on admin-shared.html

Per-shared-inbox HTML signature: raw textarea (left) + live sandboxed
iframe preview (right). Save calls PATCH /api/shared-inboxes/:id.
Card hides until a shared inbox is selected.

Adds patchSharedInbox() helper in public/app.js for the API call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Inbox — "Include signature" checkbox on reply + compose

**Files:**
- Modify: `inbox/public/thread.html`
- Modify: `inbox/public/inbox.html`

- [ ] **Step 1: Reply form — add checkbox to `thread.html`**

In `inbox/public/thread.html`, locate the reply form (~line 57):

```html
<div class="reply-box">
  <form onsubmit="submitReply(event)">
    <div class="form-group">
      <label class="form-label">Reply to <span id="t-reply-to"></span></label>
      <textarea class="form-textarea" id="reply-body" rows="6" placeholder="Type your reply…" required></textarea>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button type="submit" class="btn btn-primary">Send reply</button>
    </div>
  </form>
</div>
```

Replace the buttons row with one that includes a checkbox on the left:

```html
<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
  <label id="reply-sig-row" class="text-sm text-muted" style="display:none;">
    <input type="checkbox" id="reply-include-sig" checked> Include signature
  </label>
  <button type="submit" class="btn btn-primary" style="margin-left:auto;">Send reply</button>
</div>
```

- [ ] **Step 2: Show the checkbox only when this thread's inbox has a signature**

In the existing `<script>` block, `loadThread()` already fetches `THREAD` via `getThread()`. After `THREAD = await getThread(threadId);`, add a call to fetch the shared inbox so we know whether it has a signature. Update `loadThread()`:

```javascript
async function loadThread() {
  if (!await requireAuthOrRedirect()) return;
  if (!threadId) { showToast('No thread id', 'error'); return; }
  try {
    THREAD = await getThread(threadId);
  } catch (err) {
    document.getElementById('loading').textContent = err.message;
    return;
  }
  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = '';
  renderHeader();
  renderMessages();
  document.getElementById('pulse-slot').dataset.entityId = THREAD.id;
  await maybeShowSignatureRow();   // ← new
}

async function maybeShowSignatureRow() {
  if (!THREAD.shared_inbox_id) return;
  try {
    const inboxes = await listSharedInboxes();
    const me = inboxes.find(i => i.id === THREAD.shared_inbox_id);
    if (me && me.signature_html && me.signature_html.trim()) {
      document.getElementById('reply-sig-row').style.display = '';
    }
  } catch { /* if list fails, just leave the row hidden */ }
}
```

(`getThread()` and `listSharedInboxes()` already exist in `app.js`; `THREAD.shared_inbox_id` is already returned by `GET /api/threads/:id`.)

- [ ] **Step 3: Pass the checkbox value on submit**

Update `submitReply()`:

```javascript
async function submitReply(e) {
  e.preventDefault();
  const body_text = document.getElementById('reply-body').value;
  if (!body_text.trim()) return;
  const include_signature = document.getElementById('reply-include-sig').checked;
  try {
    await sendReply(threadId, { body_text, include_signature });
    document.getElementById('reply-body').value = '';
    showToast('Reply sent');
    setTimeout(loadThread, 800);
  } catch (err) {
    showToast(err.message, 'error');
  }
}
```

- [ ] **Step 4: Compose modal — add checkbox to `inbox.html`**

In `inbox/public/inbox.html`, locate the compose modal (search for `submitCompose(event)` — around line 280). Find the submit row inside the form and add a checkbox alongside the buttons. The current block looks roughly like:

```html
<div style="display:flex;justify-content:flex-end;gap:8px;">
  <button type="button" class="btn btn-secondary" onclick="closeCompose()">Cancel</button>
  <button type="submit" class="btn btn-primary">Send</button>
</div>
```

Replace with:

```html
<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
  <label id="compose-sig-row" class="text-sm text-muted" style="display:none;">
    <input type="checkbox" id="compose-include-sig" checked> Include signature
  </label>
  <div style="display:flex;gap:8px;margin-left:auto;">
    <button type="button" class="btn btn-secondary" onclick="closeCompose()">Cancel</button>
    <button type="submit" class="btn btn-primary">Send</button>
  </div>
</div>
```

- [ ] **Step 5: Show the compose-checkbox when the selected alias's inbox has a signature**

The compose modal's "Send from" `<select>` has id `c-from` (see `inbox.html:283`). `STATE.composeAliases` is built in `openCompose()` from `/api/threads/aliases-for-me` (or similar) — check the existing `openCompose` body around line 812. Each alias row already includes its `shared_inbox_id`; if it doesn't, surface it via the route that supplies the list (a 1-column addition to the SELECT).

Add a helper near the other compose helpers:

```javascript
async function refreshComposeSignatureRow() {
  const aliasId = document.getElementById('c-from')?.value;
  const alias = STATE.composeAliases.find(a => a.id === aliasId);
  const sharedInboxId = alias?.shared_inbox_id;
  if (!sharedInboxId) {
    document.getElementById('compose-sig-row').style.display = 'none';
    return;
  }
  const all = STATE.sharedInboxes || (await listSharedInboxes());
  STATE.sharedInboxes = all;
  const inbox = all.find(s => s.id === sharedInboxId);
  document.getElementById('compose-sig-row').style.display =
    (inbox && inbox.signature_html && inbox.signature_html.trim()) ? '' : 'none';
}
```

Wire it: call `refreshComposeSignatureRow()` at the end of `openCompose()` (after the `<select>` populates), and add `onchange="refreshComposeSignatureRow()"` to the `<select id="c-from">` element in the HTML.

- [ ] **Step 6: Pass `include_signature` in submitCompose**

Find `submitCompose()` (around line 834). It currently builds a body object — add `include_signature` to it:

```javascript
const body = {
  // ... existing fields ...
  include_signature: document.getElementById('compose-include-sig').checked
};
```

- [ ] **Step 7: Manual verification**

1. Set a signature on a shared inbox (admin-shared.html).
2. Open a thread that belongs to that inbox. The "Include signature" checkbox appears below the reply textarea, checked.
3. Send a reply with it checked — verify signature appears in the sent Gmail message.
4. Send a reply with it unchecked — verify no signature.
5. Open the compose modal — pick an alias for that same inbox — checkbox appears. Send with/without.
6. Pick an alias from an inbox WITHOUT a signature — checkbox is hidden.

- [ ] **Step 8: Commit**

```bash
git add inbox/public/thread.html inbox/public/inbox.html
git commit -m "$(cat <<'EOF'
inbox: include-signature checkbox on reply + compose

Both forms gain a left-aligned 'Include signature' checkbox (default
checked) that's only shown when the resolved shared inbox actually has
a non-empty signature_html. Submit passes include_signature through to
the server which already honors it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Pulse — authz helper (`lib/authz.js`)

**Files:**
- Create: `pulse/lib/authz.js`

- [ ] **Step 1: Create the module**

```bash
touch "pulse/lib/authz.js"
```

- [ ] **Step 2: Write the module**

```javascript
// Authorization helpers for Pulse entity-comments.
//
// A user can access an entity_thread if ANY of the following is true:
//   1) They are a propspot owner (users.is_owner = TRUE).
//   2) Ambient access: the consumer app's pulse_authz_<entity_type> view
//      returns a row for (entity_id, user_id). For inbox_thread that means
//      the user has an Inbox app_grant covering the shared inbox.
//   3) Per-thread mention grant: pulse_entity_thread_grants has a row
//      for (entity_thread_id, user_id).
//
// We DO NOT trust client-supplied entity_type strings for view name
// construction — they're whitelisted here.

const { query } = require('../db');

const SUPPORTED_ENTITY_TYPES = new Set(['inbox_thread']);

function isEntityTypeSupported(entityType) {
  return SUPPORTED_ENTITY_TYPES.has(entityType);
}

// Returns the corresponding view name. NEVER concatenate user input into SQL —
// callers must check isEntityTypeSupported first; this function asserts.
function authzViewName(entityType) {
  if (!isEntityTypeSupported(entityType)) {
    throw new Error(`Unsupported entity_type: ${entityType}`);
  }
  return `pulse_authz_${entityType}`;
}

// Returns true if `userId` can read/post to the entity_thread that wraps
// (entityType, entityId). Lazy-creates the entity_thread row if it doesn't
// exist (returns the row's id for the caller's convenience). When the thread
// doesn't exist and the user doesn't have ambient access, refuses to create.
async function canAccessEntity({ userId, entityType, entityId }) {
  if (!isEntityTypeSupported(entityType)) return { allowed: false };

  // 1. Owner short-circuit.
  const { rows: ownerRows } = await query(
    `SELECT is_owner FROM users WHERE id = $1`,
    [userId]
  );
  const isOwner = !!ownerRows[0]?.is_owner;

  // 2. Ambient view check (only meaningful when entity actually exists).
  // We pass entityId as a parameter — view name is hard-coded after the
  // whitelist check above, so no injection surface.
  const viewName = authzViewName(entityType);
  const { rows: ambientRows } = await query(
    `SELECT 1 FROM ${viewName} WHERE entity_id = $1 AND user_id = $2 LIMIT 1`,
    [entityId, userId]
  );
  const hasAmbient = isOwner || ambientRows.length > 0;

  // 3. Find or lazy-create the entity_thread row.
  let { rows: etRows } = await query(
    `SELECT id FROM pulse_entity_threads WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId]
  );
  let entityThreadId = etRows[0]?.id;

  // 4. If no entity_thread row exists and the user has no ambient access,
  //    they can't bootstrap one via mention (no one has mentioned them yet).
  if (!entityThreadId && !hasAmbient) {
    return { allowed: false };
  }

  // 5. Lazy create (only when user has ambient — otherwise refused above).
  if (!entityThreadId) {
    const ins = await query(
      `INSERT INTO pulse_entity_threads (entity_type, entity_id)
       VALUES ($1, $2)
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [entityType, entityId]
    );
    entityThreadId = ins.rows[0].id;
  }

  // 6. If user has ambient, allow. Otherwise check per-thread grant.
  if (hasAmbient) {
    return { allowed: true, entityThreadId, via: isOwner ? 'owner' : 'ambient' };
  }
  const { rows: grantRows } = await query(
    `SELECT 1 FROM pulse_entity_thread_grants
      WHERE entity_thread_id = $1 AND user_id = $2 LIMIT 1`,
    [entityThreadId, userId]
  );
  if (grantRows.length) {
    return { allowed: true, entityThreadId, via: 'grant' };
  }
  return { allowed: false };
}

// Cheap variant: just "can user X see entity_thread Y" given an already-known
// entity_thread row. Used by SSE filtering, where we don't want to re-resolve
// (entity_type, entity_id) every event.
async function canAccessEntityThread({ userId, entityThreadId }) {
  const { rows: etRows } = await query(
    `SELECT entity_type, entity_id FROM pulse_entity_threads WHERE id = $1`,
    [entityThreadId]
  );
  if (!etRows[0]) return false;
  const result = await canAccessEntity({
    userId,
    entityType: etRows[0].entity_type,
    entityId:   etRows[0].entity_id
  });
  return result.allowed;
}

module.exports = {
  SUPPORTED_ENTITY_TYPES,
  isEntityTypeSupported,
  canAccessEntity,
  canAccessEntityThread
};
```

- [ ] **Step 3: Quick syntax check**

```bash
cd pulse && node -e "require('./lib/authz')"
```

Expected: no output, no error.

- [ ] **Step 4: Commit**

```bash
git add pulse/lib/authz.js
git commit -m "$(cat <<'EOF'
pulse: authz helper for entity-thread comments

canAccessEntity / canAccessEntityThread enforce the spec's three-tier
authz model: owner short-circuit, ambient access via pulse_authz_<type>
view, then per-(user, thread) grant in pulse_entity_thread_grants.

entity_type strings are whitelisted before any SQL view-name use to
prevent injection. Only 'inbox_thread' is registered in v1.

Lazy-creates the pulse_entity_threads row on first authorized access,
so consumer apps don't have to pre-seed it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Pulse — mention parser (`lib/mentions.js`)

**Files:**
- Create: `pulse/lib/mentions.js`

- [ ] **Step 1: Create the module**

```javascript
// Mention parsing and grant-writing for Pulse messages.
//
// Bodies are stored with explicit `<@uuid>` tokens — the client inserts the
// token when the user picks someone from the @ picker, and renders them as
// chips on display. This regex MUST match the client's token format exactly.

const { query } = require('../db');

const MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

// Extract distinct mentioned user uuids from a message body.
function parseMentions(body) {
  if (!body) return [];
  const ids = new Set();
  let m;
  while ((m = MENTION_RE.exec(body)) !== null) {
    ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

// Write chat_mentions rows for a message. Idempotent on PK conflict.
// Silently drops uuids that don't correspond to a real user (e.g. user
// deleted between client typing and submit).
async function writeMentionRows(messageId, userIds) {
  if (!userIds.length) return [];
  // Filter to only existing users.
  const { rows: existing } = await query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  const validIds = existing.map(r => r.id);
  for (const uid of validIds) {
    await query(
      `INSERT INTO chat_mentions (message_id, mentioned_user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, uid]
    );
  }
  return validIds;
}

// Write per-(user, entity_thread) grants for each mention. Idempotent.
async function writeEntityThreadGrants(entityThreadId, mentionedUserIds, grantedBy) {
  if (!mentionedUserIds.length) return;
  for (const uid of mentionedUserIds) {
    await query(
      `INSERT INTO pulse_entity_thread_grants
         (entity_thread_id, user_id, granted_via, granted_by)
       VALUES ($1, $2, 'mention', $3)
       ON CONFLICT DO NOTHING`,
      [entityThreadId, uid, grantedBy]
    );
  }
}

module.exports = { MENTION_RE, parseMentions, writeMentionRows, writeEntityThreadGrants };
```

- [ ] **Step 2: Syntax check**

```bash
cd pulse && node -e "
const m = require('./lib/mentions');
const ids = m.parseMentions('Hi <@11111111-2222-3333-4444-555555555555> and <@AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE> and a dupe <@11111111-2222-3333-4444-555555555555>');
console.log(ids);  // expect 2 distinct lowercase ids
"
```

Expected: array with 2 unique uuids, lowercased.

- [ ] **Step 3: Commit**

```bash
git add pulse/lib/mentions.js
git commit -m "$(cat <<'EOF'
pulse: mention parsing + grant-writing helpers

parseMentions extracts distinct <@uuid> tokens from a message body.
writeMentionRows persists them into chat_mentions (idempotent).
writeEntityThreadGrants creates per-(user, thread) read grants on
mention (idempotent).

Filters uuids against the users table so stale mentions silently no-op.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Pulse — entity-threads REST routes

**Files:**
- Create: `pulse/routes/entity-threads.js`

- [ ] **Step 1: Create the route module**

```javascript
const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');
const { canAccessEntity, isEntityTypeSupported } = require('../lib/authz');
const { parseMentions, writeMentionRows, writeEntityThreadGrants } = require('../lib/mentions');
const hub = require('../lib/hub');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

function streamKey(entityThreadId) {
  return `et:${entityThreadId}`;
}

async function hydrateMessage(row) {
  const { rows } = await query(
    `SELECT full_name, email FROM users WHERE id = $1`,
    [row.sender_id]
  );
  const s = rows[0] || {};
  return { ...row, sender_name: s.full_name || s.email || 'Unknown', sender_email: s.email || null };
}

// GET /api/pulse/entity-threads?type=inbox_thread&id=<uuid>
// Returns { thread: {...}, messages: [...] }. Lazy-creates the thread row on
// first read by an authorized user.
router.get('/', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  if (!entity_type || !entity_id) {
    return res.status(400).json({ error: 'type and id query params required' });
  }
  if (!isEntityTypeSupported(entity_type)) {
    return res.status(400).json({ error: 'unsupported entity_type' });
  }
  const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
  if (!access.allowed) return res.status(403).json({ error: 'No access' });

  const { rows: tRows } = await query(
    `SELECT id, entity_type, entity_id, created_at, updated_at
       FROM pulse_entity_threads WHERE id = $1`,
    [access.entityThreadId]
  );
  const { rows: mRows } = await query(`
    SELECT m.*, u.full_name AS sender_name, u.email AS sender_email
      FROM chat_messages m
      LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.entity_thread_id = $1
       AND m.deleted_at IS NULL
  ORDER BY m.created_at ASC
  `, [access.entityThreadId]);

  res.json({ thread: tRows[0], messages: mRows });
});

// POST /api/pulse/entity-threads/messages?type=inbox_thread&id=<uuid>
// Body: { body, client_message_id? }
router.post('/messages', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  const { body, client_message_id } = req.body || {};
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'type and id required' });
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  if (!body || typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (body.length > 8000) return res.status(413).json({ error: 'message too long (8000 char max)' });

  const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
  if (!access.allowed) return res.status(403).json({ error: 'No access' });

  try {
    const ins = await query(`
      INSERT INTO chat_messages (entity_thread_id, sender_id, client_message_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [access.entityThreadId, req.userId, client_message_id || null, body.trim()]);
    const message = ins.rows[0];

    const mentionedIds = parseMentions(body);
    const validIds = await writeMentionRows(message.id, mentionedIds);
    await writeEntityThreadGrants(access.entityThreadId, validIds, req.userId);

    const enriched = await hydrateMessage(message);
    hub.publish(streamKey(access.entityThreadId), {
      type: 'entity_thread.message_created',
      entity_type, entity_id,
      entity_thread_id: access.entityThreadId,
      message: enriched,
      mentions: validIds
    });

    res.json(enriched);
  } catch (err) {
    if (err.code === '23505' && client_message_id) {
      const { rows } = await query(
        `SELECT * FROM chat_messages WHERE sender_id = $1 AND client_message_id = $2`,
        [req.userId, client_message_id]
      );
      if (rows.length) return res.json(await hydrateMessage(rows[0]));
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// PATCH /api/pulse/entity-threads/messages/:id — edit own message
router.patch('/messages/:id', async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const { rows } = await query(`
    UPDATE chat_messages
       SET body = $1, edited_at = NOW()
     WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
   RETURNING *
  `, [body.trim(), req.params.id, req.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found or not yours' });

  if (rows[0].entity_thread_id) {
    const enriched = await hydrateMessage(rows[0]);
    hub.publish(streamKey(rows[0].entity_thread_id), {
      type: 'entity_thread.message_updated',
      entity_thread_id: rows[0].entity_thread_id,
      message: enriched
    });
  }
  res.json(rows[0]);
});

// DELETE /api/pulse/entity-threads/messages/:id — soft-delete own message
router.delete('/messages/:id', async (req, res) => {
  const { rows } = await query(`
    UPDATE chat_messages SET deleted_at = NOW()
     WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
   RETURNING id, entity_thread_id
  `, [req.params.id, req.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found or not yours' });

  if (rows[0].entity_thread_id) {
    hub.publish(streamKey(rows[0].entity_thread_id), {
      type: 'entity_thread.message_deleted',
      entity_thread_id: rows[0].entity_thread_id,
      message_id: rows[0].id
    });
  }
  res.json({ success: true });
});

// GET /api/pulse/entity-threads/mentionable-users?type=inbox_thread&id=<uuid>
// Returns full team list; users who already have ambient access come first.
router.get('/mentionable-users', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
  if (!access.allowed) return res.status(403).json({ error: 'No access' });

  // Ambient users for this entity from the authz view; UNION ALL with the rest.
  const viewName = `pulse_authz_${entity_type}`;
  const { rows } = await query(`
    SELECT u.id, u.full_name, u.email, TRUE AS has_ambient
      FROM users u
      JOIN ${viewName} v ON v.user_id = u.id AND v.entity_id = $1
   UNION
    SELECT u.id, u.full_name, u.email, FALSE AS has_ambient
      FROM users u
     WHERE NOT EXISTS (
       SELECT 1 FROM ${viewName} v
        WHERE v.user_id = u.id AND v.entity_id = $1
     )
   ORDER BY has_ambient DESC, full_name ASC NULLS LAST, email ASC
  `, [entity_id]);
  res.json(rows);
});

// GET /api/pulse/entity-threads/unread-counts?type=inbox_thread
// Returns [{ entity_id, unread_mention_count }] for the caller.
// "Unread" = chat_mentions for this user on entity_thread messages
// created after their last_read (we don't have last_read per entity_thread
// yet — v1 treats anything posted in last 14 days as potentially unread;
// see open-questions in spec — but we MUST track a real last_read in v1.5).
// For v1, use the dead-simple definition: "mentioned and never opened this
// thread in pulse" — we store opens in a tiny pulse_entity_thread_reads table.
router.get('/unread-counts', async (req, res) => {
  const entity_type = req.query.type;
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  // Counts: per entity_thread the caller has a chat_mention on, how many
  // mentions are unread for them.
  const { rows } = await query(`
    SELECT et.entity_id, COUNT(*)::int AS unread_mention_count
      FROM chat_mentions cm
      JOIN chat_messages m       ON m.id = cm.message_id
      JOIN pulse_entity_threads et ON et.id = m.entity_thread_id
 LEFT JOIN pulse_entity_thread_reads r
        ON r.entity_thread_id = et.id AND r.user_id = $1
     WHERE cm.mentioned_user_id = $1
       AND et.entity_type = $2
       AND m.deleted_at IS NULL
       AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
  GROUP BY et.entity_id
  `, [req.userId, entity_type]);
  res.json(rows);
});

// POST /api/pulse/entity-threads/mark-read?type=inbox_thread&id=<uuid>
// Records that the caller has now seen everything on this thread up to NOW().
router.post('/mark-read', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
  if (!access.allowed) return res.status(403).json({ error: 'No access' });
  await query(`
    INSERT INTO pulse_entity_thread_reads (entity_thread_id, user_id, last_read_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (entity_thread_id, user_id) DO UPDATE SET last_read_at = NOW()
  `, [access.entityThreadId, req.userId]);
  res.json({ success: true });
});

module.exports = router;
```

- [ ] **Step 2: Add the `pulse_entity_thread_reads` table to schema.sql**

The unread-counts logic references `pulse_entity_thread_reads`, which Task 1's migration didn't create. Add it to `propspot-os/db/schema.sql` in the same 2026-05-22 migration block (or appended at the end):

```sql
-- G) Per-(user, entity_thread) read marker. Powers unread-mention counts.
CREATE TABLE IF NOT EXISTS pulse_entity_thread_reads (
  entity_thread_id UUID NOT NULL REFERENCES pulse_entity_threads(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id)                ON DELETE CASCADE,
  last_read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS pulse_entity_thread_reads_user_idx
  ON pulse_entity_thread_reads(user_id);
```

Apply: `psql "$DATABASE_URL" -f propspot-os/db/schema.sql`. Verify the table exists with `\dt pulse_entity_thread_reads`.

- [ ] **Step 3: Syntax check**

```bash
cd pulse && node -e "require('./routes/entity-threads')"
```

Expected: no errors. (It loads middleware and the helpers we just wrote.)

- [ ] **Step 4: Commit**

```bash
git add pulse/routes/entity-threads.js propspot-os/db/schema.sql
git commit -m "$(cat <<'EOF'
pulse: entity-threads REST routes

GET    /api/pulse/entity-threads?type=...&id=...
POST   /api/pulse/entity-threads/messages?type=...&id=...
PATCH  /api/pulse/entity-threads/messages/:id
DELETE /api/pulse/entity-threads/messages/:id
GET    /api/pulse/entity-threads/mentionable-users?type=...&id=...
GET    /api/pulse/entity-threads/unread-counts?type=...
POST   /api/pulse/entity-threads/mark-read?type=...&id=...

Reuses chat_messages with the new entity_thread_id column. Mentions
both write chat_mentions rows and pulse_entity_thread_grants rows for
the access-grant-on-mention semantics. Each mutation broadcasts on the
'et:<thread>' hub key for SSE consumers.

Also adds pulse_entity_thread_reads table to schema.sql for the
unread-mention count logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Pulse — mount the route + expand CORS

**Files:**
- Modify: `pulse/server.js`

- [ ] **Step 1: Mount the entity-threads route**

In `pulse/server.js`, find the existing route mounts (around line 19):

```javascript
app.use('/api/pulse/messages', require('./routes/messages'));
app.use('/api/pulse/channels', require('./routes/channels'));
app.use('/api/pulse/stream',   require('./routes/stream'));
```

Add a fourth line:

```javascript
app.use('/api/pulse/entity-threads', require('./routes/entity-threads'));
```

- [ ] **Step 2: Expand CORS to allow Inbox + other satellites**

The current line is:

```javascript
app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));
```

Replace with a function that allows known satellite URLs from env:

```javascript
const SATELLITE_ENVS = [
  'OS_URL', 'APP_URL', 'INBOX_URL', 'HOLDINGS_URL',
  'MAINTENANCE_URL', 'FIELDCAM_URL', 'UNDERWRITING_URL'
];
const ALLOWED_ORIGINS = SATELLITE_ENVS
  .map(k => process.env[k])
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Same-origin (no Origin header) — allow.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // In dev with no envs set, accept anything to keep localhost testing easy.
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true
}));
```

- [ ] **Step 3: Verify via curl**

Start `pulse` locally (`cd pulse && npm start`). With a valid JWT for a user with Pulse access:

```bash
TOK="..."
# Pick any inbox_thread uuid you know exists
INBOX_THREAD_ID="..."

curl -s -H "Authorization: Bearer $TOK" \
  "http://localhost:PORT/api/pulse/entity-threads?type=inbox_thread&id=$INBOX_THREAD_ID" | jq
```

Expected (for an owner / inbox-grant-holder): `{ thread: { id, entity_type, entity_id, ... }, messages: [] }`. For a user without access: `{ "error": "No access" }` with 403.

```bash
# Post a comment
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"body":"first test comment"}' \
  "http://localhost:PORT/api/pulse/entity-threads/messages?type=inbox_thread&id=$INBOX_THREAD_ID" | jq
```

Expected: returns the inserted message with `sender_name` populated.

```bash
# CORS preflight from a fake Inbox origin
curl -s -i -X OPTIONS -H "Origin: https://inbox.propspot.io" \
  -H "Access-Control-Request-Method: POST" \
  http://localhost:PORT/api/pulse/entity-threads/messages | grep -i 'access-control'
```

Expected: `Access-Control-Allow-Origin: https://inbox.propspot.io` (or similar).

- [ ] **Step 4: Commit**

```bash
git add pulse/server.js
git commit -m "$(cat <<'EOF'
pulse: mount entity-threads route + expand CORS to satellites

CORS now allows requests from any propspot satellite whose URL is
configured via env (OS_URL, INBOX_URL, HOLDINGS_URL, etc.). Same-origin
requests still pass through. Dev falls back to permissive when no
satellite envs are set so localhost works without ceremony.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Pulse — SSE entity-thread subscriptions

**Files:**
- Modify: `pulse/routes/stream.js`

- [ ] **Step 1: Add entity-thread support to the stream endpoint**

The current handler only supports `?channel_id=`. We add an alternate mode `?entity_type=...&entity_id=...`. Replace the body of the route handler with branching:

```javascript
router.get('/', authQuery, async (req, res) => {
  const channelId = req.query.channel_id;
  const entityType = req.query.entity_type;
  const entityId   = req.query.entity_id;

  let subscribeKey;
  let helloPayload;

  if (channelId) {
    const { rows } = await query(`
      SELECT 1
        FROM users u
        LEFT JOIN chat_channel_members m
          ON m.user_id = u.id AND m.channel_id = $1
       WHERE u.id = $2
         AND (u.is_owner = TRUE OR m.user_id IS NOT NULL)
       LIMIT 1
    `, [channelId, req.userId]);
    if (!rows.length) return res.status(403).end();
    subscribeKey = channelId;
    helloPayload = { type: 'hello', channel_id: channelId, user_id: req.userId };
  } else if (entityType && entityId) {
    const { isEntityTypeSupported, canAccessEntity } = require('../lib/authz');
    if (!isEntityTypeSupported(entityType)) return res.status(400).end();
    const access = await canAccessEntity({
      userId: req.userId, entityType, entityId
    });
    if (!access.allowed) return res.status(403).end();
    subscribeKey = `et:${access.entityThreadId}`;
    helloPayload = {
      type: 'hello',
      entity_type: entityType,
      entity_id: entityId,
      entity_thread_id: access.entityThreadId,
      user_id: req.userId
    };
  } else {
    return res.status(400).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
  res.write('retry: 5000\n\n');
  res.write(`data: ${JSON.stringify(helloPayload)}\n\n`);

  const unsubscribe = hub.subscribe(subscribeKey, res);

  const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 25000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});
```

- [ ] **Step 2: Verify the entity-thread stream works**

In two terminals (with a valid JWT and a known inbox thread):

```bash
# Terminal A — subscribe
curl -N "http://localhost:PORT/api/pulse/stream?token=$TOK&entity_type=inbox_thread&entity_id=$INBOX_THREAD_ID"
```

Expected first line: `data: {"type":"hello",...}`. Then the connection stays open.

```bash
# Terminal B — post a message
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"body":"hello from sse test"}' \
  "http://localhost:PORT/api/pulse/entity-threads/messages?type=inbox_thread&id=$INBOX_THREAD_ID"
```

Expected: terminal A immediately receives `data: {"type":"entity_thread.message_created", ...}`.

- [ ] **Step 3: Commit**

```bash
git add pulse/routes/stream.js
git commit -m "$(cat <<'EOF'
pulse: SSE stream accepts entity_type + entity_id subscriptions

When the request carries entity_type+entity_id (instead of channel_id),
the stream subscribes to the 'et:<thread_id>' hub key and authorizes
via canAccessEntity. All existing channel-stream behavior is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Pulse — embed widget JS + CSS

**Files:**
- Create: `pulse/public/widget.js`
- Create: `pulse/public/widget.css`

- [ ] **Step 1: Write `widget.css`**

```css
.pulse-embed {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: var(--radius, 8px);
  background: var(--surface, #fff);
  margin-top: 12px;
  overflow: hidden;
}
.pulse-embed-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  font-weight: 600;
  font-size: .92rem;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pulse-embed-status {
  margin-left: auto;
  width: 8px; height: 8px;
  background: #ccc;
  border-radius: 50%;
}
.pulse-embed-status.connected { background: #61B746; }
.pulse-embed-messages {
  padding: 8px 14px;
  max-height: 360px;
  overflow-y: auto;
}
.pulse-embed-empty { color: #888; font-size: .85rem; padding: 8px 0; }
.pulse-embed-msg { padding: 8px 0; border-bottom: 1px dashed var(--border, #eee); }
.pulse-embed-msg:last-child { border-bottom: none; }
.pulse-embed-msg-head { font-size: .82rem; color: #666; display: flex; gap: 6px; }
.pulse-embed-msg-author { font-weight: 600; color: #222; }
.pulse-embed-msg-body { font-size: .9rem; line-height: 1.45; margin-top: 2px; white-space: pre-wrap; word-wrap: break-word; }
.pulse-embed-mention { background: var(--brand-light, #e6f4dc); color: var(--brand-dark, #3a7a1f); padding: 1px 5px; border-radius: 4px; font-weight: 600; }
.pulse-embed-composer { border-top: 1px solid var(--border, #e5e5e5); padding: 10px 14px; position: relative; }
.pulse-embed-textarea {
  width: 100%; box-sizing: border-box;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 6px; padding: 8px 10px; font: inherit;
  resize: vertical; min-height: 56px;
}
.pulse-embed-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
.pulse-embed-hint { font-size: .75rem; color: #888; }
.pulse-embed-send {
  background: var(--brand, #61B746); color: #fff;
  border: 0; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  font-size: .85rem; font-weight: 600;
}
.pulse-embed-send:disabled { opacity: .5; cursor: not-allowed; }
.pulse-embed-mention-picker {
  position: absolute;
  bottom: 100%; left: 14px; right: 14px;
  max-height: 200px; overflow-y: auto;
  background: #fff; border: 1px solid var(--border, #ccc); border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  z-index: 10; display: none;
}
.pulse-embed-mention-picker.open { display: block; }
.pulse-embed-mention-item { padding: 8px 12px; cursor: pointer; font-size: .85rem; display: flex; gap: 8px; align-items: center; }
.pulse-embed-mention-item:hover, .pulse-embed-mention-item.active { background: var(--brand-light, #e6f4dc); }
.pulse-embed-mention-badge { font-size: .7rem; color: #888; }
.pulse-embed-error { padding: 10px 14px; color: #b00; font-size: .85rem; }
```

- [ ] **Step 2: Write `widget.js`**

```javascript
// Pulse entity-comments embed widget.
//
// Usage on a host page:
//   <link rel="stylesheet" href="<PULSE_URL>/widget.css">
//   <div id="pulse-slot" data-entity-type="inbox_thread" data-entity-id="<uuid>"></div>
//   <script>window.PULSE_AUTH = { token: getToken() };</script>
//   <script src="<PULSE_URL>/widget.js" defer></script>
//
// The widget reads its Pulse base URL from the <script src> attribute it was
// loaded by — no extra config required.

(function () {
  if (window.__pulseWidgetLoaded) return;
  window.__pulseWidgetLoaded = true;

  const scriptEl = document.currentScript
    || [...document.scripts].find(s => s.src && s.src.includes('/widget.js'));
  const PULSE_URL = scriptEl ? new URL(scriptEl.src).origin : '';

  if (!PULSE_URL) { console.warn('[Pulse widget] could not determine PULSE_URL'); return; }
  // Ensure widget.css is loaded — if the host didn't include it, inject it.
  if (![...document.styleSheets].some(s => (s.href || '').includes('/widget.css'))) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = PULSE_URL + '/widget.css';
    document.head.appendChild(l);
  }

  function getToken() {
    return (window.PULSE_AUTH && window.PULSE_AUTH.token) || null;
  }

  async function api(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error('No auth token available (window.PULSE_AUTH.token)');
    const r = await fetch(`${PULSE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(opts.headers || {})
      }
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // Render <@uuid> tokens as colored chips with a display name.
  function renderBody(body, usersById) {
    if (!body) return '';
    return escapeHtml(body).replace(/&lt;@([0-9a-f-]{36})&gt;/gi, (_, uid) => {
      const u = usersById.get(uid.toLowerCase());
      const label = u ? (u.full_name || u.email) : uid.slice(0, 8);
      return `<span class="pulse-embed-mention">@${escapeHtml(label)}</span>`;
    });
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  }

  async function mountSlot(slot) {
    const entityType = slot.dataset.entityType;
    let entityId = slot.dataset.entityId;

    // Wait up to 5s for entityId to be populated.
    if (!entityId) {
      const start = Date.now();
      await new Promise(resolve => {
        const iv = setInterval(() => {
          entityId = slot.dataset.entityId;
          if (entityId || Date.now() - start > 5000) {
            clearInterval(iv); resolve();
          }
        }, 250);
      });
    }
    if (!entityType || !entityId) {
      slot.innerHTML = '<div class="pulse-embed pulse-embed-error">Pulse widget: missing entity_type/entity_id</div>';
      return;
    }

    slot.innerHTML = `
      <div class="pulse-embed" role="region" aria-label="Internal comments">
        <div class="pulse-embed-header">
          💬 <span>Internal comments</span>
          <span class="pulse-embed-status" title="Disconnected"></span>
        </div>
        <div class="pulse-embed-messages" data-role="messages">
          <div class="pulse-embed-empty">Loading…</div>
        </div>
        <div class="pulse-embed-composer">
          <textarea class="pulse-embed-textarea" data-role="textarea" placeholder="Type a comment… (@ to mention)"></textarea>
          <div class="pulse-embed-mention-picker" data-role="picker"></div>
          <div class="pulse-embed-actions">
            <span class="pulse-embed-hint">Only people on this thread see these comments.</span>
            <button class="pulse-embed-send" data-role="send">Post</button>
          </div>
        </div>
      </div>
    `;

    const msgEl    = slot.querySelector('[data-role="messages"]');
    const taEl     = slot.querySelector('[data-role="textarea"]');
    const sendEl   = slot.querySelector('[data-role="send"]');
    const pickerEl = slot.querySelector('[data-role="picker"]');
    const statusEl = slot.querySelector('.pulse-embed-status');

    let MENTIONABLE = [];   // { id, full_name, email, has_ambient }
    let USERS_BY_ID = new Map();

    function rebuildUserMap() {
      USERS_BY_ID = new Map(MENTIONABLE.map(u => [u.id.toLowerCase(), u]));
    }

    async function loadInitial() {
      try {
        const [data, users] = await Promise.all([
          api(`/api/pulse/entity-threads?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`),
          api(`/api/pulse/entity-threads/mentionable-users?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`)
        ]);
        MENTIONABLE = users || [];
        rebuildUserMap();
        renderMessages(data.messages || []);
        api(`/api/pulse/entity-threads/mark-read?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`, { method: 'POST' }).catch(() => {});
        openStream();
      } catch (err) {
        msgEl.innerHTML = `<div class="pulse-embed-error">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderMessages(messages) {
      if (!messages.length) {
        msgEl.innerHTML = '<div class="pulse-embed-empty">No comments yet — leave the first one.</div>';
        return;
      }
      msgEl.innerHTML = messages.map(m => `
        <div class="pulse-embed-msg" data-id="${escapeHtml(m.id)}">
          <div class="pulse-embed-msg-head">
            <span class="pulse-embed-msg-author">${escapeHtml(m.sender_name || 'Unknown')}</span>
            <span>${fmtTime(m.created_at)}</span>
            ${m.edited_at ? '<span title="Edited">(edited)</span>' : ''}
          </div>
          <div class="pulse-embed-msg-body">${renderBody(m.body, USERS_BY_ID)}</div>
        </div>
      `).join('');
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function appendMessage(m) {
      const empty = msgEl.querySelector('.pulse-embed-empty');
      if (empty) empty.remove();
      if (msgEl.querySelector(`.pulse-embed-msg[data-id="${m.id}"]`)) return;  // dedup
      const div = document.createElement('div');
      div.className = 'pulse-embed-msg';
      div.dataset.id = m.id;
      div.innerHTML = `
        <div class="pulse-embed-msg-head">
          <span class="pulse-embed-msg-author">${escapeHtml(m.sender_name || 'Unknown')}</span>
          <span>${fmtTime(m.created_at)}</span>
        </div>
        <div class="pulse-embed-msg-body">${renderBody(m.body, USERS_BY_ID)}</div>
      `;
      msgEl.appendChild(div);
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function uuid() {
      return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
      );
    }

    async function postMessage() {
      const body = taEl.value.trim();
      if (!body) return;
      sendEl.disabled = true;
      try {
        const m = await api(
          `/api/pulse/entity-threads/messages?type=${encodeURIComponent(entityType)}&id=${encodeURIComponent(entityId)}`,
          { method: 'POST', body: JSON.stringify({ body, client_message_id: uuid() }) }
        );
        appendMessage(m);
        taEl.value = '';
      } catch (err) {
        msgEl.insertAdjacentHTML('beforeend', `<div class="pulse-embed-error">${escapeHtml(err.message)}</div>`);
      } finally {
        sendEl.disabled = false;
      }
    }

    sendEl.addEventListener('click', postMessage);
    taEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postMessage(); }
    });

    // ── Mention picker ─────────────────────────────────────────────
    let pickerOpen = false;
    let pickerCursor = 0;   // index into filtered results
    let pickerToken = '';   // characters typed after the @
    let pickerAnchor = -1;  // index in taEl.value where the '@' was typed

    function closePicker() { pickerOpen = false; pickerEl.classList.remove('open'); pickerEl.innerHTML = ''; }

    function openPicker(anchor) {
      pickerOpen = true; pickerAnchor = anchor; pickerToken = ''; pickerCursor = 0;
      renderPicker();
      pickerEl.classList.add('open');
    }

    function filteredUsers() {
      const q = pickerToken.toLowerCase();
      const filtered = MENTIONABLE.filter(u =>
        (u.full_name || '').toLowerCase().includes(q)
        || (u.email || '').toLowerCase().includes(q)
      );
      return filtered.slice(0, 8);
    }

    function renderPicker() {
      const list = filteredUsers();
      if (!list.length) { closePicker(); return; }
      if (pickerCursor >= list.length) pickerCursor = list.length - 1;
      pickerEl.innerHTML = list.map((u, i) => `
        <div class="pulse-embed-mention-item ${i === pickerCursor ? 'active' : ''}" data-uid="${escapeHtml(u.id)}">
          <span>${escapeHtml(u.full_name || u.email)}</span>
          <span class="pulse-embed-mention-badge">${u.has_ambient ? '' : 'guest'}</span>
        </div>
      `).join('');
      pickerEl.querySelectorAll('.pulse-embed-mention-item').forEach((el, i) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pickerCursor = i; pickUser(); });
      });
    }

    function pickUser() {
      const list = filteredUsers();
      const u = list[pickerCursor];
      if (!u) return;
      const before = taEl.value.slice(0, pickerAnchor);
      const after  = taEl.value.slice(pickerAnchor + 1 + pickerToken.length);
      taEl.value = `${before}<@${u.id}> ${after}`;
      taEl.focus();
      closePicker();
    }

    taEl.addEventListener('input', () => {
      const v = taEl.value;
      const caret = taEl.selectionStart;
      // Find the @ that starts the current token (if any).
      const before = v.slice(0, caret);
      const match = before.match(/(^|\s)@([\w.\- ]*)$/);
      if (match) {
        const tokenStart = caret - match[2].length - 1;
        if (!pickerOpen || pickerAnchor !== tokenStart) openPicker(tokenStart);
        pickerToken = match[2];
        renderPicker();
      } else if (pickerOpen) {
        closePicker();
      }
    });

    taEl.addEventListener('keydown', (e) => {
      if (!pickerOpen) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); pickerCursor = (pickerCursor + 1) % filteredUsers().length; renderPicker(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); const n = filteredUsers().length; pickerCursor = (pickerCursor - 1 + n) % n; renderPicker(); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        const list = filteredUsers();
        if (list.length) { e.preventDefault(); pickUser(); }
      } else if (e.key === 'Escape') { closePicker(); }
    });

    // ── SSE ────────────────────────────────────────────────────────
    let es = null;
    function openStream() {
      if (es) try { es.close(); } catch {}
      const token = getToken();
      const url = `${PULSE_URL}/api/pulse/stream?token=${encodeURIComponent(token)}&entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`;
      es = new EventSource(url);
      es.addEventListener('open', () => statusEl.classList.add('connected'));
      es.addEventListener('error', () => statusEl.classList.remove('connected'));
      es.addEventListener('message', (e) => {
        let payload;
        try { payload = JSON.parse(e.data); } catch { return; }
        if (payload.type === 'entity_thread.message_created' && payload.message) {
          appendMessage(payload.message);
        } else if (payload.type === 'entity_thread.message_deleted') {
          const el = msgEl.querySelector(`[data-id="${payload.message_id}"]`);
          if (el) el.remove();
        } else if (payload.type === 'entity_thread.message_updated' && payload.message) {
          const el = msgEl.querySelector(`[data-id="${payload.message.id}"] .pulse-embed-msg-body`);
          if (el) el.innerHTML = renderBody(payload.message.body, USERS_BY_ID);
        }
      });
    }

    loadInitial();
  }

  function init() {
    const slots = document.querySelectorAll('[id="pulse-slot"], [data-pulse-slot]');
    slots.forEach(mountSlot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

- [ ] **Step 3: Verify the widget loads in isolation**

Run Pulse locally. Create a quick scratch HTML file at `/tmp/pulse-widget-test.html` (you'll throw this away):

```html
<!DOCTYPE html><html><body>
<script>window.PULSE_AUTH = { token: "PASTE_JWT_HERE" };</script>
<div id="pulse-slot" data-entity-type="inbox_thread" data-entity-id="PASTE_INBOX_THREAD_UUID"></div>
<script src="http://localhost:PORT/widget.js" defer></script>
</body></html>
```

Open it in a browser (use `python3 -m http.server` from `/tmp/` for the right CORS scenario). Verify:
- The widget renders.
- Existing comments (if any) appear.
- Typing `@` opens the picker with the team list.
- Picking someone inserts `<@uuid>` (visible if you peek at the textarea value via devtools).
- Posting a comment makes it appear, and a second open browser tab on the same entity sees it live via SSE.

- [ ] **Step 4: Commit**

```bash
git add pulse/public/widget.js pulse/public/widget.css
git commit -m "$(cat <<'EOF'
pulse: vanilla-JS embed widget (widget.js + widget.css)

Mounts into any <div id="pulse-slot" data-entity-type=... data-entity-id=...>
on a host page. Reads auth from window.PULSE_AUTH.token, connects to
Pulse's entity-thread REST + SSE endpoints, renders existing comments,
exposes a textarea composer with @-mention picker, and updates live as
other users post / edit / delete.

CSS uses scoped .pulse-embed-* classes and CSS vars (--brand, --border)
with brand-color fallbacks so it picks up host page theming when present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Inbox — embed widget on `thread.html`

**Files:**
- Modify: `inbox/public/thread.html`

- [ ] **Step 1: Inject the auth handoff + widget script**

Open `inbox/public/thread.html`. At the bottom of the file, the existing scripts are:

```html
<script src="config.js"></script>
<script src="app.js"></script>
<script>
const threadId = new URLSearchParams(location.search).get('id');
...
```

Right after the `<script src="app.js"></script>` line, BEFORE the inline `<script>` that calls `loadThread()`, add:

```html
<script>
  // Hand the host app's JWT to the Pulse widget under a known global.
  window.PULSE_AUTH = { token: getToken() };
</script>
```

There is NO `window.CONFIG` global in this codebase — `config.js` only sets top-level constants (`API_BASE`, `APP_NAME`) and `app.js` fetches `/api/config` into a module-private `_navCfgCache`. So the widget bootstrap fetches `/api/config` itself.

At the bottom of the file, AFTER the inline `<script>...loadThread();</script>` block, append:

```html
<script>
  (async function loadPulseWidget() {
    try {
      const r = await fetch('/api/config');
      const cfg = await r.json();
      if (!cfg.pulseUrl) return;  // Pulse not configured in this env
      const s = document.createElement('script');
      s.src = cfg.pulseUrl + '/widget.js';
      s.defer = true;
      document.body.appendChild(s);
    } catch (err) {
      console.warn('[Inbox] could not load Pulse widget:', err);
    }
  })();
</script>
```

- [ ] **Step 2: (removed — config global check folded into Step 1)**

Skip; Step 1 already handles the config lookup explicitly. Move to Step 3.

- [ ] **Step 3: Browser verification**

With Pulse running locally and the schema applied:

1. Make sure `pulseUrl` is set on Inbox's `/api/config` response. (Should already be — `pulseUrl: process.env.PULSE_URL || ''`. If `PULSE_URL` isn't set in your dev env, export it: `export PULSE_URL=http://localhost:PULSE_PORT` and restart the Inbox server.)
2. Open any thread in Inbox. The Pulse widget should appear below the messages and above the reply form (because `<div id="pulse-slot">` already sits there).
3. Post a test comment. It should appear immediately.
4. Open the same thread in a second browser tab — both should see new posts via SSE.

- [ ] **Step 4: Commit**

```bash
git add inbox/public/thread.html
git commit -m "$(cat <<'EOF'
inbox: render Pulse widget under each email thread

thread.html now hands the inbox JWT to window.PULSE_AUTH and loads
Pulse's widget.js from CONFIG.pulseUrl. The widget renders into the
pre-existing <div id="pulse-slot"> div, picks up data-entity-id from
the loaded thread, and connects to Pulse's REST + SSE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Inbox — unread-mention chips on thread list

**Files:**
- Modify: `inbox/public/inbox.html`

- [ ] **Step 1: Fetch unread counts after the thread list loads**

In `inbox/public/inbox.html`, the thread list loading happens in a function — search for `renderThreads(` or `STATE.threads`. After the thread list renders, fetch unread counts from Pulse and update the DOM.

Add a helper near the other helpers (e.g. right above the compose helpers). There is no `window.CONFIG` global; we fetch `/api/config` lazily and cache the `pulseUrl`:

```javascript
let UNREAD_BY_THREAD = new Map();
let _pulseUrlCache = null;

async function _resolvePulseUrl() {
  if (_pulseUrlCache !== null) return _pulseUrlCache;
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    _pulseUrlCache = cfg.pulseUrl || '';
  } catch { _pulseUrlCache = ''; }
  return _pulseUrlCache;
}

async function refreshUnreadCounts() {
  const pulseUrl = await _resolvePulseUrl();
  if (!pulseUrl) return;
  try {
    const r = await fetch(`${pulseUrl}/api/pulse/entity-threads/unread-counts?type=inbox_thread`, {
      headers: { Authorization: 'Bearer ' + getToken() }
    });
    if (!r.ok) return;
    const rows = await r.json();
    UNREAD_BY_THREAD = new Map(rows.map(r => [r.entity_id, r.unread_mention_count]));
    paintUnreadChips();
    paintUnreadTotal();
  } catch { /* silent — chips just won't update this pass */ }
}

function paintUnreadChips() {
  document.querySelectorAll('[data-thread-id]').forEach(el => {
    const id = el.dataset.threadId;
    const n = UNREAD_BY_THREAD.get(id);
    let chip = el.querySelector('.unread-chip');
    if (n && n > 0) {
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'unread-chip badge badge-amber';
        chip.style.marginLeft = '6px';
        el.querySelector('.thread-title, .thread-meta, .si-row')?.appendChild(chip)
          || el.appendChild(chip);
      }
      chip.textContent = `💬${n}`;
    } else if (chip) {
      chip.remove();
    }
  });
}
```

(The exact DOM hook above — `[data-thread-id]` — depends on how `inbox.html` renders thread rows. Search the file for how threads get rendered; each thread row likely has the thread's id available in a data attribute or it can be added. If thread rows DON'T have `data-thread-id`, add it to the existing row template — one-liner change inside the existing `.map(t => ...)` block.)

- [ ] **Step 2: Wire the fetch into the page lifecycle**

Find the existing thread-list render function. After it finishes rendering, call `refreshUnreadCounts()`. Also call it on window focus:

```javascript
window.addEventListener('focus', refreshUnreadCounts);
```

- [ ] **Step 3: Add a top-of-page total**

`refreshUnreadCounts` (Step 1) already calls `paintUnreadTotal()`; this step adds that function and the span it targets.

Add the function next to `paintUnreadChips`:

```javascript
function paintUnreadTotal() {
  const total = [...UNREAD_BY_THREAD.values()].reduce((a, b) => a + b, 0);
  const el = document.getElementById('unread-total');
  if (el) el.textContent = total > 0 ? `💬 ${total} unread mention${total === 1 ? '' : 's'}` : '';
}
```

Add `<span id="unread-total" class="text-muted text-sm" style="margin-left:8px;"></span>` to the header markup near the existing inbox name / breadcrumb in `inbox.html`.

- [ ] **Step 4: Browser verification**

1. Open the bill thread, leave a comment that @-mentions another test user.
2. Sign in as that other user in a second browser. Open `/inbox.html` for them.
3. The thread row shows `💬1`. The header total reads `💬 1 unread mention`.
4. Click into that thread; the widget calls `mark-read` automatically (in `loadInitial` from Task 12). Go back to the inbox list — the chip is gone (after the page focus refresh).

- [ ] **Step 5: Commit**

```bash
git add inbox/public/inbox.html
git commit -m "$(cat <<'EOF'
inbox: unread-mention chip on each thread row + header total

Thread list page now polls Pulse's entity-threads/unread-counts
endpoint after load and on window focus. Each row with unread
mentions for the caller gets a 💬N chip; the header shows a total.
Cleared automatically when the user opens the thread (widget calls
mark-read in its initial load).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: End-to-end smoke + PR

**Files:**
- Reference only: `docs/superpowers/specs/2026-05-22-inbox-signatures-and-pulse-thread-comments-design.md` section 10

- [ ] **Step 1: Run the 10 smoke tests from spec section 10**

For each test below, perform the steps and confirm the expected result. Fix anything that doesn't work before opening the PR.

1. **Signature edit + preview.** Go to `/admin-shared.html`, pick an inbox, paste HTML, see live preview update, save, refresh, signature persists.
2. **Signature appended on reply.** Open a thread, hit Reply, type body, send, open the sent message in Gmail's web UI — signature appears below `--`.
3. **Signature skip checkbox.** Same as #2 with checkbox unchecked — no signature in sent.
4. **Empty signature hides checkbox.** Clear the signature, save, reply — no checkbox row.
5. **Mention picker shows everyone.** Type `@` in widget — picker lists full team incl. non-inbox users.
6. **Mention grants read.** From browser A (owner), @-mention a user with no inbox grant. From browser B as that user, the thread appears in `unread-counts` and is openable. From browser C as a third user (no grant, no mention), `GET /entity-threads?…` returns 403.
7. **SSE live update.** Two browsers open same thread; A posts, B sees without reload.
8. **Optimistic dedup.** A's own post appears once, not twice.
9. **Edit + delete.** A edits own message → "(edited)" badge. Deletes → row vanishes.
10. **Authz negative.** A user with no access POSTing to `/entity-threads/messages?...` returns 403; the SSE endpoint returns 403.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin claude/inbox-signatures-pulse-comments
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "Inbox: per-inbox HTML signatures + Pulse thread comments (Phase 3)" --body "$(cat <<'EOF'
## Summary

Two coordinated features so Inbox can replace Jordan's existing email tool:

1. **Per-inbox HTML email signatures.** Each shared inbox stores its own signature (raw HTML, edited from `/admin-shared.html`), appended automatically on reply and compose. Reply/compose forms include an "Include signature" checkbox (default on) for one-off sends without it.

2. **@-mentioned comments under email threads.** Built as a generic **Pulse entity-comments** subsystem (new `pulse_entity_threads` table, extended `chat_messages`) plus a vanilla-JS **embed widget**. Inbox drops the widget into the existing `<div id="pulse-slot">` on each thread. @-mentioning a user who lacks Acquisitions access auto-grants them read on that one thread only.

Spec: [docs/superpowers/specs/2026-05-22-inbox-signatures-and-pulse-thread-comments-design.md](docs/superpowers/specs/2026-05-22-inbox-signatures-and-pulse-thread-comments-design.md)
Plan: [docs/superpowers/plans/2026-05-22-inbox-signatures-and-pulse-thread-comments.md](docs/superpowers/plans/2026-05-22-inbox-signatures-and-pulse-thread-comments.md)

## Deployment order

1. Merge → `propspot-os` redeploys → schema migrations apply.
2. `pulse` redeploys → new REST routes + SSE entity subscriptions + widget.js available.
3. `inbox` redeploys → admin signature UI lights up, thread page loads widget.

Each step is forward-compatible with the previous deployed version — no fragile interleaving.

## Test plan

- [ ] Signature: paste HTML in admin → preview updates live → save → persists across refresh.
- [ ] Reply with signature on → Gmail shows it below `--`.
- [ ] Reply with checkbox off → no signature.
- [ ] Compose modal: signature checkbox follows the selected alias's inbox.
- [ ] Widget appears on every thread, loads existing comments.
- [ ] `@` opens the picker; picking inserts a mention chip; posting writes it.
- [ ] User without Acquisitions access who is `@`-mentioned can open the specific thread, not the inbox.
- [ ] User without mention or ambient access → 403 on `GET /entity-threads`.
- [ ] Two tabs open same thread → posts propagate live via SSE.
- [ ] Inbox list page shows `💬N` chip on threads with unread mentions; chip clears after opening.
- [ ] Edit + delete from the widget; SSE updates other tabs.

## Deferred to follow-up specs

- Email + mobile push notifications for mentions.
- Cross-app sidebar badge on the Inbox tile in FieldCam/Maintenance/etc.
- Entity-comments adoption in other propspot apps (FieldCam photos, work orders).
- Multiple signatures per inbox + picker on send.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Mark the writing-plans task complete**

This is the end of the plan. After the PR is opened, hand it to Jordan for review and merge.

---

## Spec coverage check

Going section-by-section through the spec to confirm everything is covered by a task:

- **Spec §4 (Signatures)** → Tasks 1, 2, 3, 4, 5, 6 ✓
- **Spec §5 (Pulse entity-comments — data model, authz, REST, SSE, mentions)** → Tasks 1, 7, 8, 9, 10, 11 ✓
- **Spec §6 (Embed widget)** → Task 12 ✓
- **Spec §7 (Inbox integration — widget on thread page + unread chips)** → Tasks 13, 14 ✓
- **Spec §8 (Data flow walkthrough)** → manual smoke test #6 in Task 15 ✓
- **Spec §9 (Migrations & rollout)** → Task 1 + Task 9 step 2 (the `pulse_entity_thread_reads` add) + Task 15 PR-body deployment order ✓
- **Spec §10 (Testing)** → Task 15 ✓
- **Spec §11 (Open questions)** → none, nothing to cover

All ten manual smoke tests from spec §10 are enumerated in Task 15 step 1.
