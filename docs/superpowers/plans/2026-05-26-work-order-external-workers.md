# Work-order assignments + external-worker portal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Assignee field to work orders, let admins invite external workers via the picker, and ship a stripped-down portal at `/my-work.html` where external workers see only their assignments and upload photos via FieldCam.

**Architecture:** Two schema columns (`work_orders.assigned_user_id`, `users.user_type`). No new tables — external-worker scoping reuses existing `app_grants` + `property_access`. Five independently-deployable stages, each its own PR.

**Tech Stack:** Node/Express, raw SQL on Postgres (via `db.query`), vanilla-JS frontend pages, Cloudinary for photo storage (via existing FieldCam code), Nodemailer for invite emails (via existing `lib/email.js`).

**Note on testing:** This codebase has no automated test suite — verification is manual (curl + browser) against the local Railway-connected `node server.js` instance. Each task includes specific verification steps. Do **not** add a test framework as part of this plan.

---

## Stage 1 — Schema + auth plumbing (PR #1)

Adds the two columns and exposes `user_type` through `/api/me`. No UI change yet; safe to deploy on its own. After this PR is merged, the schema-deploy gate (initDb running schema.sql on container boot) ensures the columns exist before any later stage touches them.

### Task 1.1: Add `work_orders.assigned_user_id` and `users.user_type` to schema.sql

**Files:**
- Modify: `propspot-os/db/schema.sql` (append at the bottom — schema.sql appends idempotent ALTERs at the end, not inline with the CREATE TABLE)

- [ ] **Step 1: Append the columns**

Open `propspot-os/db/schema.sql` and append after the last existing `ALTER`/`DO $$` block (at the very end of the file, before any trailing newline):

```sql
-- ── External-worker support (2026-05-26) ────────────────────────────────────
-- Assignee on a work order. Either a team member (users.user_type='team') or
-- an invited external worker (users.user_type='external_worker'). Replaces
-- the never-surfaced assigned_contact_id column going forward; that column
-- stays in place but is no longer read or written.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS work_orders_assigned_user_idx
  ON work_orders(assigned_user_id);

-- users.user_type — distinguishes regular team members from external workers
-- (vendors / contractors) invited to a stripped-down portal. Existing rows
-- default to 'team' via the column DEFAULT.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'team';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_user_type_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_user_type_check
      CHECK (user_type IN ('team','external_worker'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_user_type_idx ON users(user_type);
```

- [ ] **Step 2: Verify schema applies cleanly**

Run locally (requires Railway DATABASE_URL in `.env`):

```bash
cd propspot-os && node -e "require('./server.js')"
```

Watch the boot log. Expected: "schema.sql applied" or similar, no errors. Hit Ctrl+C once server is up.

- [ ] **Step 3: Confirm the columns exist**

```bash
psql "$DATABASE_URL" -c "\d work_orders" | grep assigned_user_id
psql "$DATABASE_URL" -c "\d users" | grep user_type
```

Expected: both lines present.

- [ ] **Step 4: Commit**

```bash
git add propspot-os/db/schema.sql
git commit -m "schema: add work_orders.assigned_user_id + users.user_type"
```

### Task 1.2: Surface `user_type` in `/api/me`

**Files:**
- Modify: `propspot-os/routes/auth.js` (the `GET /me` handler)

- [ ] **Step 1: Find the /me handler**

```bash
grep -n "router.get.*'/me'" propspot-os/routes/auth.js
```

- [ ] **Step 2: Add `user_type` to the SELECT and JSON response**

In the `GET /me` handler, find the SELECT that fetches the user. Add `user_type` to the column list. Add `user_type: user.user_type` to the response object. Example shape (verify against the actual handler):

```javascript
const { rows } = await query(
  `SELECT id, email, full_name, avatar_url, is_owner, user_type FROM users WHERE id = $1`,
  [req.userId]
);
// ...
res.json({
  id: user.id, email: user.email, full_name: user.full_name,
  avatar_url: user.avatar_url, is_owner: user.is_owner,
  user_type: user.user_type
});
```

- [ ] **Step 3: Verify**

```bash
TOKEN="<paste a JWT from localStorage.ros_token in the browser>"
curl -s -H "Authorization: Bearer $TOKEN" https://os.propspot.io/api/auth/me | jq .user_type
```

Expected: `"team"` for Jordan's user.

- [ ] **Step 4: Commit**

```bash
git add propspot-os/routes/auth.js
git commit -m "auth: include user_type in /api/auth/me response"
```

### Task 1.3: Accept `assigned_user_id` in the work-orders PATCH/POST

**Files:**
- Modify: `propspot-os/routes/maintenance/work-orders.js` lines 101-134 (POST) and 137-170 (PATCH)

- [ ] **Step 1: Add `assigned_user_id` to the POST handler**

In `propspot-os/routes/maintenance/work-orders.js`, at line ~104, change the destructuring + INSERT to include the new column:

```javascript
const {
  property_id, title, description, category, priority,
  status, assigned_contact_id, assigned_user_id,
  scheduled_for, cost_cents, notes
} = req.body;
```

And the INSERT (line ~110):

```javascript
const { rows } = await query(`
  INSERT INTO work_orders
    (property_id, title, description, category, priority, status,
     assigned_contact_id, assigned_user_id, reported_by,
     scheduled_for, cost_cents, notes, created_by)
  VALUES ($1,$2,$3,$4,COALESCE($5,'normal'),COALESCE($6,'open'),$7,$8,$9,$10,$11,$12,$13)
  RETURNING *
`, [
  property_id, title.trim(),
  description?.trim() || null,
  category?.trim() || null,
  priority || null,
  status || null,
  assigned_contact_id || null,
  assigned_user_id || null,
  req.userId,
  scheduled_for || null,
  cost_cents != null && cost_cents !== '' ? parseInt(cost_cents, 10) : null,
  notes?.trim() || null,
  req.userId
]);
```

- [ ] **Step 2: Add `assigned_user_id` to the PATCH allowlist**

At line ~138 the `allowed` array. Replace with:

```javascript
const allowed = ['title','description','category','priority','status',
                 'assigned_contact_id','assigned_user_id',
                 'scheduled_for','cost_cents','notes'];
```

- [ ] **Step 3: Verify (locally or against staging) — PATCH a WO**

Pick an existing work order ID and Jordan's user ID. Then:

```bash
curl -X PATCH https://os.propspot.io/api/work-orders/<WO_ID> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assigned_user_id":"<JORDAN_USER_ID>"}'
```

Expected: 200 OK, response includes `assigned_user_id` set to Jordan's ID. Confirm in DB:

```bash
psql "$DATABASE_URL" -c "SELECT id, title, assigned_user_id FROM work_orders WHERE id='<WO_ID>'"
```

- [ ] **Step 4: Commit + PR**

```bash
git add propspot-os/routes/maintenance/work-orders.js
git commit -m "work-orders: accept assigned_user_id in POST + PATCH"
gh pr create --title "schema + API: work-order assigned_user_id + users.user_type" \
  --body "Stage 1 of the external-worker plan: schema columns + /api/me returns user_type + work-orders POST/PATCH accept assigned_user_id. No UI change. Spec: docs/superpowers/specs/2026-05-26-work-order-external-workers-design.md"
```

Wait for Railway deploy to go green. Then merge.

---

## Stage 2 — Assignee picker UI (PR #2)

The picker + the "Assigned to me" filter pill. Still only assigns to *existing* users — invite flow comes in Stage 3.

