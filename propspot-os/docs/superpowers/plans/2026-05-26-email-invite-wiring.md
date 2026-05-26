# Email Invite Wiring + Resend Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make team invites actually deliver email (currently silently no-ops because no SMTP provider is configured), and let owners re-send invites to users stuck in "Invited" status without deleting and re-adding them.

**Architecture:** Configure Resend as the SMTP relay so the existing `nodemailer` code in `lib/email.js` works unchanged. Extract a small `sendInviteToUser` helper to `lib/invites.js` and add two owner-only endpoints (`/api/users/:id/resend-invite` and `/api/users/resend-all-pending`) on top of it. Surface both as buttons in `public/team.html`.

**Tech Stack:** Node 18 / Express / Postgres / nodemailer / Resend (SMTP relay) / vanilla JS frontend (no framework, no build step).

**Test note:** This codebase has no automated test suite. Verification is manual via the running app (Railway deploy or the local `preview-server.js`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/invites.js` | Create | `sendInviteToUser({ client, userId, inviterUserId })` — regenerate token, persist, build appsList, send email. One reusable helper. |
| `routes/users.js` | Modify | Add `POST /:id/resend-invite` and `POST /resend-all-pending`. Both owner-only. |
| `public/app.js` | Modify | Add `resendInvite(userId)` and `resendAllPending()` API wrappers. |
| `public/team.html` | Modify | Add per-row "↻ Resend" button + header "↻ Resend all pending (N)" button. |
| `.env.example` | Modify | Update SMTP comment block to point at Resend with the actual values. |
| `docs/operator/resend-setup.md` | Create | Step-by-step setup guide for Jordan (account, DNS, Railway env vars). |

`lib/email.js`, `routes/auth.js`, `accept-invite.html`, and database schema stay untouched — the spec promises zero changes there.

---

## Task 1: Create `lib/invites.js` helper

**Files:**
- Create: `lib/invites.js`

- [ ] **Step 1: Write the helper module**

Create `lib/invites.js` with this exact content:

```javascript
const crypto = require('crypto');
const { sendInviteEmail } = require('./email');

/**
 * Regenerate an invite token for an existing pending user and send the email.
 * Caller must already have verified the user is pending (no password_hash,
 * no google_sub) and is not an owner.
 *
 * @param {object} args
 * @param {object} args.client     pg client (transaction-bound) or pool
 * @param {string} args.userId     id of the user being (re)invited
 * @param {string} args.inviterUserId  id of the owner triggering the resend
 * @returns {Promise<{ emailSent: boolean, inviteLink: string, email: string }>}
 */
async function sendInviteToUser({ client, userId, inviterUserId }) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const { rows: userRows } = await client.query(
    `UPDATE users
        SET invite_token   = $1,
            invite_expires = $2
      WHERE id = $3
      RETURNING id, email, full_name`,
    [token, expires, userId]
  );
  if (!userRows[0]) throw new Error('User not found');
  const user = userRows[0];

  const { rows: inviterRows } = await client.query(
    'SELECT full_name FROM users WHERE id = $1',
    [inviterUserId]
  );
  const inviterName = inviterRows[0]?.full_name || 'Your teammate';

  const { rows: appRows } = await client.query(
    `SELECT a.name
       FROM app_grants ag
       JOIN apps a ON a.id = ag.app_id
      WHERE ag.user_id = $1
      ORDER BY a.name`,
    [userId]
  );
  const appsList = appRows.map(r => r.name);

  const appUrl     = process.env.APP_URL || 'http://localhost:3000';
  const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;

  const emailSent = await sendInviteEmail({
    to: user.email,
    inviteLink,
    inviterName,
    appsList
  });

  return { emailSent, inviteLink, email: user.email };
}

