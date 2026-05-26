const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/my-work-orders — WOs assigned to the current user.
//   Returns property fields needed to render the portal without further joins.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wo.id, wo.title, wo.description, wo.category, wo.priority, wo.status,
             wo.scheduled_for, wo.created_at, wo.updated_at,
             wo.property_id,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
             rep.full_name AS reported_by_name,
             (SELECT COUNT(*) FROM work_order_updates WHERE work_order_id = wo.id)::int AS update_count
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id
        LEFT JOIN users rep ON rep.id = wo.reported_by
       WHERE wo.assigned_user_id = $1
       ORDER BY
         CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                          WHEN 'normal' THEN 2 ELSE 3 END,
         wo.scheduled_for NULLS LAST,
         wo.created_at DESC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your work orders' });
  }
});

// GET /api/my-work-orders/:id — single WO + updates + property photos
router.get('/:id', async (req, res) => {
  try {
    const { rows: woRows } = await query(`
      SELECT wo.*,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id
       WHERE wo.id = $1 AND wo.assigned_user_id = $2
    `, [req.params.id, req.userId]);
    if (!woRows[0]) return res.status(404).json({ error: 'not found' });
    const wo = woRows[0];

    const { rows: updates } = await query(`
      SELECT wou.*, u.full_name AS author_name
        FROM work_order_updates wou
        LEFT JOIN users u ON u.id = wou.user_id
       WHERE wou.work_order_id = $1
       ORDER BY wou.created_at ASC
    `, [req.params.id]);

    res.json({ ...wo, updates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load work order' });
  }
});

// PATCH /api/my-work-orders/:id — external worker can only flip status
//   among open / in_progress / completed.
router.patch('/:id', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['open', 'in_progress', 'completed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + allowed.join(', ') });
  }
  try {
    const stamp = status === 'completed' ? 'COALESCE(completed_at, NOW())' : 'NULL';
    const { rows } = await query(`
      UPDATE work_orders
         SET status = $1,
             completed_at = ${stamp},
             updated_at = NOW()
       WHERE id = $2 AND assigned_user_id = $3
       RETURNING id, status, completed_at
    `, [status, req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// POST /api/my-work-orders/:id/updates — external worker posts a thread update
router.post('/:id/updates', async (req, res) => {
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });
  try {
    // Verify WO assignment.
    const { rows: own } = await query(
      `SELECT 1 FROM work_orders WHERE id = $1 AND assigned_user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!own[0]) return res.status(404).json({ error: 'not found' });

    const { rows } = await query(`
      INSERT INTO work_order_updates (work_order_id, user_id, body)
      VALUES ($1, $2, $3) RETURNING *
    `, [req.params.id, req.userId, body.trim()]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post update' });
  }
});

module.exports = router;