### Task 2.1: Add `/api/maintenance/assignable-users` endpoint

**Files:**
- Create: `propspot-os/routes/maintenance/assignable-users.js`
- Modify: `propspot-os/server.js` (mount the route)

- [ ] **Step 1: Create the route file**

`propspot-os/routes/maintenance/assignable-users.js`:

```javascript
const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireMaintenanceGrant } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// GET /api/maintenance/assignable-users
//   Returns every user that can be assigned to a work order:
//   team members + previously-invited external workers (active or pending).
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, email, full_name, avatar_url, user_type,
             (password_hash IS NOT NULL OR google_sub IS NOT NULL) AS is_active
        FROM users
       ORDER BY user_type ASC, full_name ASC, email ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assignable users' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in server.js**

In `propspot-os/server.js`, find the block where other maintenance routes are mounted (search for `routes/maintenance/work-orders`). Add:

```javascript
app.use('/api/maintenance/assignable-users',
        require('./routes/maintenance/assignable-users'));
```

- [ ] **Step 3: Verify**

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://os.propspot.io/api/maintenance/assignable-users | jq '.[0]'
```

Expected: a JSON object with id/email/full_name/user_type/is_active.

- [ ] **Step 4: Commit**

```bash
git add propspot-os/routes/maintenance/assignable-users.js propspot-os/server.js
git commit -m "maintenance: /api/maintenance/assignable-users endpoint"
```

### Task 2.2: Build the picker UI in maintenance.html

**Files:**
- Modify: `propspot-os/public/maintenance.html` (the WO edit/detail modal — find the modal by searching for the work-order form)

- [ ] **Step 1: Find where the WO edit/detail modal lives**

```bash
grep -n "assigned_contact_id\|work-order-form\|wo-form\|edit-wo\|editWO" propspot-os/public/maintenance.html
```

The modal is the same place that currently renders the form for editing a WO. Locate the form's last field — the new Assignee field goes immediately after it.

- [ ] **Step 2: Add the Assignee row inside the form**

Insert this block in the WO edit form (location: after the existing fields, before the Save/Cancel buttons):

```html
<div class="form-row">
  <label for="wo-assignee">Assignee</label>
  <button type="button" id="wo-assignee-btn" class="picker-btn"
          onclick="openAssigneePicker()">
    <span id="wo-assignee-display" class="text-muted">Unassigned</span>
    <span class="picker-caret">▾</span>
  </button>
  <input type="hidden" id="wo-assigned-user-id" name="assigned_user_id" value="">
</div>
```

Add minimal styles inside the existing `<style>` block (after similar form styling):

```css
.picker-btn { display:flex; align-items:center; justify-content:space-between;
              width:100%; padding:8px 12px; border:1px solid var(--border);
              border-radius:6px; background:var(--surface); cursor:pointer;
              font-size:.88rem; }
.picker-btn:hover { border-color:var(--brand); }
.picker-caret { color:var(--text-muted); font-size:.7rem; margin-left:8px; }
```

- [ ] **Step 3: Add the picker popup HTML**

At the bottom of `<body>` (before the closing tag), add:

```html
<div id="assignee-picker" class="picker-popup" hidden>
  <div class="picker-overlay" onclick="closeAssigneePicker()"></div>
  <div class="picker-panel">
    <input id="assignee-search" type="text" placeholder="Search by name or email…" autofocus>
    <div id="assignee-results"></div>
    <button type="button" class="picker-action"
            onclick="openInviteExternalModal()">
      ➕ Invite external worker…
    </button>
  </div>
</div>
```

Styles:

```css
.picker-popup { position:fixed; inset:0; z-index:1000; }
.picker-overlay { position:absolute; inset:0; background:rgba(0,0,0,.4); }
.picker-panel { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
                width:420px; max-height:70vh; display:flex; flex-direction:column;
                background:var(--surface); border-radius:10px; box-shadow:var(--shadow-lg);
                overflow:hidden; }
.picker-panel input { margin:12px; padding:8px 12px; border:1px solid var(--border);
                      border-radius:6px; font-size:.9rem; }
#assignee-results { flex:1; overflow-y:auto; padding:0 8px; }
.picker-row { display:flex; align-items:center; gap:10px; padding:8px 12px;
              border-radius:6px; cursor:pointer; }
.picker-row:hover { background:var(--brand-light); }
.picker-avatar { width:28px; height:28px; border-radius:50%; background:var(--border);
                 display:flex; align-items:center; justify-content:center;
                 font-weight:600; font-size:.75rem; }
.picker-name { flex:1; }
.picker-name .name-line { font-size:.88rem; }
.picker-name .email-line { font-size:.72rem; color:var(--text-muted); }
.picker-pending-pip { width:6px; height:6px; border-radius:50%; background:#fbbf24; }
.picker-section-label { padding:8px 16px 4px; font-size:.7rem; text-transform:uppercase;
                        color:var(--text-muted); font-weight:600; }
.picker-action { margin:8px 12px 14px; padding:10px; background:var(--brand);
                 color:#fff; border:none; border-radius:6px; cursor:pointer;
                 font-weight:600; font-size:.85rem; }
```

- [ ] **Step 4: Wire up the JS — load users + render + select**

In the page's main `<script>` block, add (place near other top-level state vars and init code):

```javascript
let assignableUsers = [];

async function loadAssignableUsers() {
  try {
    assignableUsers = await apiFetch('/api/maintenance/assignable-users');
  } catch (e) { assignableUsers = []; }
}

function openAssigneePicker() {
  document.getElementById('assignee-picker').hidden = false;
  document.getElementById('assignee-search').value = '';
  document.getElementById('assignee-search').focus();
  renderAssigneeResults('');
}
function closeAssigneePicker() {
  document.getElementById('assignee-picker').hidden = true;
}

function renderAssigneeResults(needle) {
  const n = (needle || '').toLowerCase();
  const match = (u) => !n || (u.full_name || '').toLowerCase().includes(n)
                          || (u.email || '').toLowerCase().includes(n);
  const team = assignableUsers.filter(u => u.user_type === 'team' && match(u));
  const ext  = assignableUsers.filter(u => u.user_type === 'external_worker' && match(u));
  const row = (u) => {
    const initial = ((u.full_name || u.email || '?')[0] || '?').toUpperCase();
    const pending = !u.is_active ? '<span class="picker-pending-pip" title="Pending invite"></span>' : '';
    return `<div class="picker-row" onclick="selectAssignee('${u.id}','${escAttr(u.full_name || u.email)}')">
      <div class="picker-avatar">${escHtml(initial)}</div>
      <div class="picker-name">
        <div class="name-line">${escHtml(u.full_name || u.email)}</div>
        <div class="email-line">${escHtml(u.email)}</div>
      </div>
      ${pending}
    </div>`;
  };
  const html = [
    team.length ? `<div class="picker-section-label">Team</div>${team.map(row).join('')}` : '',
    ext.length  ? `<div class="picker-section-label">External workers</div>${ext.map(row).join('')}` : '',
    (!team.length && !ext.length) ? '<div class="text-muted text-sm" style="padding:14px;">No matches.</div>' : ''
  ].join('');
  document.getElementById('assignee-results').innerHTML = html;
}

function selectAssignee(userId, displayName) {
  document.getElementById('wo-assigned-user-id').value = userId;
  document.getElementById('wo-assignee-display').textContent = displayName;
  document.getElementById('wo-assignee-display').classList.remove('text-muted');
  closeAssigneePicker();
}

function escAttr(s) { return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

document.getElementById('assignee-search').addEventListener('input', e => {
  renderAssigneeResults(e.target.value);
});
```