module.exports = { sendInviteToUser };
```

- [ ] **Step 2: Verify the file parses**

Run from `propspot-os/`:
```bash
node -e "require('./lib/invites'); console.log('ok')"
```
Expected output: `ok`. If you get a `MODULE_NOT_FOUND` for `./email`, you're in the wrong directory.

- [ ] **Step 3: Commit**

```bash
git add lib/invites.js
git commit -m "feat(invites): extract sendInviteToUser helper for reuse"
```

---

## Task 2: Add `POST /api/users/:id/resend-invite`

**Files:**
- Modify: `routes/users.js` (add new route between the existing DELETE and PATCH handlers, around line 84)

- [ ] **Step 1: Update imports at top of `routes/users.js`**

Find the top of `routes/users.js`:
```javascript
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
```

Replace with:
```javascript
const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { sendInviteToUser } = require('../lib/invites');
```

- [ ] **Step 2: Add the resend-invite endpoint**

Insert this block AFTER the closing `});` of the DELETE handler (after line 84, before `// PATCH /api/users/:id`):

```javascript
// POST /api/users/:id/resend-invite  (owner only)
// Regenerates the invite token (fresh 48h) and resends the email. Only valid
// for pending users — accepted users and owners are rejected.
router.post('/:id/resend-invite', requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, email,
              (password_hash IS NOT NULL OR google_sub IS NOT NULL) AS is_active,
              is_owner
         FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    if (rows[0].is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User has already accepted' });
    }
    if (rows[0].is_owner) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot resend to an owner' });
    }

    const { emailSent, inviteLink, email } = await sendInviteToUser({
      client, userId: req.params.id, inviterUserId: req.userId
    });

    await client.query('COMMIT');

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: req.params.id,
      action: 'invite_resent', payload: { email, email_sent: emailSent }
    });

    res.json({
      ok: true,
      email_sent: emailSent,
      message: emailSent
        ? `Invite resent to ${email}`
        : `No email configured — share this link manually`,
      invite_link: emailSent ? undefined : inviteLink
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Resend invite error:', err);
    res.status(500).json({ error: 'Failed to resend invite' });
  } finally {
    client.release();
  }
});
```

- [ ] **Step 3: Verify the file parses**

```bash
node -e "require('./routes/users'); console.log('ok')"
```
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add routes/users.js
git commit -m "feat(users): add POST /api/users/:id/resend-invite"
```

---

## Task 3: Add `POST /api/users/resend-all-pending`

**Files:**
- Modify: `routes/users.js` (add another route after the one from Task 2)

- [ ] **Step 1: Add the bulk-resend endpoint**

Insert this block AFTER the closing `});` of the `/:id/resend-invite` handler from Task 2, BEFORE `// PATCH /api/users/:id`:

