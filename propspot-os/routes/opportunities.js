const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { attachCrud } = require('../lib/crud');
const { logActivity } = require('../lib/activity');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

attachCrud(router, {
  table: 'opportunities',
  entityType: 'opportunity',
  allowedFields: [
    'property_id','lead_id','appointment_at','appointment_type',
    'asking_price','our_offer','status','notes'
  ]
});

// POST /api/opportunities/:id/promote — to purchase
router.post('/:id/promote', async (req, res) => {
  try {
    const { rows: oRows } = await query('SELECT * FROM opportunities WHERE id = $1', [req.params.id]);
    if (!oRows[0]) return res.status(404).json({ error: 'Opportunity not found' });
    const opp = oRows[0];

    const { rows: pRows } = await query(`
      INSERT INTO purchases
        (property_id, opportunity_id, contract_date, expected_close_date,
         purchase_price, earnest_money, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'under_contract', $7)
      RETURNING *
    `, [
      opp.property_id,
      opp.id,
      req.body.contract_date || null,
      req.body.expected_close_date || null,
      req.body.purchase_price || opp.our_offer || null,
      req.body.earnest_money || null,
      req.userId
    ]);

    await query(`UPDATE opportunities SET status = 'promoted', updated_at = NOW() WHERE id = $1`, [opp.id]);

    await logActivity({
      actorUserId: req.userId, entityType: 'opportunity', entityId: opp.id,
      action: 'promoted', payload: { purchase_id: pRows[0].id }
    });

    const { rows: [actor] } = await query(`SELECT full_name FROM users WHERE id = $1`, [req.userId]);
    const { rows: [prop] }  = await query(`SELECT address_line1 FROM properties WHERE id = $1`, [opp.property_id]);
    notifyOwners({
      excludeUserId: req.userId, type: 'pipeline_promotion',
      title: `${actor?.full_name || 'Someone'} promoted an opportunity to a purchase`,
      body: prop?.address_line1 || 'Pipeline updated',
      url: '/acquisitions.html',
      payload: { stage: 'purchase', purchase_id: pRows[0].id, opportunity_id: opp.id }
    });

    res.status(201).json(pRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to promote opportunity' });
  }
});

module.exports = router;
