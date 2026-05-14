const express = require('express');
const { query } = require('../db');
const { requireAuth, requireHoldingsGrant } = require('../middleware/auth');
const { scopedPropertyIds } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireHoldingsGrant);

// GET /api/holdings — list across all (scoped) properties
//   ?property_id=<uuid>   limit to one property
//   ?status=overdue|upcoming|active|inactive
router.get('/', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.holdingsGrant.scope);

    const where = [];
    const params = [];
    let i = 1;

    if (allowedIds !== null) {
      if (!allowedIds.length) return res.json([]);
      params.push(allowedIds);
      where.push(`h.property_id = ANY($${i++}::uuid[])`);
    }

    if (req.query.property_id) {
      params.push(req.query.property_id);
      where.push(`h.property_id = $${i++}`);
    }

    if (req.query.status === 'inactive') where.push('h.is_active = FALSE');
    else                                 where.push('h.is_active = TRUE');

    if (req.query.status === 'overdue')  where.push("h.next_due_at < CURRENT_DATE");
    if (req.query.status === 'upcoming') where.push("h.next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'");

    const sql = `
      SELECT h.*,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
             c.full_name AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
             (SELECT MAX(paid_on) FROM holding_payments WHERE holding_id = h.id) AS last_payment_on
        FROM holdings h
        JOIN properties p ON p.id = h.property_id
        LEFT JOIN contacts c ON c.id = h.contact_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY h.next_due_at NULLS LAST, p.address_line1
    `;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// GET /api/holdings/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT h.*,
             p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name,
             c.full_name AS contact_name, c.phone AS contact_phone, c.email AS contact_email
        FROM holdings h
        JOIN properties p ON p.id = h.property_id
        LEFT JOIN contacts c ON c.id = h.contact_id
       WHERE h.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Holding not found' });

    const payments = await query(
      `SELECT hp.*, u.full_name AS recorded_by_name
         FROM holding_payments hp
         LEFT JOIN users u ON u.id = hp.recorded_by
        WHERE hp.holding_id = $1
        ORDER BY hp.paid_on DESC`,
      [req.params.id]
    );

    res.json({ ...rows[0], payments: payments.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holding' });
  }
});

// POST /api/holdings
router.post('/', async (req, res) => {
  const {
    property_id, kind, label, vendor, account_no, contact_id,
    amount_cents, cadence, due_day, next_due_at, auto_pay, notes
  } = req.body;
  if (!property_id) return res.status(400).json({ error: 'property_id required' });
  if (!kind)        return res.status(400).json({ error: 'kind required' });
  if (!label?.trim()) return res.status(400).json({ error: 'label required' });

  try {
    const { rows } = await query(`
      INSERT INTO holdings
        (property_id, kind, label, vendor, account_no, contact_id,
         amount_cents, cadence, due_day, next_due_at, auto_pay, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'monthly'),$9,$10,COALESCE($11,FALSE),$12,$13)
      RETURNING *
    `, [
      property_id, kind, label.trim(),
      vendor?.trim() || null,
      account_no?.trim() || null,
      contact_id || null,
      amount_cents != null ? parseInt(amount_cents, 10) : null,
      cadence || null,
      due_day != null && due_day !== '' ? parseInt(due_day, 10) : null,
      next_due_at || null,
      auto_pay === true || auto_pay === 'true',
      notes?.trim() || null,
      req.userId
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create holding' });
  }
});

// PATCH /api/holdings/:id
router.patch('/:id', async (req, res) => {
  const allowed = [
    'kind','label','vendor','account_no','contact_id','amount_cents',
    'cadence','due_day','next_due_at','last_paid_at','is_active','auto_pay','notes'
  ];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(req.body[k] === '' ? null : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await query(
      `UPDATE holdings SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Holding not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update holding' });
  }
});

// DELETE /api/holdings/:id
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM holdings WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

module.exports = router;