- [ ] **Step 5: Wire the form submit to include `assigned_user_id`**

Find the function that PATCHes/POSTs the WO form (search for `apiFetch.*work-orders` in the page). Make sure the request body includes:

```javascript
assigned_user_id: document.getElementById('wo-assigned-user-id').value || null
```

If the form already gathers fields via `FormData` or a serialize helper that iterates inputs, the hidden input is picked up automatically.

- [ ] **Step 6: Populate the picker on edit (existing WO)**

When the edit modal opens for an existing WO, set the display from the WO's existing `assigned_user_id`. Find the function that hydrates the form for editing (search for `editWO\|openEditWO\|fillForm`). Add:

```javascript
if (wo.assigned_user_id) {
  const u = assignableUsers.find(x => x.id === wo.assigned_user_id);
  document.getElementById('wo-assigned-user-id').value = wo.assigned_user_id;
  document.getElementById('wo-assignee-display').textContent = u
    ? (u.full_name || u.email) : 'Assigned (unknown)';
  document.getElementById('wo-assignee-display').classList.remove('text-muted');
} else {
  document.getElementById('wo-assigned-user-id').value = '';
  document.getElementById('wo-assignee-display').textContent = 'Unassigned';
  document.getElementById('wo-assignee-display').classList.add('text-muted');
}
```

- [ ] **Step 7: Load users on page init**

In the page's main `init()` (search for `async function init` or DOMContentLoaded listener):

```javascript
await loadAssignableUsers();
```

- [ ] **Step 8: Verify in browser**

Open `/maintenance.html` in your browser. Edit a work order. Assignee field appears, says "Unassigned". Click → picker opens with team listed. Type to filter. Click Jordan → display updates to "Jordan Shutts". Save → PATCH fires with `assigned_user_id`. Reload — assignee persists.

- [ ] **Step 9: Commit**

```bash
git add propspot-os/public/maintenance.html
git commit -m "maintenance: assignee picker in WO edit modal"
```

### Task 2.3: Show assignee chip on each WO card

**Files:**
- Modify: `propspot-os/public/maintenance.html` (the work-order list-row renderer)
- Modify: `propspot-os/routes/maintenance/work-orders.js` (extend the SELECT to join users)

- [ ] **Step 1: Extend the list SELECT to include the assignee's name/avatar**

In `propspot-os/routes/maintenance/work-orders.js`, modify the GET `/` SELECT (line ~42-60). Replace the existing SELECT with one that also joins the assigned user:

```javascript
const sql = `
  SELECT wo.*,
         p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
         c.full_name AS assigned_name, c.phone AS assigned_phone, c.email AS assigned_email,
         au.full_name AS assigned_user_name,
         au.avatar_url AS assigned_user_avatar,
         u.full_name AS reported_by_name,
         (SELECT COUNT(*) FROM work_order_updates WHERE work_order_id = wo.id)::int AS update_count
    FROM work_orders wo
    JOIN properties p ON p.id = wo.property_id
    LEFT JOIN contacts c ON c.id = wo.assigned_contact_id
    LEFT JOIN users au   ON au.id = wo.assigned_user_id
    LEFT JOIN users u    ON u.id = wo.reported_by
   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
   ORDER BY
     CASE wo.status WHEN 'open' THEN 0 WHEN 'scheduled' THEN 1
                    WHEN 'in_progress' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
     CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                      WHEN 'normal' THEN 2 ELSE 3 END,
     wo.scheduled_for NULLS LAST,
     wo.created_at DESC
`;
```

Do the same for the GET `/:id` handler (line ~72-82): add `LEFT JOIN users au ON au.id = wo.assigned_user_id` and select `au.full_name AS assigned_user_name, au.avatar_url AS assigned_user_avatar`.

- [ ] **Step 2: Add the chip to the work-order card markup**

In `maintenance.html`, find the function that renders a WO row (search for `replace propane tank` or look at how cards are built). In the card template, after the status/priority pills, add:

```html
${wo.assigned_user_id ? `
  <span class="wo-assignee-chip" title="Assigned to ${escHtml(wo.assigned_user_name || '')}">
    ${wo.assigned_user_avatar
      ? `<img class="wo-assignee-avatar" src="${wo.assigned_user_avatar}">`
      : `<span class="wo-assignee-avatar">${escHtml(((wo.assigned_user_name || '?')[0]).toUpperCase())}</span>`}
    <span class="wo-assignee-name">${escHtml((wo.assigned_user_name || '').split(' ')[0])}</span>
  </span>`
: `<span class="wo-assignee-chip muted">Unassigned</span>`}
```

Styles (add inside the existing `<style>` block):

```css
.wo-assignee-chip { display:inline-flex; align-items:center; gap:6px;
                    padding:2px 8px 2px 2px; border-radius:100px;
                    background:var(--brand-light); font-size:.74rem; }
.wo-assignee-chip.muted { background:transparent; color:var(--text-muted);
                          padding:2px 8px; }
.wo-assignee-avatar { width:18px; height:18px; border-radius:50%;
                      background:var(--border); display:flex;
                      align-items:center; justify-content:center;
                      font-weight:600; font-size:.65rem; object-fit:cover; }
```

- [ ] **Step 3: Verify**

Reload `/maintenance.html`. The WO you assigned in Task 2.2 shows Jordan's first name + avatar on the right. Unassigned WOs show a grey "Unassigned" pill.

- [ ] **Step 4: Commit**

```bash
git add propspot-os/routes/maintenance/work-orders.js propspot-os/public/maintenance.html
git commit -m "maintenance: show assignee chip on WO cards"
```

### Task 2.4: "Assigned to me" filter pill

**Files:**
- Modify: `propspot-os/public/maintenance.html` (filter pills row + filter logic)

- [ ] **Step 1: Add the pill**

