const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { query } = require('../../db');
const { requireAuth, requireInboxGrant, requireOwner } = require('../../middleware/auth');
const gmail = require('../../lib/gmail');
const gcal  = require('../../lib/google-calendar');
const { encrypt, decrypt } = require('../../lib/inbox-crypto');

const router = express.Router();

// OAuth callback is hit unauthenticated by the browser after the user
// completes Google's consent screen. We protect it with a signed state
// token we minted in /connect (carries userId + nonce + iat + kind).
// Three kinds are handled here:
//   inbox-oauth      → admin connecting a shared/team mailbox
//   personal-inbox   → user connecting their own Gmail
//   personal-calendar → user connecting their own Google Calendar
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code or state');
  let claims;
  try {
    claims = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.status(400).send('Invalid or expired state');
  }

  // ── personal-calendar branch ────────────────────────────────────
  if (claims.kind === 'personal-calendar') {
    try {
      const { refreshToken, email } = await gcal.exchangeCodeForTokens(code);
      // Same security check as personal-inbox: caller must connect their
      // own Workspace account, not a coworker's.
      const { rows: u } = await query(
        `SELECT email, google_email FROM users WHERE id = $1`, [claims.userId]
      );
      const ownEmails = [u[0]?.email, u[0]?.google_email].filter(Boolean).map(s => s.toLowerCase());
      if (!ownEmails.includes(email.toLowerCase())) {
        return res.status(403).send(
          `Connect only your own Workspace calendar. You authorized ${email}, ` +
          `but your Prop Spot account is ${u[0]?.email}.`
        );
      }
      await gcal.saveUserCalendarGrant(claims.userId, refreshToken);
      return res.redirect(`/calendar.html?personal_calendar_connected=${encodeURIComponent(email)}`);
    } catch (err) {
      console.error('Calendar OAuth callback error:', err);
      return res.status(500).send(`Failed to connect calendar: ${err.message}`);
    }
  }

  const isPersonal = claims.kind === 'personal-inbox';
  const isReconnect = claims.kind === 'mailbox-reconnect';
  try {
    const { refreshToken, email, displayName, scopes } = await gmail.exchangeCodeForTokens(code);

    // Reconnect flow: the JWT pinned a specific mailbox_id + expected email.
    // If the user picked a different Google account in the picker, refuse
    // — overwriting a different mailbox's token here would corrupt routing.
    if (isReconnect) {
      const { rows: m } = await query(
        `SELECT id, email FROM inbox_mailboxes WHERE id = $1`, [claims.mailboxId]
      );
      if (!m[0]) return res.status(404).send('Mailbox not found');
      if (m[0].email.toLowerCase() !== email.toLowerCase()) {
        return res.status(403).send(
          `Reconnect picked the wrong account. You signed in as ${email}, ` +
          `but this mailbox is ${m[0].email}. Click Reconnect again and choose ${m[0].email}.`
        );
      }
      const encrypted = encrypt(refreshToken);
      await query(
        `UPDATE inbox_mailboxes
            SET refresh_token_encrypted = $1,
                oauth_scopes            = $2,
                connected_by            = $3,
                status                  = 'active',
                status_reason           = NULL,
                sync_state              = '{}'::jsonb
          WHERE id = $4`,
        [encrypted, scopes, claims.userId, claims.mailboxId]
      );
      return res.redirect(`/admin-mailboxes.html?reconnected=${encodeURIComponent(email)}`);
    }

    // For personal mailboxes: lock to the caller's own Workspace email.
    // Without this anyone could connect a coworker's mailbox to themselves.
    if (isPersonal) {
      const { rows: u } = await query(
        `SELECT email, google_email FROM users WHERE id = $1`, [claims.userId]
      );
      const ownEmails = [u[0]?.email, u[0]?.google_email].filter(Boolean).map(s => s.toLowerCase());
      if (!ownEmails.includes(email.toLowerCase())) {
        return res.status(403).send(
          `Connect only your own Workspace email. You signed in as ${email}, ` +
          `but your Prop Spot account is ${u[0]?.email}.`
        );
      }
    }

    const encrypted = encrypt(refreshToken);
    const { rows: mboxRows } = await query(
      `INSERT INTO inbox_mailboxes (provider, email, display_name,
                                    refresh_token_encrypted, oauth_scopes,
                                    connected_by)
       VALUES ('google', $1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
         SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
             oauth_scopes            = EXCLUDED.oauth_scopes,
             connected_by            = EXCLUDED.connected_by,
             status                  = 'active',
             status_reason           = NULL
       RETURNING id`,
      [email, displayName, encrypted, scopes, claims.userId]
    );
    const mailboxId = mboxRows[0].id;
    // Reset sync_state so the worker performs a fresh history bootstrap.
    await query(
      `UPDATE inbox_mailboxes SET sync_state = '{}'::jsonb WHERE id = $1`,
      [mailboxId]
    );

    if (isPersonal) {
      // Find-or-create the user's personal inbox_shared row, then route
      // their own email to it so the sync worker delivers messages there.
      const slug = 'personal-' + claims.userId.replace(/-/g, '').slice(0, 12);
      const displayLabel = displayName ? `${displayName} (Personal)` : 'Personal';
      const { rows: inboxRows } = await query(
        `INSERT INTO inbox_shared (name, slug, description, icon, created_by, owner_user_id)
         VALUES ($1, $2, $3, '📥', $4, $4)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name,
               icon = EXCLUDED.icon,
               owner_user_id = EXCLUDED.owner_user_id
         RETURNING id`,
        [displayLabel, slug, `Personal mailbox for ${email}`, claims.userId]
      );
      const inboxId = inboxRows[0].id;
      await query(
        `INSERT INTO inbox_alias_routes (mailbox_id, alias_email, shared_inbox_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (mailbox_id, alias_email) DO UPDATE
           SET shared_inbox_id = EXCLUDED.shared_inbox_id`,
        [mailboxId, email.toLowerCase(), inboxId]
      );
      return res.redirect(`/inbox.html?personal_connected=${encodeURIComponent(email)}`);
    }

    res.redirect(`/admin-mailboxes.html?connected=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`Failed to connect mailbox: ${err.message}`);
  }
});

// POST /api/mailboxes/personal/connect — start OAuth flow for the caller's
// own personal mailbox. Reachable by any signed-in user, even those without
// an inbox grant (the whole point is to give them one).
router.post('/personal/connect', requireAuth, async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign(
    { userId: req.userId, nonce, kind: 'personal-inbox' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  const url = gmail.buildConsentUrl(state);
  res.json({ url });
});

// Everything below requires an authenticated user with inbox grant.
router.use(requireAuth);
router.use(requireInboxGrant);

// POST /api/mailboxes/connect — start OAuth flow for a shared/team mailbox.
// Owner-only. Returns the consent URL the frontend redirects to.
router.post('/connect', requireOwner, async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign(
    { userId: req.userId, nonce, kind: 'inbox-oauth' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  const url = gmail.buildConsentUrl(state);
  res.json({ url });
});

// POST /api/mailboxes/:id/reconnect — start OAuth flow scoped to an existing
// mailbox. Pre-fills the Google account picker with the mailbox's email
// (login_hint) so the owner doesn't have to hunt through their Google logins.
// Used to refresh a broken token (e.g. after the INBOX_TOKEN_KEY changed
// and the previously-encrypted token is no longer decryptable).
router.post('/:id/reconnect', requireOwner, async (req, res) => {
  const { rows } = await query(
    `SELECT id, email FROM inbox_mailboxes WHERE id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mailbox not found' });
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign(
    { userId: req.userId, nonce, kind: 'mailbox-reconnect', mailboxId: rows[0].id },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  const url = gmail.buildConsentUrl(state, { login_hint: rows[0].email });
  res.json({ url });
});

// GET /api/mailboxes — list connected mailboxes.
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.provider, m.email, m.display_name,
            m.connected_at, m.last_sync_at, m.status, m.status_reason,
            m.sync_state,
            u.full_name AS connected_by_name,
            (SELECT COUNT(*) FROM inbox_alias_routes r WHERE r.mailbox_id = m.id)::int AS alias_count,
            (SELECT COUNT(*) FROM inbox_messages msg
               JOIN inbox_threads t ON t.id = msg.thread_id
              WHERE t.mailbox_id = m.id)::int AS message_count
       FROM inbox_mailboxes m
  LEFT JOIN users u ON u.id = m.connected_by
   ORDER BY m.connected_at DESC`
  );
  res.json(rows);
});

// POST /api/mailboxes/:id/resync — force a sync cycle for this mailbox.
// Owners can resync any mailbox; non-owners can resync the mailboxes
// they themselves connected (their personal mailbox).
router.post('/:id/resync', async (req, res) => {
  // Check ownership: org owner OR the user who connected this mailbox.
  const { rows: meRows } = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
  const isOwner = !!meRows[0]?.is_owner;
  if (!isOwner) {
    const { rows: own } = await query(
      `SELECT 1 FROM inbox_mailboxes WHERE id = $1 AND connected_by = $2`,
      [req.params.id, req.userId]
    );
    if (!own[0]) return res.status(403).json({ error: 'Not your mailbox' });
  }
  const { rows } = await query(
    `UPDATE inbox_mailboxes
        SET sync_state = '{}'::jsonb, status = 'active', status_reason = NULL
      WHERE id = $1
      RETURNING id, email, last_sync_at, status, status_reason`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mailbox not found' });
  res.json({ success: true, queued: true, mailbox: rows[0] });
});

// POST /api/mailboxes/personal/resync — kick a fresh sync on EVERY
// mailbox this user connected. Convenience for the "Refresh inbox"
// button in the personal section.
router.post('/personal/resync', async (req, res) => {
  const { rows } = await query(
    `UPDATE inbox_mailboxes
        SET sync_state = '{}'::jsonb, status = 'active', status_reason = NULL
      WHERE connected_by = $1
      RETURNING id, email, status, last_sync_at`,
    [req.userId]
  );
  res.json({ success: true, count: rows.length, mailboxes: rows });
});

// GET /api/mailboxes/personal/status — visibility for the user's own
// mailboxes. Returns last_sync_at + status so the UI can show
// "synced 2m ago" or surface an error reason.
router.get('/personal/status', async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.email, m.last_sync_at, m.status, m.status_reason,
            i.id   AS inbox_id, i.slug AS inbox_slug, i.name AS inbox_name
       FROM inbox_mailboxes m
  LEFT JOIN inbox_alias_routes r ON r.mailbox_id      = m.id
  LEFT JOIN inbox_shared       i ON i.id              = r.shared_inbox_id
                                AND i.owner_user_id   = $1
      WHERE m.connected_by = $1`,
    [req.userId]
  );
  res.json(rows);
});

