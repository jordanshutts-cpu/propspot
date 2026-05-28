const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { sendInviteToUser } = require('../lib/invites');

const router = express.Router();
router.use(requireAuth);

// GET /api/users — list every user with their app grants summary.
// Removed users (users.removed_at IS NOT NULL) are filtered out so the
// Members page never shows former teammates.
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
       WHERE u.removed_at IS NULL
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

// POST /api/users/:id/remove  (owner only — soft-remove an active member)
// Used when you want to kick someone off the workspace without destroying
// their attribution on past photos / comments / tasks. We:
//   1. Delete every app_grant they hold (immediate loss of access).
//   2. Stamp users.removed_at so they're filtered out of GET /api/users
//      and so the login flow rejects them.
// Reversible by directly clearing removed_at in the DB.
router.post('/:id/remove', requireOwner, async (req, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: 'Cannot remove yourself' });
  }
  try {
    const { rows } = await query(
      `SELECT id, email, full_name, is_owner, removed_at FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    if (rows[0].is_owner) {
      return res.status(400).json({ error: 'Cannot remove another owner. Demote them first.' });
    }
    if (rows[0].removed_at) {
      return res.status(400).json({ error: 'User is already removed' });
    }

    await query('DELETE FROM app_grants WHERE user_id = $1', [req.params.id]);
    await query('UPDATE users SET removed_at = NOW() WHERE id = $1', [req.params.id]);

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: req.params.id,
      action: 'removed', payload: { email: rows[0].email, full_name: rows[0].full_name }
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove user' });
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

// POST /api/users/invite-external  (owner only)
// Single-shot external-worker invite: creates the user, grants the
// selected apps, allow-lists the selected properties, and emails them
// the accept-invite link. Returns the invite link if email isn't wired.
//
// Body: {
//   email:        "vendor@example.com",      // required
//   full_name:    "Jane Vendor",             // required
//   app_ids:      ["uuid", ...],             // required, ≥1
//   property_ids: ["uuid", ...]              // required, ≥1
// }
router.post('/invite-external', requireOwner, async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const fullName = (req.body.full_name || '').trim();
  const appIds = Array.isArray(req.body.app_ids) ? req.body.app_ids : [];
  const propIds = Array.isArray(req.body.property_ids) ? req.body.property_ids : [];

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!fullName) return res.status(400).json({ error: 'full_name required' });
  if (!appIds.length) return res.status(400).json({ error: 'pick at least one app' });
  if (!propIds.length) return res.status(400).json({ error: 'pick at least one property' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Refuse to clobber an existing team account.
    const { rows: existing } = await client.query(
      `SELECT id, user_type, removed_at FROM users WHERE LOWER(email) = $1`,
      [email]
    );
    if (existing[0] && existing[0].user_type === 'team' && !existing[0].removed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'team_member_exists',
        message: 'This email already belongs to an active team member.'
      });
    }

    // Upsert as external worker. Re-inviting a removed user clears removed_at.
    const { rows: userRows } = await client.query(`
      INSERT INTO users (email, full_name, user_type)
      VALUES ($1, $2, 'external_worker')
      ON CONFLICT (email) DO UPDATE
        SET full_name  = EXCLUDED.full_name,
            user_type  = 'external_worker',
            removed_at = NULL
      RETURNING id, email, full_name, user_type
    `, [email, fullName]);
    const user = userRows[0];

    // App grants — replace the user's set with exactly what was picked.
    await client.query(`DELETE FROM app_grants WHERE user_id = $1`, [user.id]);
    if (appIds.length) {
      await client.query(`
        INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
        SELECT $1, id, 'member', '{"all":true}'::jsonb, $2
          FROM apps WHERE id = ANY($3::uuid[])
        ON CONFLICT (user_id, app_id) DO NOTHING
      `, [user.id, req.userId, appIds]);
    }

    // Property access — replace the user's allow-list with exactly what was picked.
    await client.query(`DELETE FROM property_access WHERE user_id = $1`, [user.id]);
    for (const pid of propIds) {
      await client.query(`
        INSERT INTO property_access (property_id, user_id, access_level, granted_by)
        VALUES ($1, $2, 'full', $3)
        ON CONFLICT (property_id, user_id) DO NOTHING
      `, [pid, user.id, req.userId]);
    }

    // Issue + email the invite link (transaction-aware helper).
    const { emailSent, inviteLink } = await sendInviteToUser({
      client, userId: user.id, inviterUserId: req.userId
    });

    await client.query('COMMIT');

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: user.id,
      action: 'external_invited',
      payload: { email, app_count: appIds.length, property_count: propIds.length, email_sent: emailSent }
    });

    res.status(201).json({
      user,
      email_sent: emailSent,
      invite_link: emailSent ? undefined : inviteLink,
      message: emailSent
        ? `Invite sent to ${email}`
        : `No email server configured — share this link manually`
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Invite external error:', err);
    res.status(500).json({ error: 'Failed to invite external user' });
  } finally {
    client.release();
  }
});

// GET /api/users/:id/property-access  (owner only)
// Returns { property_ids: [...] } — every property this user is explicitly
// listed on in property_access. Used by the permissions modal.
router.get('/:id/property-access', requireOwner, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT property_id FROM property_access WHERE user_id = $1`,
      [req.params.id]
    );
    res.json({ property_ids: rows.map(r => r.property_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property access' });
  }
});

// PUT /api/users/:id/property-access  (owner only)
// Atomically replaces this user's property_access rows with the supplied set.
// Body: { property_ids: ["uuid", ...], access_level?: 'full'|'view' }.
// Use `[]` to clear all per-property grants (giving an external user no
// access; for team members this restores them to the default "see everything
// unrestricted" rule).
router.put('/:id/property-access', requireOwner, async (req, res) => {
  const ids = Array.isArray(req.body.property_ids) ? req.body.property_ids : null;
  if (!ids) return res.status(400).json({ error: 'property_ids array required' });
  const level = req.body.access_level === 'view' ? 'view' : 'full';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM property_access
        WHERE user_id = $1
          AND NOT (property_id = ANY($2::uuid[]))`,
      [req.params.id, ids]
    );

    for (const pid of ids) {
      await client.query(`
        INSERT INTO property_access (property_id, user_id, access_level, granted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (property_id, user_id)
          DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by
      `, [pid, req.params.id, level, req.userId]);
    }

    await client.query('COMMIT');

    await logActivity({
      actorUserId: req.userId, entityType: 'user', entityId: req.params.id,
      action: 'property_access_updated',
      payload: { count: ids.length, access_level: level }
    });

    res.json({ property_ids: ids, access_level: level });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Update property access error:', err);
    res.status(500).json({ error: 'Failed to update property access' });
  } finally {
    client.release();
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
