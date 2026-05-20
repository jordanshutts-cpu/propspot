const express = require('express');
const { query } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/users — list every user with their app grants summary
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.email, u.full_name, u.is_owner, u.created_at,
             (u.password_hash IS NOT NULL) AS is_active,
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
             (u.password_hash IS NOT NULL) AS is_active
        FROM users u WHERE u.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PATCH /api/users/:id  (owner only — change is_owner / full_name)
router.patch('/:id', requireOwner, async (req, res) => {
  const { full_name, is_owner } = req.body;
  try {
    const { rows } = await query(
      `UPDATE users
          SET full_name = COALESCE($1, full_name),
              is_owner  = COALESCE($2, is_owner)
        WHERE id = $3
        RETURNING id, email, full_name, is_owner, created_at`,
      [full_name ?? null, typeof is_owner === 'boolean' ? is_owner : null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

module.exports = router;
