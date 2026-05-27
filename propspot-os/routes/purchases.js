const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { attachCrud } = require('../lib/crud');
const { logActivity } = require('../lib/activity');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

attachCrud(router, {
  table: 'purchases',
  entityType: 'purchase',
  allowedFields: [
    'property_id','opportunity_id','contract_date','expected_close_date',
    'actual_close_date','purchase_price','earnest_money',
    'lender_contact_id','attorney_contact_id',
    'inspection_status','title_status','due_diligence_status','status','notes'
  ]
});

// POST /api/purchases/:id/promote — to project
//   body: { kind: 'flip'|'rental' }
router.post('/:id/promote', async (req, res) => {
  const { kind } = req.body;
  if (!kind || !['flip','rental'].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'flip' or 'rental'" });
  }
  try {
    const { rows: pRows } = await query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (!pRows[0]) return res.status(404).json({ error: 'Purchase not found' });
    const purchase = pRows[0];

    const { rows: prjRows } = await query(`
      INSERT INTO projects
        (property_id, purchase_id, kind, status, created_by)
      VALUES ($1, $2, $3, 'renovating', $4)
      RETURNING *
    `, [purchase.property_id, purchase.id, kind, req.userId]);

    await query(
      `UPDATE purchases SET status = 'promoted', actual_close_date = COALESCE(actual_close_date, NOW()::date), updated_at = NOW() WHERE id = $1`,
      [purchase.id]
    );

    await logActivity({
      actorUserId: req.userId, entityType: 'purchase', entityId: purchase.id,
      action: 'promoted', payload: { project_id: prjRows[0].id, kind }
    });

    const { rows: [actor] } = await query(`SELECT full_name FROM users WHERE id = $1`, [req.userId]);
    const { rows: [prop] }  = await query(`SELECT address_line1 FROM properties WHERE id = $1`, [purchase.property_id]);
    notifyOwners({
      excludeUserId: req.userId, type: 'pipeline_promotion',
      title: `${actor?.full_name || 'Someone'} started a ${kind} project`,
      body: prop?.address_line1 || 'Pipeline updated',
      url: '/projects.html',
      payload: { stage: 'project', project_id: prjRows[0].id, purchase_id: purchase.id, kind }
    });

    res.status(201).json(prjRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to promote purchase' });
  }
});

module.exports = router;
