const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireMaintenanceGrant } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// ── GET /api/users ──────────────────────────────────────────────
// Lightweight user list for assignee dropdowns. Returns users who
// have a 'maintenance' app grant OR are owners (owners have implicit
// access to every app). Excludes accounts that haven't accepted
// their invite yet (no password_hash).
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT DISTINCT u.id, u.full_name, u.email, u.is_owner
        FROM users u
        LEFT JOIN app_grants ag ON ag.user_id = u.id
        LEFT JOIN apps a        ON a.id = ag.app_id AND a.slug = 'maintenance'
       WHERE u.password_hash IS NOT NULL
         AND (u.is_owner = TRUE OR a.id IS NOT NULL)
       ORDER BY u.full_name NULLS LAST, u.email
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;