In the filter pills row (search for `data-f="active"` to locate it — that's the Active pill currently selected), insert a new pill after Active:

```html
<button class="pill" data-f="mine">Assigned to me</button>
```

- [ ] **Step 2: Wire the filter**

Find the filter-state JS (search for `currentFilter` or `data-f`). In the filter function that applies `currentFilter` to the WO list, add a branch:

```javascript
if (currentFilter === 'mine') {
  return workOrders.filter(wo => wo.assigned_user_id === currentUser?.id);
}
```

- [ ] **Step 3: Verify**

Reload. Click "Assigned to me" — only the WO assigned to Jordan shows. Click Active — everything's back.

- [ ] **Step 4: Commit + open PR**

```bash
git add propspot-os/public/maintenance.html
git commit -m "maintenance: Assigned to me filter pill"
gh pr create --title "Maintenance: assignee picker + Assigned to me pill" \
  --body "Stage 2 of the external-worker plan. Picker shows team members; inviting external workers comes next. Spec: docs/superpowers/specs/2026-05-26-work-order-external-workers-design.md"
```

Wait for Railway green, then merge.

---

## Stage 3 — Invite external worker flow (PR #3)

Adds the +Invite sub-modal and the backend endpoint that creates the user, grants apps + property, and emails an invite.

### Task 3.1: Backend — invite-external-worker endpoint

**Files:**
- Create: `propspot-os/routes/maintenance/invite-external-worker.js`
- Modify: `propspot-os/server.js` (mount)
- Modify: `propspot-os/lib/email.js` (add new email template variant)

- [ ] **Step 1: Add the new email template variant**

In `propspot-os/lib/email.js`, after `sendInviteEmail`, add:

```javascript
async function sendExternalWorkerInviteEmail({ to, inviteLink, inviterName, propertyAddress, workOrderTitle }) {
  if (!process.env.SMTP_HOST) {
    console.log('No SMTP configured — invite link:', inviteLink);
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `${inviterName} assigned you a work order at ${propertyAddress}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;">
      <h2 style="color:#61B746;">New work order assignment</h2>
      <p>${inviterName} assigned you a work order: <strong>${workOrderTitle}</strong></p>
      <p>Property: ${propertyAddress}</p>
      <div style="margin:30px 0;">
        <a href="${inviteLink}"
           style="background:#61B746;color:white;padding:12px 28px;
                  border-radius:6px;text-decoration:none;display:inline-block;
                  font-weight:600;">Accept invite & view work order</a>
      </div>
      <p style="color:#777;font-size:13px;">This link expires in 7 days.</p>
    </div>`
  });
  return true;
}
module.exports = { sendInviteEmail, sendPasswordResetEmail, sendExternalWorkerInviteEmail };
```

(Verify the existing `module.exports` line and merge the export — don't duplicate the existing one.)

- [ ] **Step 2: Create the route**

`propspot-os/routes/maintenance/invite-external-worker.js`:

```javascript
const express = require('express');
const crypto = require('crypto');
const { query, pool } = require('../../db');
const { requireAuth, requireMaintenanceGrant } = require('../../middleware/auth');
const { sendExternalWorkerInviteEmail } = require('../../lib/email');
const { logActivity } = require('../../lib/activity');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// POST /api/maintenance/work-orders/:id/invite-external-worker
//   body: { full_name, email }
router.post('/:id/invite-external-worker', async (req, res) => {
  const { full_name, email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!full_name?.trim()) {
    return res.status(400).json({ error: 'full_name required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reject if a TEAM user already exists with this email.
    const { rows: existing } = await client.query(
      `SELECT id, user_type FROM users WHERE LOWER(email) = LOWER($1)`, [email]
    );
    if (existing[0] && existing[0].user_type === 'team') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'team_member_exists',
        message: 'This email already belongs to a team member.' });
    }

    // Lookup WO + property.
    const { rows: woRows } = await client.query(
      `SELECT wo.id, wo.title, p.id AS property_id, p.address_line1, p.city, p.state
         FROM work_orders wo JOIN properties p ON p.id = wo.property_id
        WHERE wo.id = $1`, [req.params.id]
    );
    if (!woRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'work order not found' }); }
    const wo = woRows[0];

    // Upsert the user as external_worker with a fresh invite token.
    const token = crypto.randomBytes(32).toString('hex');
    const { rows: userRows } = await client.query(
      `INSERT INTO users (email, full_name, user_type, invite_token, invite_expires)
       VALUES ($1, $2, 'external_worker', $3, NOW() + INTERVAL '7 days')
       ON CONFLICT (email) DO UPDATE
         SET full_name      = EXCLUDED.full_name,
             user_type      = 'external_worker',
             invite_token   = EXCLUDED.invite_token,
             invite_expires = EXCLUDED.invite_expires
       RETURNING id, email, full_name`,
      [email.toLowerCase(), full_name.trim(), token]
    );
    const user = userRows[0];

    // Grant app access (idempotent).
    await client.query(`
      INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
      SELECT $1, id, 'member', '{"all":true}'::jsonb, $2
        FROM apps WHERE slug IN ('maintenance','fieldcam')
      ON CONFLICT (user_id, app_id) DO NOTHING
    `, [user.id, req.userId]);

    // Grant property access for the WO's property (idempotent).
    await client.query(`
      INSERT INTO property_access (property_id, user_id, access_level, granted_by)
      VALUES ($1, $2, 'view', $3)
      ON CONFLICT (property_id, user_id) DO NOTHING
    `, [wo.property_id, user.id, req.userId]);

    // Assign the WO to this user.
    await client.query(
      `UPDATE work_orders SET assigned_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [user.id, req.params.id]
    );

    await client.query('COMMIT');

    // Build the invite link.
    const appUrl = process.env.APP_URL || 'https://os.propspot.io';
    const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;

    // Fetch inviter name (outside the txn — read-only).
    const { rows: inviterRows } = await query(
      `SELECT full_name FROM users WHERE id = $1`, [req.userId]
    );
    const inviterName = inviterRows[0]?.full_name || 'Your teammate';
    const propertyAddress = `${wo.address_line1}, ${wo.city || ''} ${wo.state || ''}`.trim();

    let emailSent = false;
    try {
      emailSent = await sendExternalWorkerInviteEmail({
        to: email, inviteLink, inviterName,
        propertyAddress, workOrderTitle: wo.title
      });
    } catch (e) { console.error('email send failed', e); }

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: user.id,
      action: 'external_worker_invited',
      payload: { email, work_order_id: req.params.id }
    });

    res.status(201).json({
      user, inviteLink: emailSent ? undefined : inviteLink,
      emailSent
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to invite external worker' });
  } finally {
    client.release();
  }
});

module.exports = router;
```

- [ ] **Step 3: Mount in server.js**

In `propspot-os/server.js`, in the same block as other maintenance routes:

```javascript
app.use('/api/maintenance/work-orders',
        require('./routes/maintenance/invite-external-worker'));
```

(Note: this mounts on the same prefix as work-orders, since the path is `/:id/invite-external-worker`. Express will route correctly. If conflict arises, change the route prefix in the file to `/work-orders/:id/invite-external-worker` and mount under `/api/maintenance`.)

- [ ] **Step 4: Verify**

Pick a WO ID. Run:

```bash
curl -X POST https://os.propspot.io/api/maintenance/work-orders/<WO_ID>/invite-external-worker \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Test Vendor","email":"test+ext1@example.com"}'
```

Expected: 201, response includes `user.id`. In DB:

```bash
psql "$DATABASE_URL" -c "SELECT email, user_type, password_hash IS NULL AS is_pending FROM users WHERE email='test+ext1@example.com'"
psql "$DATABASE_URL" -c "SELECT a.slug FROM app_grants ag JOIN apps a ON a.id=ag.app_id WHERE ag.user_id=(SELECT id FROM users WHERE email='test+ext1@example.com')"
psql "$DATABASE_URL" -c "SELECT property_id FROM property_access WHERE user_id=(SELECT id FROM users WHERE email='test+ext1@example.com')"
psql "$DATABASE_URL" -c "SELECT assigned_user_id FROM work_orders WHERE id='<WO_ID>'"
```

All four checks should match the spec. Try the same curl with an existing team-member email — expect 409.

- [ ] **Step 5: Commit**

```bash
git add propspot-os/routes/maintenance/invite-external-worker.js \
        propspot-os/lib/email.js propspot-os/server.js