```javascript
// POST /api/users/resend-all-pending  (owner only)
// Resends invites to every pending non-owner user. Continues on per-user failure
// and reports both successes and failures.
router.post('/resend-all-pending', requireOwner, async (req, res) => {
  try {
    const { rows: pending } = await query(
      `SELECT id, email FROM users
        WHERE password_hash IS NULL
          AND google_sub IS NULL
          AND is_owner = FALSE
        ORDER BY created_at`
    );

    const failed = [];
    let sent = 0;

    for (const u of pending) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await sendInviteToUser({
          client, userId: u.id, inviterUserId: req.userId
        });
        await client.query('COMMIT');

        if (result.emailSent) {
          sent += 1;
          await logActivity({
            actorUserId: req.userId, entityType: 'user', entityId: u.id,
            action: 'invite_resent', payload: { email: u.email, email_sent: true }
          });
        } else {
          failed.push({ email: u.email, reason: 'no email server configured' });
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Resend failed for ${u.email}:`, err.message);
        failed.push({ email: u.email, reason: err.message });
      } finally {
        client.release();
      }
    }

    res.json({ attempted: pending.length, sent, failed });
  } catch (err) {
    console.error('Bulk resend error:', err);
    res.status(500).json({ error: 'Failed to bulk resend invites' });
  }
});
```

- [ ] **Step 2: Verify the file parses**

```bash
node -e "require('./routes/users'); console.log('ok')"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add routes/users.js
git commit -m "feat(users): add POST /api/users/resend-all-pending"
```

---

## Task 4: Add API wrappers in `public/app.js`

**Files:**
- Modify: `public/app.js` (add after the existing `inviteUser` function, around line 496)

- [ ] **Step 1: Locate the insertion point**

Find this block near line 491:
```javascript
async function getUsers() { return apiFetch('/api/users'); }
async function inviteUser(email, fullName, app_grants) {
  return apiFetch('/api/auth/invite', {
    method: 'POST',
    body: JSON.stringify({ email, fullName, app_grants })
  });
}
```

- [ ] **Step 2: Add the two new wrappers immediately after `inviteUser`**

Add these two functions on the lines following the closing `}` of `inviteUser`:

```javascript
async function resendInvite(userId) {
  return apiFetch(`/api/users/${userId}/resend-invite`, { method: 'POST' });
}
async function resendAllPending() {
  return apiFetch('/api/users/resend-all-pending', { method: 'POST' });
}
```

- [ ] **Step 3: Verify the file is still valid JavaScript**

```bash
node -e "new (require('vm').Script)(require('fs').readFileSync('public/app.js','utf8')); console.log('ok')"
```
Expected: `ok`. (This only checks parse, not runtime — sufficient for a syntax check.)

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat(app.js): add resendInvite + resendAllPending wrappers"
```

---

## Task 5: Add per-row "Resend" button in `public/team.html`

**Files:**
- Modify: `public/team.html` (change the `col-actions` cell in `renderUsers`, around line 219-221, and add a `resendOne` function near the existing `uninvite` function, around line 268)

- [ ] **Step 1: Update the col-actions cell**

Find this block (around lines 191 and 219-221):
```javascript
      const canUninvite = me.is_owner && !u.is_active && !u.is_owner && !isYou;
```

Add a `canResend` line right after it:
```javascript
      const canUninvite = me.is_owner && !u.is_active && !u.is_owner && !isYou;
      const canResend   = canUninvite;
```

Then find:
```javascript
          <td class="col-actions">
            ${canUninvite ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:.72rem;" onclick="uninvite('${u.id}','${escHtml(name).replace(/'/g, "\\'")}')" title="Cancel this pending invitation">× Uninvite</button>` : ''}
          </td>
```

Replace with:
```javascript
          <td class="col-actions">
            ${canResend ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:.72rem;margin-right:4px;" onclick="resendOne('${u.id}','${escHtml(u.email).replace(/'/g, "\\'")}')" title="Resend the invitation email">↻ Resend</button>` : ''}
            ${canUninvite ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:.72rem;" onclick="uninvite('${u.id}','${escHtml(name).replace(/'/g, "\\'")}')" title="Cancel this pending invitation">× Uninvite</button>` : ''}
          </td>
```

- [ ] **Step 2: Add the `resendOne` handler**

Find the existing `uninvite` function (around line 259):
```javascript
  // ── Uninvite (cancel a pending invitation) ───────────────────
  async function uninvite(userId, displayName) {
    if (!confirm(`Cancel the invitation for ${displayName}?`)) return;
    try {
      await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
      await reloadUsers();
    } catch (err) {
      alert('Could not uninvite: ' + err.message);
    }
  }
```

Add this new function immediately ABOVE it (above the comment line):

```javascript
  // ── Resend a single pending invite ───────────────────────────
  async function resendOne(userId, email) {
    try {
      const res = await resendInvite(userId);
      if (res.email_sent) {
        showToast(`Invite resent to ${email}`);
      } else {
        showToast(res.message || 'No email server configured', 'error');
        if (res.invite_link) prompt('Manual invite link:', res.invite_link);
      }
    } catch (err) {
      showToast('Could not resend: ' + err.message, 'error');
    }
  }