// GET /api/mailboxes/health — owner-only diagnostic. Probes every stored
// refresh token via decrypt() to surface mailboxes whose ciphertext can no
// longer be opened, plus a process/key fingerprint so the owner can detect
// whether multiple service instances are reading different INBOX_TOKEN_KEY
// values (a common cause of "decrypts at write, fails at read" symptoms).
router.get('/health', requireOwner, async (req, res) => {
  const crypto = require('crypto');

  // ── Process diagnostics ─────────────────────────────────────────────
  const keyRaw = process.env.INBOX_TOKEN_KEY || '';
  const keyBuf = keyRaw ? Buffer.from(keyRaw, 'base64') : Buffer.alloc(0);
  const keyFingerprint = keyBuf.length
    ? crypto.createHash('sha256').update(keyBuf).digest('hex').slice(0, 16)
    : null;
  const keyHasWhitespace = keyRaw !== keyRaw.trim();
  // Round-trip a freshly-generated string to verify encrypt+decrypt agree
  // *in this process*. If this fails, KEY itself is broken. If it succeeds
  // but stored tokens fail, another process wrote them with a different key.
  let roundtripOk = false;
  let roundtripError = null;
  try {
    const probe = 'roundtrip-' + crypto.randomBytes(8).toString('hex');
    const back  = decrypt(encrypt(probe));
    roundtripOk = (back === probe);
    if (!roundtripOk) roundtripError = 'decrypt returned different value';
  } catch (err) {
    roundtripError = err.message;
  }
  const process_info = {
    pid: process.pid,
    started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    key_fingerprint: keyFingerprint,
    key_byte_length: keyBuf.length,
    key_has_whitespace: keyHasWhitespace,
    roundtrip_ok: roundtripOk,
    roundtrip_error: roundtripError
  };

  // ── Mailbox token probe ─────────────────────────────────────────────
  const { rows } = await query(
    `SELECT m.id, m.email, m.display_name, m.connected_at, m.last_sync_at,
            m.refresh_token_encrypted, m.status, m.status_reason,
            u.full_name AS connected_by_name,
            u.email     AS connected_by_email
       FROM inbox_mailboxes m
  LEFT JOIN users u ON u.id = m.connected_by
   ORDER BY m.connected_at DESC`
  );
  const mailboxes = rows.map(r => {
    let token_ok = false;
    let probe_error = null;
    try {
      decrypt(r.refresh_token_encrypted);
      token_ok = true;
    } catch (err) {
      probe_error = err.message;
    }
    const { refresh_token_encrypted, ...rest } = r;
    return { ...rest, token_ok, probe_error };
  });
  res.json({
    process: process_info,
    total: mailboxes.length,
    healthy: mailboxes.filter(m => m.token_ok).length,
    broken: mailboxes.filter(m => !m.token_ok).length,
    mailboxes
  });
});

// DELETE /api/mailboxes/:id — disconnect a mailbox (cascades threads/messages).
router.delete('/:id', requireOwner, async (req, res) => {
  await query(`DELETE FROM inbox_mailboxes WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
