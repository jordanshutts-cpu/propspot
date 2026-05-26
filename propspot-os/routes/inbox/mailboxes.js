const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { query } = require('../../db');
const { requireAuth, requireInboxGrant, requireOwner } = require('../../middleware/auth');
const gmail = require('../../lib/gmail');
const { encrypt } = require('../../lib/inbox-crypto');

const router = express.Router();

// OAuth callback is hit unauthenticated by the browser after the user
// completes Google's consent screen. We protect it with a signed state
// token we minted in /connect (carries userId + nonce + iat + kind).
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
  const isPersonal = claims.kind === 'personal-inbox';
  try {
    const { refreshToken, email, displayName, scopes } = await gmail.exchangeCodeForTokens(code);

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
router.post('/:id/resync', requireOwner, async (req, res) => {
  const { rows } = await query(
    `UPDATE inbox_mailboxes
        SET sync_state = '{}'::jsonb, status = 'active', status_reason = NULL
      WHERE id = $1
      RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Mailbox not found' });
  // Kick the worker to pick it up on its next tick.
  res.json({ success: true, queued: true });
});

// DELETE /api/mailboxes/:id — disconnect a mailbox (cascades threads/messages).
router.delete('/:id', requireOwner, async (req, res) => {
  await query(`DELETE FROM inbox_mailboxes WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