git commit -m "maintenance: POST /:id/invite-external-worker + email"
```

### Task 3.2: Sub-modal UI for inviting

**Files:**
- Modify: `propspot-os/public/maintenance.html`

- [ ] **Step 1: Add the modal HTML**

Add at the bottom of `<body>`:

```html
<div id="invite-external-modal" class="picker-popup" hidden>
  <div class="picker-overlay" onclick="closeInviteExternalModal()"></div>
  <div class="picker-panel" style="width:380px;">
    <h3 style="margin:14px 16px 4px;font-size:1rem;">Invite external worker</h3>
    <p class="text-muted text-sm" style="margin:0 16px 12px;">
      They'll get an email and only see work orders assigned to them.
    </p>
    <input id="invite-ext-name" type="text" placeholder="Full name">
    <input id="invite-ext-email" type="email" placeholder="email@example.com">
    <div id="invite-ext-error" class="text-sm" style="color:#dc2626;margin:0 16px;display:none;"></div>
    <div style="display:flex;gap:8px;margin:12px 16px 16px;">
      <button type="button" class="btn btn-secondary"
              style="flex:1;" onclick="closeInviteExternalModal()">Cancel</button>
      <button type="button" id="invite-ext-submit" class="btn btn-primary"
              style="flex:1;" onclick="submitInviteExternal()">Send invite</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Wire the JS**

In the script block:

```javascript
function openInviteExternalModal() {
  closeAssigneePicker();
  document.getElementById('invite-external-modal').hidden = false;
  document.getElementById('invite-ext-name').value = '';
  document.getElementById('invite-ext-email').value = '';
  document.getElementById('invite-ext-error').style.display = 'none';
  document.getElementById('invite-ext-name').focus();
}
function closeInviteExternalModal() {
  document.getElementById('invite-external-modal').hidden = true;
}

async function submitInviteExternal() {
  const name  = document.getElementById('invite-ext-name').value.trim();
  const email = document.getElementById('invite-ext-email').value.trim();
  const errEl = document.getElementById('invite-ext-error');
  errEl.style.display = 'none';
  if (!name || !email) {
    errEl.textContent = 'Name and email required.';
    errEl.style.display = 'block'; return;
  }
  const woId = document.getElementById('wo-form')?.dataset.woId
            || window.currentEditingWoId; // adapt to whatever the page uses
  if (!woId) {
    errEl.textContent = 'Save the work order first, then invite.';
    errEl.style.display = 'block'; return;
  }
  const btn = document.getElementById('invite-ext-submit');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await apiFetch(`/api/maintenance/work-orders/${woId}/invite-external-worker`,
      { method: 'POST', body: JSON.stringify({ full_name: name, email }) });
    closeInviteExternalModal();
    // Refresh users + the WO list so the new assignment shows up.
    await loadAssignableUsers();
    selectAssignee(r.user.id, r.user.full_name || r.user.email);
    showToast('Invite sent to ' + email);
    if (typeof loadWorkOrders === 'function') await loadWorkOrders();
  } catch (e) {
    if (e.status === 409) {
      errEl.textContent = 'This email already belongs to a team member.';
    } else {
      errEl.textContent = e.message || 'Failed to send invite.';
    }
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}
```