```

- [ ] **Step 3: Sanity-check the file**

Open `public/team.html` in your editor and confirm:
- The new "↻ Resend" button appears in the JSX-like template string
- The `resendOne` function is defined inside the same `<script>` block as `uninvite`

- [ ] **Step 4: Commit**

```bash
git add public/team.html
git commit -m "feat(team): add per-row Resend button for pending invites"
```

---

## Task 6: Add header "Resend all pending" button

**Files:**
- Modify: `public/team.html` (change the section header around line 81-84, add a `resendAll` function, update `renderUsers` to compute pending count)

- [ ] **Step 1: Replace the section header**

Find this block (around lines 80-84):
```html
<main class="page">
  <div class="section-header">
    <span class="section-title" id="count">Members</span>
    <button class="btn btn-primary btn-sm" onclick="openInvite()">+ Invite</button>
  </div>
```

Replace with:
```html
<main class="page">
  <div class="section-header">
    <span class="section-title" id="count">Members</span>
    <div style="display:flex;gap:8px;align-items:center;">
      <button class="btn btn-secondary btn-sm" id="resend-all-btn" onclick="resendAll()" style="display:none;">↻ Resend all pending</button>
      <button class="btn btn-primary btn-sm" onclick="openInvite()">+ Invite</button>
    </div>
  </div>
