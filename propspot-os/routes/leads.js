const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { attachCrud } = require('../lib/crud');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);

attachCrud(router, {
  table: 'leads',
  entityType: 'lead',
  allowedFields: [
    'property_id','source','contact_id','motivation_notes','status',
    'previous_prospect_id','notes'
  ]
});

// POST /api/leads/:id/promote — to opportunity
router.post('/:id/promote', async (req, res) => {
  try {
    const { rows: lRows } = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!lRows[0]) return res.status(404).json({ error: 'Lead not found' });
    const lead = lRows[0];

    const { rows: oRows } = await query(`
      INSERT INTO opportunities
        (property_id, lead_id, appointment_at, appointment_type, asking_price, our_offer, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
      RETURNING *
    `, [
      lead.property_id,
      lead.id,
      req.body.appointment_at || null,
      req.body.appointment_type || null,
      req.body.asking_price || null,
      req.body.our_offer || null,
      req.userId
    ]);

    await query(`UPDATE leads SET status = 'promoted', updated_at = NOW() WHERE id = $1`, [lead.id]);

    await logActivity({
      actorUserId: req.userId, entityType: 'lead', entityId: lead.id,
      action: 'promoted', payload: { opportunity_id: oRows[0].id }
    });

    res.status(201).json(oRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to promote lead' });
  }
});

module.exports = router;