(Note: `apiFetch` already throws on non-2xx with `.status`; verify against `propspot-os/public/app.js`. If it doesn't expose `.status`, fall back to parsing `error` from the response body.)

- [ ] **Step 3: Verify**

In browser: edit a WO → open picker → click "+ Invite external worker…" → fill name + email of a new address → Send. Toast appears. Picker reopens with the new user already selected in the External workers section with a pending pip.

Check your email (or the server log if no SMTP): the invite link is present.

Try inviting with an existing team-member email → red error appears: "This email already belongs to a team member."

- [ ] **Step 4: Commit + PR**

```bash
git add propspot-os/public/maintenance.html
git commit -m "maintenance: invite external worker sub-modal"
gh pr create --title "Maintenance: invite external workers from the assignee picker" \
  --body "Stage 3 of the external-worker plan. Adds POST /api/maintenance/work-orders/:id/invite-external-worker and the +Invite sub-modal. Sends invite emails (uses existing SMTP setup). Next stage builds /my-work.html."
```

Wait for Railway green, merge.

---

## Stage 4 — External-worker portal (PR #4)

The biggest stage. New `/my-work.html` page, routing guard, scoped API endpoints, FieldCam integration.

### Task 4.1: GET /api/my-work-orders endpoint

**Files:**
- Create: `propspot-os/routes/my-work-orders.js`
- Modify: `propspot-os/server.js` (mount)

- [ ] **Step 1: Create the route**

`propspot-os/routes/my-work-orders.js`:

```javascript
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/my-work-orders — WOs assigned to the current user.
//   Returns property fields needed to render the portal without further joins.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wo.id, wo.title, wo.description, wo.category, wo.priority, wo.status,
             wo.scheduled_for, wo.created_at, wo.updated_at,
             wo.property_id,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
             rep.full_name AS reported_by_name,
             (SELECT COUNT(*) FROM work_order_updates WHERE work_order_id = wo.id)::int AS update_count
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id
        LEFT JOIN users rep ON rep.id = wo.reported_by
       WHERE wo.assigned_user_id = $1
       ORDER BY
         CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                          WHEN 'normal' THEN 2 ELSE 3 END,
         wo.scheduled_for NULLS LAST,
         wo.created_at DESC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your work orders' });
  }
});

// GET /api/my-work-orders/:id — single WO + updates + property photos
router.get('/:id', async (req, res) => {
  try {
    const { rows: woRows } = await query(`
      SELECT wo.*,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id
       WHERE wo.id = $1 AND wo.assigned_user_id = $2
    `, [req.params.id, req.userId]);
    if (!woRows[0]) return res.status(404).json({ error: 'not found' });
    const wo = woRows[0];

    const { rows: updates } = await query(`
      SELECT wou.*, u.full_name AS author_name
        FROM work_order_updates wou
        LEFT JOIN users u ON u.id = wou.user_id
       WHERE wou.work_order_id = $1
       ORDER BY wou.created_at ASC
    `, [req.params.id]);

    res.json({ ...wo, updates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load work order' });
  }
});

// PATCH /api/my-work-orders/:id — external worker can only flip status
//   among open / in_progress / completed.
router.patch('/:id', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['open', 'in_progress', 'completed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + allowed.join(', ') });
  }
  try {
    const stamp = status === 'completed' ? 'COALESCE(completed_at, NOW())' : 'NULL';
    const { rows } = await query(`
      UPDATE work_orders
         SET status = $1,
             completed_at = ${stamp},
             updated_at = NOW()
       WHERE id = $2 AND assigned_user_id = $3
       RETURNING id, status, completed_at
    `, [status, req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// POST /api/my-work-orders/:id/updates — external worker posts a thread update
router.post('/:id/updates', async (req, res) => {
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });
  try {
    // Verify WO assignment.
    const { rows: own } = await query(
      `SELECT 1 FROM work_orders WHERE id = $1 AND assigned_user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!own[0]) return res.status(404).json({ error: 'not found' });

    const { rows } = await query(`
      INSERT INTO work_order_updates (work_order_id, user_id, body)
      VALUES ($1, $2, $3) RETURNING *
    `, [req.params.id, req.userId, body.trim()]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post update' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in server.js**

```javascript
app.use('/api/my-work-orders', require('./routes/my-work-orders'));
```

- [ ] **Step 3: Verify**

Use the accept-invite link from Task 3.1 to set a password for the test external user, log in as them, then:

```bash
TOKEN_EXT="<external user JWT>"
curl -s -H "Authorization: Bearer $TOKEN_EXT" \
  https://os.propspot.io/api/my-work-orders | jq '.[0].title'
```

Expected: the WO they were assigned to.

- [ ] **Step 4: Commit**

```bash
git add propspot-os/routes/my-work-orders.js propspot-os/server.js
git commit -m "api: /api/my-work-orders for external-worker portal"
```

### Task 4.2: Routing guard middleware

**Files:**
- Modify: `propspot-os/middleware/auth.js` (add `requireTeamUser`)
- Modify: `propspot-os/server.js` (apply to HTML page routes)

- [ ] **Step 1: Add the middleware**

In `propspot-os/middleware/auth.js`, before `module.exports`, add:

```javascript
// requireTeamUser: redirect external_worker users to /my-work.html on any HTML page.
// JWT-protected pages typically read the token from localStorage, not cookies — so
// we apply this guard server-side on the static-HTML routes by checking a
// token cookie OR the Authorization header. If the user is external_worker, send
// 302 to /my-work.html; otherwise fall through.
//
// NOTE: this is a soft guard. The real authorization happens at API level, which
// is already scoped via the assigned_user_id checks in my-work-orders.js. The
// guard here is purely UX — it prevents the external worker from landing on the
// regular dashboard if they manually type /dashboard.html.
function redirectExternalToPortal(allowedPages) {
  const allow = new Set(allowedPages);
  return async (req, res, next) => {
    // Pull token from cookie OR Authorization header.
    let token = req.cookies?.ros_token;
    if (!token) {
      const h = req.headers.authorization;
      if (h?.startsWith('Bearer ')) token = h.slice(7);
    }
    if (!token) return next(); // unauthenticated → let login flow handle
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query(
        `SELECT user_type FROM users WHERE id = $1`, [payload.userId]
      );
      if (rows[0]?.user_type === 'external_worker'
          && !allow.has(req.path)) {
        return res.redirect(302, '/my-work.html');
      }
    } catch (_) { /* invalid token → let request proceed; login pages handle it */ }
    next();
  };
}

module.exports = { requireAuth, requireOwner, requireMaintenanceGrant,
                   requirePulseGrant, requireInboxGrant,
                   redirectExternalToPortal };
```

(Merge with the existing `module.exports` — don't duplicate.)

- [ ] **Step 2: Apply in server.js**

In `propspot-os/server.js`, BEFORE `express.static('public')` is registered (search for `express.static`), add:

```javascript
const { redirectExternalToPortal } = require('./middleware/auth');
app.use((req, res, next) => {
  // Only gate HTML navigations. Assets (.js, .css), API (/api/*), and
  // websocket upgrades fall straight through.
  if (!req.path.endsWith('.html') && req.path !== '/') return next();
  return redirectExternalToPortal([
    '/my-work.html', '/accept-invite.html', '/forgot-password.html',
    '/reset-password.html', '/login.html', '/index.html', '/'
  ])(req, res, next);
});
```

- [ ] **Step 3: Verify**

Once `/my-work.html` exists (Task 4.4), log in as the external user and try opening `/dashboard.html` directly — you should land on `/my-work.html` instead. (Skip this verification until 4.4 is done.)

- [ ] **Step 4: Commit**

```bash
git add propspot-os/middleware/auth.js propspot-os/server.js
git commit -m "auth: redirect external_worker users to /my-work.html"
```

### Task 4.3: Add a token cookie at login (so the routing guard can read it)

**Files:**
- Modify: `propspot-os/routes/auth.js` (the `POST /login` and `POST /accept-invite` handlers)

- [ ] **Step 1: Set a cookie alongside the JWT in /login**

Find `POST /login` in `propspot-os/routes/auth.js`. After `res.json({ token, ... })`, change to:

```javascript
res.cookie('ros_token', token, {
  httpOnly: true, secure: true, sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
});
res.json({ token, user });  // preserve whatever shape the existing handler returns
```

Do the same in the `/accept-invite` handler.

- [ ] **Step 2: Ensure cookie-parser is loaded**

Check `propspot-os/server.js` for `cookie-parser`. If absent:

```bash
cd propspot-os && npm install cookie-parser
```

Then in `server.js`, near the top:

```javascript
const cookieParser = require('cookie-parser');
app.use(cookieParser());
```

- [ ] **Step 3: Verify cookie is set**

Log in via the browser, open DevTools → Application → Cookies → confirm `ros_token` is present.

- [ ] **Step 4: Commit**

```bash
git add propspot-os/routes/auth.js propspot-os/server.js propspot-os/package.json propspot-os/package-lock.json
git commit -m "auth: set ros_token cookie on login + accept-invite"
```

### Task 4.4: Build /my-work.html

**Files:**
- Create: `propspot-os/public/my-work.html`

- [ ] **Step 1: Create the page**

Create `propspot-os/public/my-work.html`. Full file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#61B746">
  <title>Prop Spot — My Work</title>
  <link rel="icon" type="image/png" href="/logo.png">
  <link rel="stylesheet" href="style.css">
  <style>
    body { margin:0; font-family:-apple-system,Inter,sans-serif; background:var(--bg); color:var(--text); }
    .mw-header { display:flex; align-items:center; justify-content:space-between;
                 padding:12px 20px; background:var(--surface);
                 border-bottom:1px solid var(--border); }
    .mw-logo { font-weight:700; font-size:1.05rem; color:var(--brand); }
    .mw-user { font-size:.85rem; color:var(--text-muted); }
    .mw-user a { color:var(--text-muted); margin-left:14px; text-decoration:underline; }
    .mw-layout { display:flex; height:calc(100vh - 56px); }
    .mw-list { width:40%; max-width:480px; border-right:1px solid var(--border);
               overflow-y:auto; background:var(--surface); }
    .mw-detail { flex:1; overflow-y:auto; padding:20px; }
    .mw-row { padding:14px 16px; border-bottom:1px solid var(--border); cursor:pointer; }
    .mw-row:hover { background:var(--brand-light); }
    .mw-row.active { background:var(--brand-light); border-left:3px solid var(--brand); }
    .mw-row-title { font-weight:600; font-size:.92rem; margin-bottom:3px; }
    .mw-row-addr { font-size:.78rem; color:var(--text-muted); }
    .mw-row-pills { margin-top:6px; display:flex; gap:4px; flex-wrap:wrap; }
    .mw-pill { font-size:.66rem; padding:2px 8px; border-radius:100px; font-weight:600; }
    .mw-pill.open { background:#dbeafe; color:#1e40af; }
    .mw-pill.in_progress { background:#fef3c7; color:#92400e; }
    .mw-pill.completed { background:#dcfce7; color:#15803d; }
    .mw-pill.scheduled { background:#ede9fe; color:#6d28d9; }
    .mw-pill.urgent { background:#fee2e2; color:#991b1b; }
    .mw-pill.high { background:#ffedd5; color:#9a3412; }
    .mw-empty { padding:60px 20px; text-align:center; color:var(--text-muted); }
    .mw-section { margin-bottom:24px; }
    .mw-section h3 { font-size:.78rem; text-transform:uppercase; color:var(--text-muted);
                     letter-spacing:.05em; margin:0 0 8px; }
    .mw-photo-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr));
                     gap:8px; }
    .mw-photo { aspect-ratio:1; background:var(--border); border-radius:6px;
                background-size:cover; background-position:center; cursor:pointer; }
    .mw-upload-btn { display:inline-block; padding:10px 18px; background:var(--brand);
                     color:#fff; border:none; border-radius:6px; font-weight:600;
                     cursor:pointer; }
    .mw-status-select { padding:6px 10px; border:1px solid var(--border);
                        border-radius:6px; background:var(--surface); font-size:.85rem; }
    .mw-update { padding:10px 0; border-bottom:1px solid var(--border); font-size:.88rem; }
    .mw-update:last-child { border-bottom:none; }
    .mw-update-meta { font-size:.72rem; color:var(--text-muted); margin-bottom:3px; }
    @media (max-width:768px) {
      .mw-layout { flex-direction:column; height:auto; }
      .mw-list { width:100%; max-width:none; max-height:50vh; }
      .mw-detail { padding:14px; }
    }
  </style>
</head>
<body>

<header class="mw-header">
  <div class="mw-logo">Prop Spot</div>
  <div class="mw-user">
    <span id="mw-user-name"></span>
    <a href="#" onclick="signOut(); return false;">Sign out</a>
  </div>
</header>

<div class="mw-layout">
  <aside class="mw-list" id="mw-list">
    <p class="text-muted text-sm" style="padding:14px;">Loading…</p>
  </aside>
  <main class="mw-detail" id="mw-detail">
    <div class="mw-empty">Select a work order on the left.</div>
  </main>
</div>

<script src="config.js"></script>
<script src="app.js"></script>
<script>
let myWorkOrders = [], activeWo = null, currentUser = null;

async function init() {
  currentUser = await requireAuth();
  if (!currentUser) return;
  document.getElementById('mw-user-name').textContent = currentUser.full_name || currentUser.email;
  // Defense-in-depth: if a team user lands here, send them to dashboard.
  if (currentUser.user_type === 'team') { location.href = '/dashboard.html'; return; }
  await loadList();
}

async function loadList() {
  try {
    myWorkOrders = await apiFetch('/api/my-work-orders');
    renderList();
    if (myWorkOrders[0]) openWo(myWorkOrders[0].id);
  } catch (e) {
    document.getElementById('mw-list').innerHTML =
      `<p class="text-muted text-sm" style="padding:14px;">Error: ${esc(e.message)}</p>`;
  }
}

function renderList() {
  if (!myWorkOrders.length) {
    document.getElementById('mw-list').innerHTML =
      `<div class="mw-empty">Nothing assigned to you yet.<br>Your team will let you know when there's work.</div>`;
    document.getElementById('mw-detail').innerHTML = '';
    return;
  }
  document.getElementById('mw-list').innerHTML = myWorkOrders.map(wo => {
    const addr = [wo.address_line1, wo.unit].filter(Boolean).join(', ');
    const active = activeWo?.id === wo.id ? ' active' : '';
    return `<div class="mw-row${active}" onclick="openWo('${wo.id}')">
      <div class="mw-row-title">${esc(wo.title)}</div>
      <div class="mw-row-addr">${esc(addr)} · ${esc(wo.city || '')} ${esc(wo.state || '')}</div>
      <div class="mw-row-pills">
        <span class="mw-pill ${wo.status}">${esc(wo.status.replace('_',' '))}</span>
        ${wo.priority === 'urgent' || wo.priority === 'high'
          ? `<span class="mw-pill ${wo.priority}">${wo.priority}</span>` : ''}
        ${wo.scheduled_for ? `<span class="text-muted" style="font-size:.7rem;">${wo.scheduled_for}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function openWo(id) {
  try {
    activeWo = await apiFetch('/api/my-work-orders/' + id);
    renderList();
    await renderDetail();
  } catch (e) {
    document.getElementById('mw-detail').innerHTML =
      `<p class="text-muted text-sm">Error: ${esc(e.message)}</p>`;
  }
}

async function renderDetail() {
  const wo = activeWo;
  const addr = [wo.address_line1, wo.unit].filter(Boolean).join(', ');
  // Photos for the property.
  let photos = [];
  try { photos = await apiFetch('/api/photos?property_id=' + wo.property_id); }
  catch (_) { photos = []; }

  document.getElementById('mw-detail').innerHTML = `
    <h1 style="margin:0 0 4px;font-size:1.3rem;">${esc(wo.title)}</h1>
    <p class="text-muted" style="margin:0 0 16px;">${esc(addr)} · ${esc(wo.city || '')} ${esc(wo.state || '')}</p>

    <div class="mw-section">
      <h3>Status</h3>
      <select class="mw-status-select" onchange="changeStatus(this.value)">
        ${['open','in_progress','completed'].map(s =>
          `<option value="${s}"${s === wo.status ? ' selected' : ''}>${s.replace('_',' ')}</option>`
        ).join('')}
      </select>
    </div>

    ${wo.description ? `<div class="mw-section">
      <h3>Description</h3>
      <p style="font-size:.92rem;white-space:pre-wrap;">${esc(wo.description)}</p>
    </div>` : ''}

    <div class="mw-section">
      <h3>Photos</h3>
      <div class="mw-photo-grid">
        ${photos.slice(0, 60).map(ph =>
          `<div class="mw-photo" style="background-image:url('${esc(ph.thumb_url || ph.url)}')"
                onclick="window.open('${esc(ph.url)}','_blank')"></div>`
        ).join('')}
      </div>
      <button class="mw-upload-btn" style="margin-top:12px;" onclick="uploadPhotos()">
        + Upload photos
      </button>
    </div>

    <div class="mw-section">
      <h3>Updates</h3>
      <div id="mw-updates">${(wo.updates || []).map(u =>
        `<div class="mw-update">
          <div class="mw-update-meta">${esc(u.author_name || 'Anonymous')} · ${relTime(u.created_at)}</div>
          <div>${esc(u.body)}</div>
        </div>`
      ).join('') || '<p class="text-muted text-sm">No updates yet.</p>'}</div>
      <textarea id="mw-update-input" rows="2" style="width:100%;margin-top:8px;padding:8px;
                border:1px solid var(--border);border-radius:6px;" placeholder="Post an update…"></textarea>
      <button class="mw-upload-btn" style="margin-top:6px;" onclick="postUpdate()">Post update</button>
    </div>
  `;
}

async function changeStatus(status) {
  try {
    await apiFetch('/api/my-work-orders/' + activeWo.id, {
      method: 'PATCH', body: JSON.stringify({ status })
    });
    activeWo.status = status;
    showToast('Status updated');
    await loadList();
  } catch (e) { showToast(e.message, 'error'); }
}

async function postUpdate() {
  const body = document.getElementById('mw-update-input').value.trim();
  if (!body) return;
  try {
    await apiFetch('/api/my-work-orders/' + activeWo.id + '/updates', {
      method: 'POST', body: JSON.stringify({ body })
    });
    document.getElementById('mw-update-input').value = '';
    await openWo(activeWo.id);
  } catch (e) { showToast(e.message, 'error'); }
}

function uploadPhotos() {
  // Reuse the existing FieldCam upload page, pre-scoped to this property.
  window.location.href = '/fieldcam.html?property_id=' + activeWo.property_id;
}

function signOut() {
  try { localStorage.removeItem('ros_token'); localStorage.removeItem('ros_user'); } catch(_){}
  document.cookie = 'ros_token=; Max-Age=0; path=/';
  location.href = '/login.html';
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function relTime(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 60000;
  if (d < 1) return 'just now';
  if (d < 60) return Math.floor(d) + 'm ago';
  if (d < 1440) return Math.floor(d/60) + 'h ago';
  return Math.floor(d/1440) + 'd ago';
}
function showToast(msg, kind) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
                     background:${kind==='error'?'#dc2626':'#111'};color:#fff;
                     padding:10px 20px;border-radius:6px;z-index:9999;font-size:.88rem;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

init();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify in browser**

As the external test user, open `/my-work.html`. You see your assigned WO on the left, detail on the right. Status dropdown works. Photos render (if the property has any). Click "+ Upload photos" → goes to `/fieldcam.html?property_id=...` and uploads work (existing flow).

Try opening `/dashboard.html` directly as the external user → routing guard from Task 4.2 redirects to `/my-work.html`.

- [ ] **Step 3: Commit + open PR**

```bash
git add propspot-os/public/my-work.html
git commit -m "portal: /my-work.html for external workers"
gh pr create --title "External-worker portal at /my-work.html" \
  --body "Stage 4 of the external-worker plan. New page, scoped API, routing guard. After this merges, invited external workers log in via the existing accept-invite flow and land on a stripped-down portal showing only their assigned WOs."
```

Wait for Railway green, merge.

---

## Stage 5 — Notifications (PR #5)

Email is already wired in Task 3.1 for the initial invite. This stage adds notifications when an existing user is re-assigned (no invite needed) — both email and a Pulse mention in `#maintenance`.

### Task 5.1: Notify on re-assignment

**Files:**
- Modify: `propspot-os/routes/maintenance/work-orders.js` (the PATCH handler)
- Modify: `propspot-os/lib/email.js` (add a generic re-assignment email)

- [ ] **Step 1: Add a re-assignment email template**

In `propspot-os/lib/email.js`, after `sendExternalWorkerInviteEmail`:

```javascript
async function sendWorkOrderAssignmentEmail({ to, recipientName, inviterName, propertyAddress, workOrderTitle, link }) {
  if (!process.env.SMTP_HOST) {
    console.log('No SMTP — assignment notification skipped for', to);
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `${inviterName} assigned you a work order at ${propertyAddress}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;">
      <h2 style="color:#61B746;">New work order assignment</h2>
      <p>Hi ${recipientName || ''},</p>
      <p>${inviterName} assigned you to <strong>${workOrderTitle}</strong> at ${propertyAddress}.</p>
      <div style="margin:30px 0;">
        <a href="${link}" style="background:#61B746;color:white;padding:12px 28px;
                                 border-radius:6px;text-decoration:none;display:inline-block;
                                 font-weight:600;">Open work order</a>
      </div>
    </div>`
  });
  return true;
}
module.exports.sendWorkOrderAssignmentEmail = sendWorkOrderAssignmentEmail;
```

- [ ] **Step 2: Hook into PATCH /api/work-orders/:id**

In `propspot-os/routes/maintenance/work-orders.js` PATCH handler (line ~137), after the UPDATE returns, if `assigned_user_id` was set in the request body AND differs from the previous value AND is not the current user:

```javascript
// fire-and-forget notifications on assignment change
if (req.body.assigned_user_id && rows[0].assigned_user_id !== req.userId) {
  notifyAssignment({
    woId: rows[0].id,
    assigneeId: rows[0].assigned_user_id,
    inviterId: req.userId
  }).catch(e => console.error('notify failed', e));
}
```

Add at the bottom of the file (above `module.exports`):

```javascript
const { sendWorkOrderAssignmentEmail } = require('../../lib/email');

async function notifyAssignment({ woId, assigneeId, inviterId }) {
  // Load assignee + WO + property + inviter in one shot.
  const { rows } = await query(`
    SELECT u.email, u.full_name AS recipient_name, u.user_type,
           inv.full_name AS inviter_name,
           wo.title AS wo_title,
           p.address_line1, p.city, p.state
      FROM users u
      JOIN work_orders wo ON wo.id = $1
      JOIN properties p ON p.id = wo.property_id
      JOIN users inv ON inv.id = $3
     WHERE u.id = $2
  `, [woId, assigneeId, inviterId]);
  if (!rows[0]) return;
  const r = rows[0];
  const propertyAddress = `${r.address_line1}, ${r.city || ''} ${r.state || ''}`.trim();
  const link = r.user_type === 'external_worker'
    ? `${process.env.APP_URL || 'https://os.propspot.io'}/my-work.html`
    : `${process.env.APP_URL || 'https://os.propspot.io'}/maintenance.html?wo=${woId}`;

  // Email — always.
  await sendWorkOrderAssignmentEmail({
    to: r.email, recipientName: r.recipient_name,
    inviterName: r.inviter_name,
    propertyAddress, workOrderTitle: r.wo_title, link
  }).catch(e => console.error(e));

  // Pulse mention — team users only.
  if (r.user_type === 'team') {
    await postMaintenancePulseMention({
      assigneeId, woTitle: r.wo_title, propertyAddress,
      inviterId, inviterName: r.inviter_name
    }).catch(e => console.error(e));
  }
}

async function postMaintenancePulseMention({ assigneeId, woTitle, propertyAddress, inviterId, inviterName }) {
  // Get the #maintenance channel id (slug='maintenance'). Skip silently if missing.
  const { rows: chRows } = await query(
    `SELECT id FROM chat_channels WHERE slug = 'maintenance' LIMIT 1`
  );
  if (!chRows[0]) return;
  const channelId = chRows[0].id;
  const body = `${inviterName} assigned <@${assigneeId}> to "${woTitle}" at ${propertyAddress}`;
  // Insert the chat_message + chat_mentions in one transaction.
  const { rows: msgRows } = await query(`
    INSERT INTO chat_messages (channel_id, sender_id, body)
    VALUES ($1, $2, $3) RETURNING id
  `, [channelId, inviterId, body]);
  await query(`
    INSERT INTO chat_mentions (message_id, mentioned_user_id)
    VALUES ($1, $2) ON CONFLICT DO NOTHING
  `, [msgRows[0].id, assigneeId]);
}
```

- [ ] **Step 3: Verify**

Assign a WO (PATCH) from Jordan to a teammate. The teammate gets:
- An email at their address
- A `chat_mentions` row pointing to a new message in `#maintenance` — confirm by checking `/mentions.html` as that teammate, the assignment shows up.

Re-assign to an external worker — they get the email; no Pulse mention (verify no message inserted).

- [ ] **Step 4: Commit + PR**

```bash
git add propspot-os/routes/maintenance/work-orders.js propspot-os/lib/email.js
git commit -m "maintenance: email + Pulse mention on assignment change"
gh pr create --title "Maintenance: notify on assignment change" \
  --body "Final stage of the external-worker plan. Email always, Pulse mention to team only, both fire-and-forget so the PATCH stays fast."
```

Wait for Railway green, merge.

---

## Verification checklist (end-to-end smoke test)

After all 5 PRs are merged:

- [ ] Open `/maintenance.html` as Jordan. Edit a WO. Assignee picker shows team. Pick a teammate → save → reload → assignee persists, chip shows on card.
- [ ] "Assigned to me" pill filters correctly.
- [ ] Teammate receives email + sees the Pulse mention in `/mentions.html`.
- [ ] Click "+ Invite external worker" → invite a fresh address. Email arrives. Accept-invite → set password → land on `/my-work.html`. See the WO. See property photos. Upload a photo via FieldCam. Photo shows up on team-side FieldCam too.
- [ ] As external user, try `/dashboard.html` → redirected to `/my-work.html`.
- [ ] As external user, flip status to in_progress → completed. Refresh, persists.
- [ ] As Jordan, re-assign the WO from external user back to a teammate. New teammate gets notified. External user no longer sees it in `/my-work.html`.
- [ ] As Jordan, try inviting an existing team-member email → inline error: "This email already belongs to a team member."
