const express = require('express');
const { query } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { recomputeScopeForUser } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);

// GET /api/apps — registry, with grant counts
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.*,
             COUNT(ag.user_id)::int AS user_count
        FROM apps a
        LEFT JOIN app_grants ag ON ag.app_id = a.id
       GROUP BY a.id
       ORDER BY a.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// POST /api/apps — register a new app (owner only)
router.post('/', requireOwner, async (req, res) => {
  const { slug, name, description, icon, base_url } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
  try {
    const { rows } = await query(
      `INSERT INTO apps (slug, name, description, icon, base_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             icon = EXCLUDED.icon, base_url = EXCLUDED.base_url
       RETURNING *`,
      [slug, name, description || null, icon || null, base_url || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create app' });
  }
});

// GET /api/apps/:id/grants — list users with access to an app
router.get('/:id/grants', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id AS user_id, u.email, u.full_name,
             ag.role, ag.scope, ag.granted_at
        FROM app_grants ag
        JOIN users u ON u.id = ag.user_id
       WHERE ag.app_id = $1
       ORDER BY u.full_name, u.email
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch grants' });
  }
});

// PUT /api/apps/:id/grants/:userId — grant or update
router.put('/:id/grants/:userId', requireOwner, async (req, res) => {
  const { role, scope } = req.body;
  if (!role) return res.status(400).json({ error: 'role required' });
  try {
    const grantScope = scope || { all: true };
    const { rows } = await query(
      `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (user_id, app_id) DO UPDATE
         SET role = EXCLUDED.role, scope = EXCLUDED.scope, granted_at = NOW()
       RETURNING *`,
      [req.params.userId, req.params.id, role, JSON.stringify(grantScope), req.userId]
    );

    // If scope is project_ids-shaped, recompute it from the user's contacts.
    if (grantScope.project_ids !== undefined) {
      await recomputeScopeForUser(req.params.userId);
    }

    await logActivity({
      actorUserId: req.userId, entityType: 'grant', entityId: null,
      action: 'granted', payload: { user_id: req.params.userId, app_id: req.params.id, role }
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to grant access' });
  }
});

// DELETE /api/apps/:id/grants/:userId — revoke
router.delete('/:id/grants/:userId', requireOwner, async (req, res) => {
  try {
    await query(
      `DELETE FROM app_grants WHERE user_id = $1 AND app_id = $2`,
      [req.params.userId, req.params.id]
    );
    await logActivity({
      actorUserId: req.userId, entityType: 'grant', entityId: null,
      action: 'revoked', payload: { user_id: req.params.userId, app_id: req.params.id }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

module.exports = router;
