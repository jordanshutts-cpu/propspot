const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireMaintenanceGrant } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// GET /api/maintenance/assignable-users
//   Every user that can be assigned to a work order:
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
