const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { sendInviteToUser } = require('../lib/invites');

const router = express.Router();
router.use(requireAuth);

// GET /api/users — list every user with their app grants summary
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.email, u.full_name, u.is_owner, u.user_type, u.created_at,
             (u.password_hash IS NOT NULL OR u.google_sub IS NOT NULL) AS is_active,
             COALESCE(json_agg(
               json_build_object(
                 'app_id', a.id, 'app_slug', a.slug, 'slug', a.slug,
                 'app_name', a.name, 'role', ag.role, 'scope', ag.scope
               ) ORDER BY a.name
             ) FILTER (WHERE a.id IS NOT NULL), '[]') AS grants
        FROM users u
        LEFT JOIN app_grants ag ON ag.user_id = u.id
        LEFT JOIN apps a        ON a.id = ag.app_id
       GROUP BY u.id
       ORDER BY u.full_name, u.email
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.email, u.full_name, u.is_owner, u.created_at,
             (u.password_hash IS NOT NULL OR u.google_sub IS NOT NULL) AS is_active
        FROM users u WHERE u.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// DELETE /api/users/:id  (owner only — cancel a pending invitation)
// Only allowed while the user is still pending (password_hash IS NULL).
// After they've accepted, full removal requires a different flow.
router.delete('/:id', requireOwner, async (req, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  try {
    const { rows } = await query(
      `SELECT id, email, full_name,
              (password_hash IS NOT NULL OR google_sub IS NOT NULL) AS is_active,
              is_owner
         FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    if (rows[0].is_active) {
      return res.status(400).json({ error: 'User has already accepted; uninvite no longer applies' });
    }
    if (rows[0].is_owner) {
      return res.status(400).json({ error: 'Cannot uninvite an owner' });
    }

    // app_grants cascade via FK ON DELETE CASCADE.
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: req.params.id,
      action: 'invite_revoked', payload: { email: rows[0].email, full_name: rows[0].full_name }
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to uninvite user' });
  }
});

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

// PATCH /api/users/:id  (owner only — change is_owner / full_name / user_type)
router.patch('/:id', requireOwner, async (req, res) => {
  const { full_name, is_owner, user_type } = req.body;
  if (user_type !== undefined && user_type !== 'team' && user_type !== 'external_worker') {
    return res.status(400).json({ error: 'user_type must be "team" or "external_worker"' });
  }
  try {
    const { rows } = await query(
      `UPDATE users
          SET full_name = COALESCE($1, full_name),
              is_owner  = COALESCE($2, is_owner),
              user_type = COALESCE($3, user_type)
        WHERE id = $4
        RETURNING id, email, full_name, is_owner, user_type, created_at`,
      [
        full_name ?? null,
        typeof is_owner === 'boolean' ? is_owner : null,
        user_type ?? null,
        req.params.id
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

module.exports = router;
