const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// GET /api/pulse/users — list every active user in the org for the DM picker.
// Only returns lightweight display fields. Excludes the caller themselves so
// the picker doesn't let you start a DM with yourself.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, full_name, email, avatar_url
        FROM users
       WHERE id <> $1
         AND password_hash IS NOT NULL
       ORDER BY full_name ASC NULLS LAST, email ASC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

module.exports = router;
