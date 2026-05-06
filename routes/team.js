const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/team ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, email, full_name, created_at,
             (password_hash IS NOT NULL) AS is_active
      FROM users
      ORDER BY full_name, email
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

module.exports = router;
