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
// Creates (or refreshes invite for) an external_worker user, grants them
// Maintenance + FieldCam app access, gives them property_access for the
// WO's property, assigns the WO to them, and emails the invite link.
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
      `SELECT id, user_type FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (existing[0] && existing[0].user_type === 'team') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'team_member_exists',
        message: 'This email already belongs to a team member.'
      });
    }

    // Lookup WO + property.
    const { rows: woRows } = await client.query(`
      SELECT wo.id, wo.title, p.id AS property_id,
             p.address_line1, p.city, p.state
        FROM work_orders wo JOIN properties p ON p.id = wo.property_id
       WHERE wo.id = $1
    `, [req.params.id]);
    if (!woRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'work order not found' });
    }
    const wo = woRows[0];

    // Upsert the user as external_worker with a fresh invite token.
    const token = crypto.randomBytes(32).toString('hex');
    const { rows: userRows } = await client.query(`
      INSERT INTO users (email, full_name, user_type, invite_token, invite_expires)
      VALUES ($1, $2, 'external_worker', $3, NOW() + INTERVAL '7 days')
      ON CONFLICT (email) DO UPDATE
        SET full_name      = EXCLUDED.full_name,
            user_type      = 'external_worker',
            invite_token   = EXCLUDED.invite_token,
            invite_expires = EXCLUDED.invite_expires
      RETURNING id, email, full_name, avatar_url, user_type,
                (password_hash IS NOT NULL OR google_sub IS NOT NULL) AS is_active
    `, [email.toLowerCase(), full_name.trim(), token]);
    const user = userRows[0];

    // Grant Maintenance + FieldCam app access (idempotent).
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

    // Assign the WO.
    await client.query(
      `UPDATE work_orders SET assigned_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [user.id, req.params.id]
    );

    await client.query('COMMIT');

    // Build the invite link.
    const appUrl = process.env.APP_URL || 'https://os.propspot.io';
    const inviteLink = `${appUrl}/accept-invite.html?token=${token}`;

    // Fetch inviter name (read-only).
    const { rows: inviterRows } = await query(
      `SELECT full_name FROM users WHERE id = $1`, [req.userId]
    );
    const inviterName = inviterRows[0]?.full_name || 'Your teammate';
    const propertyAddress = [
      wo.address_line1,
      [wo.city, wo.state].filter(Boolean).join(', ')
    ].filter(Boolean).join(', ');

    let emailSent = false;
    try {
      emailSent = await sendExternalWorkerInviteEmail({
        to: email, inviteLink, inviterName,
        propertyAddress, workOrderTitle: wo.title
      });
    } catch (e) { console.error('email send failed', e); }

    try {
      await logActivity({
        actorUserId: req.userId, entityType: 'user', entityId: user.id,
        action: 'external_worker_invited',
        payload: { email, work_order_id: req.params.id }
      });
    } catch (_) { /* activity log failures are non-fatal */ }

    res.status(201).json({
      user,
      inviteLink: emailSent ? undefined : inviteLink,
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
