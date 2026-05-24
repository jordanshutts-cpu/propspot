const express = require('express');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Helper: check if the requesting user is an admin
async function isAdmin(userId) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [userId]);
  return rows[0]?.role === 'admin';
}

// ── GET /api/access/:propertyId ─────────────────────────────────
// Returns { restricted: bool, access: [{user_id, full_name, email, access_level}] }
router.get('/:propertyId', async (req, res) => {
  try {
    const { rows: accessRows } = await query(`
      SELECT pa.user_id, pa.access_level, u.full_name, u.email
      FROM property_access pa
      JOIN users u ON u.id = pa.user_id
      WHERE pa.property_id = $1
      ORDER BY u.full_name ASC
    `, [req.params.propertyId]);

    res.json({
      restricted: accessRows.length > 0,
      access: accessRows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch access data' });
  }
});

// ── POST /api/access/:propertyId ────────────────────────────────
// Grant or update access; body: { userId, accessLevel: 'full'|'view' }; admin only
router.post('/:propertyId', async (req, res) => {
  if (!(await isAdmin(req.userId))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { userId, accessLevel } = req.body;
  if (!userId || !accessLevel) {
    return res.status(400).json({ error: 'userId and accessLevel are required' });
  }
  if (!['full', 'view'].includes(accessLevel)) {
    return res.status(400).json({ error: 'accessLevel must be full or view' });
  }

  try {
    const { rows } = await query(`
      INSERT INTO property_access (property_id, user_id, access_level, granted_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (property_id, user_id)
      DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by
      RETURNING *
    `, [req.params.propertyId, userId, accessLevel, req.userId]);

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to grant access' });
  }
});

// ── DELETE /api/access/:propertyId/:userId ──────────────────────
// Revoke access; admin only
router.delete('/:propertyId/:userId', async (req, res) => {
  if (!(await isAdmin(req.userId))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    await query(
      'DELETE FROM property_access WHERE property_id = $1 AND user_id = $2',
      [req.params.propertyId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

// ── PATCH /api/access/users/:userId/role ────────────────────────
// Change global role ('admin'|'member'|'viewer'); admin only, can't change self
router.patch('/users/:userId/role', async (req, res) => {
  if (!(await isAdmin(req.userId))) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (req.params.userId === req.userId) {
    return res.status(400).json({ error: 'You cannot change your own role' });
  }

  const { role } = req.body;
  if (!['admin', 'member', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, member, or viewer' });
  }

  try {
    const { rows } = await query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, full_name, role',
      [role, req.params.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

module.exports = router;