```

- [ ] **Step 2: Update `renderUsers` to show/hide the bulk button**

Find the start of `renderUsers` (around line 165):
```javascript
  function renderUsers() {
    const el = document.getElementById('list');
    if (!allUsers.length) { el.innerHTML = '<p class="text-muted text-sm">No team members yet.</p>'; return; }
    if (!allApps.length) { el.innerHTML = '<p class="text-muted text-sm">No apps registered.</p>'; return; }
```

Add these lines immediately after the second early-return:
```javascript
    const pendingCount = allUsers.filter(u => !u.is_active && !u.is_owner).length;
    const bulkBtn = document.getElementById('resend-all-btn');
    if (bulkBtn) {
      if (me.is_owner && pendingCount > 0) {
        bulkBtn.style.display = '';
        bulkBtn.textContent = `↻ Resend all pending (${pendingCount})`;
      } else {
        bulkBtn.style.display = 'none';
      }
    }
```

- [ ] **Step 3: Add the `resendAll` handler**

Add this function immediately ABOVE the `resendOne` function added in Task 5:

```javascript
  // ── Resend all pending invites in one click ──────────────────
  async function resendAll() {
    const pending = allUsers.filter(u => !u.is_active && !u.is_owner);
    if (!pending.length) return;
    if (!confirm(`Resend invite emails to ${pending.length} pending team members?`)) return;
    try {
      const res = await resendAllPending();
      let msg = `Sent ${res.sent} of ${res.attempted} invites`;
      if (res.failed && res.failed.length) {
        msg += ` — failed: ${res.failed.map(f => f.email).join(', ')}`;
        showToast(msg, 'error');
      } else {
        showToast(msg);
      }
      await reloadUsers();
    } catch (err) {
      showToast('Bulk resend failed: ' + err.message, 'error');
    }
  }
```

- [ ] **Step 4: Sanity-check the file**

Open `public/team.html` and confirm:
- Header has both buttons inside a flex container
- `resendAll` is defined alongside `resendOne` and `uninvite`
- `renderUsers` updates `#resend-all-btn` visibility based on pending count

- [ ] **Step 5: Commit**

```bash
git add public/team.html
git commit -m "feat(team): add bulk Resend all pending button"
```

---

## Task 7: Update `.env.example` to document Resend

**Files:**
- Modify: `.env.example` (lines 8-13)

- [ ] **Step 1: Replace the SMTP block**

Find:
```
# ── Email Invites (optional — Gmail example) ────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-gmail-app-password
FROM_EMAIL=Prop Spot <you@gmail.com>
```

Replace with:
```
# ── Email Invites (Resend SMTP — see docs/operator/resend-setup.md) ──
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
FROM_EMAIL=Prop Spot <invites@propspot.io>
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): point SMTP example at Resend"
```

---

## Task 8: Write the operator setup guide

**Files:**
- Create: `docs/operator/resend-setup.md`

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p docs/operator
```

Create `docs/operator/resend-setup.md` with this exact content:

````markdown
# Resend Email Setup (for invites)

This is a one-time setup so PropSpot can send real invitation emails. After this,
the "+ Invite" and "↻ Resend" buttons on the Team page actually deliver email.

**Total time:** ~15 minutes (plus DNS propagation, which is usually under an hour).

## 1. Create a Resend account

1. Go to https://resend.com and sign up with `jordan.shutts@restorationhomes.com`.
2. Verify your email.

## 2. Add propspot.io as a sending domain

1. In the Resend dashboard, click **Domains** → **Add Domain**.
2. Enter: `propspot.io`
3. Region: pick the one closest to Railway's region (US East is the default).
4. Resend shows you a table with 3 DNS records to add. They look like:

| Type | Host | Value | Priority |
|---|---|---|---|
| MX  | send | feedback-smtp.us-east-1.amazonses.com | 10 |
| TXT | send | v=spf1 include:amazonses.com ~all | – |
| TXT | resend._domainkey | p=MIGfMA0GCSq... (long string) | – |

**Leave this page open** — you'll come back to verify after step 3.

## 3. Add the DNS records at your domain registrar

Wherever propspot.io's DNS lives (Cloudflare, Namecheap, GoDaddy, etc.):

1. Log into the DNS provider.
2. Add each of the 3 records exactly as shown in Resend, including the priority for MX.
3. Save.

If you don't know where DNS lives, run this in a terminal to find out:
```bash
dig NS propspot.io +short
```
The result tells you which provider hosts the DNS.

## 4. Verify the domain in Resend

1. Back in the Resend dashboard, click **Verify DNS Records**.
2. If it fails immediately, wait 10-30 minutes and try again — DNS propagation takes time.
3. Once all 3 records show green checks, the domain is verified.

## 5. Create an SMTP API key

1. In Resend, click **API Keys** → **Create API Key**.
2. Name it `propspot-os-railway`.
3. Permission: **Sending access**.
4. Domain: `propspot.io`.
5. Click **Add** and **copy the key immediately** — it starts with `re_` and you can't see it again.

## 6. Set the env vars on Railway

1. Go to railway.app → your project → `propspot-os` service → **Variables** tab.
2. Add (or update) these 5 variables:

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `resend` |
| `SMTP_PASS` | `re_xxxxxxxxxxxxxxxxxxxxxxxxxxxx` (the API key from step 5) |
| `FROM_EMAIL` | `Prop Spot <invites@propspot.io>` |

3. Click **Deploy** (Railway redeploys automatically when env vars change).

## 7. Test

1. Open https://os.propspot.io/team.html.
2. Click **+ Invite**, enter your personal Gmail, leave apps unchecked, send.
3. Check your Gmail (and the spam folder if it's not there in 30 seconds).
4. The email should be from `Prop Spot <invites@propspot.io>` with a green "Accept Invite" button.
5. Once that works, click **↻ Resend all pending** on the Team page to deliver invites to the 8 stuck users.

## Troubleshooting

- **Domain won't verify:** DNS hasn't propagated yet. Wait 30 min and retry. If it still fails after an hour, double-check you copied the values exactly (especially the long DKIM string — no line breaks).
- **Email lands in spam:** Normal for the first few sends from a new domain. After ~10 successful deliveries that aren't marked spam, reputation builds and inbox placement improves.
- **Railway service crashes after env var change:** It shouldn't, but if it does, the logs will show the error. Most likely cause: a typo in `SMTP_PORT` (must be a number).
- **"No email configured" still shows in the invite modal:** The service didn't redeploy. Click "Deploy Latest" in Railway, or push any small change to main.
````

- [ ] **Step 2: Commit**

```bash
git add docs/operator/resend-setup.md
git commit -m "docs(operator): add Resend setup guide for email invites"
```

---

## Task 9: Operator setup (Jordan — non-coding work)

This is the work Jordan has to do himself in the Resend dashboard, his DNS provider, and Railway. The code from tasks 1-6 can be deployed before, during, or after this task — the code degrades gracefully when SMTP isn't configured (returns a manual link instead of sending email).

- [ ] **Step 1: Follow `docs/operator/resend-setup.md` end-to-end**

Steps 1-6 of that doc cover signup, domain verification, API key, and Railway env vars.

- [ ] **Step 2: Confirm env vars are set on Railway**

Railway dashboard → propspot-os → Variables tab. Confirm all 5 are present:
- `SMTP_HOST=smtp.resend.com`
- `SMTP_PORT=587`
- `SMTP_USER=resend`
- `SMTP_PASS=re_...` (the actual API key)
- `FROM_EMAIL=Prop Spot <invites@propspot.io>`

- [ ] **Step 3: Trigger a redeploy**

Either: change any env var and save (Railway redeploys), or push the code commits from tasks 1-8 to `main` (also triggers redeploy).

---

## Task 10: End-to-end verification

- [ ] **Step 1: Send a fresh invite to a test address**

On https://os.propspot.io/team.html:
1. Click **+ Invite**.
2. Use a Gmail you control that's not already a team member.
3. Don't check any apps (we're just testing delivery).
4. Click **Send Invite**.

Expected: success toast, no manual-link box shown in the modal. Email arrives in 30 seconds.

- [ ] **Step 2: Resend a pending invite**

1. Find a row showing "Invited" status.
2. Click the new **↻ Resend** button.
3. Toast shows `Invite resent to <email>`.
4. Check that user's email (you'll need to coordinate with them, or use a row you control).

- [ ] **Step 3: Bulk-resend the 8 pending users**

1. Confirm the header button reads `↻ Resend all pending (8)` (or however many are still pending).
2. Click it. Confirm the dialog. Wait.
3. Toast: `Sent 8 of 8 invites`.
4. Spot-check 2-3 recipients (Slack/text them) to confirm receipt.

- [ ] **Step 4: Accept-flow smoke test**

1. From your test email in Step 1, click the green **Accept Invite** button.
2. You land on `/accept-invite.html?token=...`.
3. Set a password.
4. You're logged in to PropSpot OS.

- [ ] **Step 5: Confirm token regeneration invalidates old links**

If you saved the original invite link from the bulk-resend (before clicking Resend again), open it in a private window. You should see "Invite link is invalid or has expired". This proves resend really did rotate the token.

---

## Spec coverage check

| Spec requirement | Implemented in |
|---|---|
| Resend SMTP, no code changes to `lib/email.js` | Tasks 7, 8, 9 |
| `POST /api/users/:id/resend-invite`, owner-only, pending-only, regenerates token | Task 2 |
| `POST /api/users/resend-all-pending`, owner-only, per-user logging, failure isolation | Task 3 |
| Per-row "↻ Resend" button on Invited rows | Task 5 |
| Header "↻ Resend all pending (N)" button, only when N>0 | Task 6 |
| Confirmation dialog + toast for bulk action | Task 6 (Step 3) |
| Reuses `sendInviteEmail()` and existing token machinery | Task 1 (helper imports `sendInviteEmail`) |
| No changes to `lib/email.js`, `routes/auth.js` invite endpoint, accept-invite page, DB schema | Verified — no tasks touch those files |
| Verification: invite goes out, resend works, accept link works, old links invalidated | Task 10 |
