const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireMaintenanceGrant } = require('../../middleware/auth');
const { scopedPropertyIds } = require('../../lib/maintenance-scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// GET /api/properties — list with open work-order counts
router.get('/', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.maintenanceGrant.scope);
    const where = [];
    const params = [];
    let i = 1;
    if (allowedIds !== null) {
      if (!allowedIds.length) return res.json([]);
      params.push(allowedIds);
      where.push(`p.id = ANY($${i++}::uuid[])`);
    }
    const sql = `
      SELECT p.id, p.address_line1, p.unit, p.city, p.state, p.zip,
             p.display_name, p.status,
             (SELECT COUNT(*) FROM work_orders WHERE property_id = p.id
                AND status IN ('open','scheduled','in_progress'))::int AS open_count,
             (SELECT COUNT(*) FROM work_orders WHERE property_id = p.id
                AND priority = 'urgent' AND status IN ('open','scheduled','in_progress'))::int AS urgent_count
        FROM properties p
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.address_line1
    `;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// GET /api/properties/:id — detail with work orders + contacts (for assignment)
router.get('/:id', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.maintenanceGrant.scope);
    if (allowedIds !== null && !allowedIds.includes(req.params.id)) {
      return res.status(403).json({ error: 'Not in scope' });
    }
    const { rows } = await query(
      `SELECT id, address_line1, unit, city, state, zip, display_name, status
         FROM properties WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });

    const { rows: workOrders } = await query(`
      SELECT wo.*, c.full_name AS assigned_name
        FROM work_orders wo
        LEFT JOIN contacts c ON c.id = wo.assigned_contact_id
       WHERE wo.property_id = $1
       ORDER BY
         CASE wo.status WHEN 'open' THEN 0 WHEN 'scheduled' THEN 1
                        WHEN 'in_progress' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
         CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                          WHEN 'normal' THEN 2 ELSE 3 END,
         wo.created_at DESC
    `, [req.params.id]);

    // contacts useful for assignment (contractors + property contacts)
    const { rows: contacts } = await query(`
      SELECT c.id, c.full_name, c.company, c.type, c.phone, c.email
        FROM property_contacts pc
        JOIN contacts c ON c.id = pc.contact_id
       WHERE pc.property_id = $1
       ORDER BY (c.type = 'contractor') DESC, c.full_name
    `, [req.params.id]);

    res.json({ ...rows[0], work_orders: workOrders, contacts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

module.exports = router;
