const express = require('express');
const { query } = require('../db');
const { requireAuth, requireMaintenanceGrant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// POST /api/updates  { work_order_id, body }
router.post('/', async (req, res) => {
  const { work_order_id, body } = req.body;
  if (!work_order_id) return res.status(400).json({ error: 'work_order_id required' });
  if (!body?.trim())  return res.status(400).json({ error: 'body required' });
  try {
    const { rows } = await query(`
      INSERT INTO work_order_updates (work_order_id, user_id, body)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [work_order_id, req.userId, body.trim()]);

    // bump the parent's updated_at so the dashboard sorts correctly
    await query(`UPDATE work_orders SET updated_at = NOW() WHERE id = $1`, [work_order_id]);

    const { rows: u } = await query(
      `SELECT full_name FROM users WHERE id = $1`, [req.userId]
    );
    res.status(201).json({ ...rows[0], author_name: u[0]?.full_name || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post update' });
  }
});

// DELETE /api/updates/:id  (only the author or an owner)
router.delete('/:id', async (req, res) => {
  try {
    const { rows: u } = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
    const isOwner = !!u[0]?.is_owner;
    const ok = await query(
      `DELETE FROM work_order_updates
        WHERE id = $1 AND ($2 = TRUE OR user_id = $3)
        RETURNING id`,
      [req.params.id, isOwner, req.userId]
    );
    if (!ok.rows[0]) return res.status(403).json({ error: 'Not allowed' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete update' });
  }
});

module.exports = router;
