const express = require('express');
const { query } = require('../db');
const { requireAuth, requireHoldingsGrant } = require('../middleware/auth');
const { scopedPropertyIds } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireHoldingsGrant);

// GET /api/properties — list properties the caller can see, with holding counts.
router.get('/', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.holdingsGrant.scope);
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
             (SELECT COUNT(*) FROM holdings WHERE property_id = p.id AND is_active = TRUE)::int AS holding_count,
             (SELECT COUNT(*) FROM holdings WHERE property_id = p.id AND is_active = TRUE
               AND next_due_at < CURRENT_DATE)::int AS overdue_count,
             (SELECT COUNT(*) FROM holdings WHERE property_id = p.id AND is_active = TRUE
               AND next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days')::int AS upcoming_count
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

// GET /api/properties/:id — summary plus all holdings on that property.
router.get('/:id', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.holdingsGrant.scope);
    if (allowedIds !== null && !allowedIds.includes(req.params.id)) {
      return res.status(403).json({ error: 'Not in scope' });
    }
    const { rows } = await query(
      `SELECT id, address_line1, unit, city, state, zip, display_name, status
         FROM properties WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });

    const { rows: holdings } = await query(`
      SELECT h.*,
             c.full_name AS contact_name, c.phone AS contact_phone, c.email AS contact_email
        FROM holdings h
        LEFT JOIN contacts c ON c.id = h.contact_id
       WHERE h.property_id = $1
       ORDER BY h.is_active DESC, h.next_due_at NULLS LAST
    `, [req.params.id]);

    const { rows: contacts } = await query(`
      SELECT c.id, c.full_name, c.email, c.phone, c.type, c.company
        FROM property_contacts pc
        JOIN contacts c ON c.id = pc.contact_id
       WHERE pc.property_id = $1
       ORDER BY c.full_name
    `, [req.params.id]);

    res.json({ ...rows[0], holdings, contacts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

module.exports = router;
