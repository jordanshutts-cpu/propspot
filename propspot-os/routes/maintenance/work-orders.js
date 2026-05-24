const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireMaintenanceGrant } = require('../../middleware/auth');
const { scopedPropertyIds } = require('../../lib/maintenance-scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// GET /api/work-orders
//   ?property_id=<uuid>   filter by property
//   ?status=open|scheduled|in_progress|completed|cancelled|active
//   ?priority=low|normal|high|urgent
router.get('/', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.maintenanceGrant.scope);

    const where = [];
    const params = [];
    let i = 1;

    if (allowedIds !== null) {
      if (!allowedIds.length) return res.json([]);
      params.push(allowedIds);
      where.push(`wo.property_id = ANY($${i++}::uuid[])`);
    }
    if (req.query.property_id) {
      params.push(req.query.property_id);
      where.push(`wo.property_id = $${i++}`);
    }
    if (req.query.status === 'active') {
      where.push(`wo.status IN ('open','scheduled','in_progress')`);
    } else if (req.query.status) {
      params.push(req.query.status);
      where.push(`wo.status = $${i++}`);
    }
    if (req.query.priority) {
      params.push(req.query.priority);
      where.push(`wo.priority = $${i++}`);
    }

    const sql = `
      SELECT wo.*,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
             c.full_name AS assigned_name, c.phone AS assigned_phone, c.email AS assigned_email,
             u.full_name AS reported_by_name,
             (SELECT COUNT(*) FROM work_order_updates WHERE work_order_id = wo.id)::int AS update_count
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id
        LEFT JOIN contacts c ON c.id = wo.assigned_contact_id
        LEFT JOIN users u    ON u.id = wo.reported_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY
         CASE wo.status WHEN 'open' THEN 0 WHEN 'scheduled' THEN 1
                        WHEN 'in_progress' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
         CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                          WHEN 'normal' THEN 2 ELSE 3 END,
         wo.scheduled_for NULLS LAST,
         wo.created_at DESC
    `;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch work orders' });
  }
});

// GET /api/work-orders/:id — full detail + updates
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT wo.*,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
             c.full_name AS assigned_name, c.phone AS assigned_phone, c.email AS assigned_email,
             u.full_name AS reported_by_name
        FROM work_orders wo
        JOIN properties p ON p.id = wo.property_id
        LEFT JOIN contacts c ON c.id = wo.assigned_contact_id
        LEFT JOIN users u    ON u.id = wo.reported_by
       WHERE wo.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Work order not found' });

    const { rows: updates } = await query(`
      SELECT wou.*, u.full_name AS author_name
        FROM work_order_updates wou
        LEFT JOIN users u ON u.id = wou.user_id
       WHERE wou.work_order_id = $1
       ORDER BY wou.created_at ASC
    `, [req.params.id]);

    res.json({ ...rows[0], updates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch work order' });
  }
});

// POST /api/work-orders
router.post('/', async (req, res) => {
  const {
    property_id, title, description, category, priority,
    status, assigned_contact_id, scheduled_for, cost_cents, notes
  } = req.body;
  if (!property_id) return res.status(400).json({ error: 'property_id required' });
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });

  try {
    const { rows } = await query(`
      INSERT INTO work_orders
        (property_id, title, description, category, priority, status,
         assigned_contact_id, reported_by, scheduled_for, cost_cents, notes, created_by)
      VALUES ($1,$2,$3,$4,COALESCE($5,'normal'),COALESCE($6,'open'),$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      property_id, title.trim(),
      description?.trim() || null,
      category?.trim() || null,
      priority || null,
      status || null,
      assigned_contact_id || null,
      req.userId,
      scheduled_for || null,
      cost_cents != null && cost_cents !== '' ? parseInt(cost_cents, 10) : null,
      notes?.trim() || null,
      req.userId
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create work order' });
  }
});

// PATCH /api/work-orders/:id
router.patch('/:id', async (req, res) => {
  const allowed = ['title','description','category','priority','status',
                   'assigned_contact_id','scheduled_for','cost_cents','notes'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(req.body[k] === '' ? null : req.body[k]);
    }
  }
  // If status moved to completed, stamp completed_at automatically.
  if (req.body.status === 'completed') {
    sets.push(`completed_at = COALESCE(completed_at, NOW())`);
  }
  if (req.body.status && req.body.status !== 'completed') {
    sets.push(`completed_at = NULL`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await query(
      `UPDATE work_orders SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Work order not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update work order' });
  }
});

// DELETE /api/work-orders/:id
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM work_orders WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete work order' });
  }
});

module.exports = router;
