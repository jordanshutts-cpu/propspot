const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { attachCrud } = require('../lib/crud');
const { logActivity } = require('../lib/activity');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

attachCrud(router, {
  table: 'prospects',
  entityType: 'prospect',
  allowedFields: [
    'property_id','source','channels','raw_name','raw_phone','raw_email',
    'raw_meta','status','campaign_id','notes'
  ]
});

// POST /api/prospects/:id/promote — promote prospect to lead
router.post('/:id/promote', async (req, res) => {
  try {
    const { rows: pRows } = await query('SELECT * FROM prospects WHERE id = $1', [req.params.id]);
    if (!pRows[0]) return res.status(404).json({ error: 'Prospect not found' });
    const prospect = pRows[0];

    let contactId = req.body.contact_id || null;

    // If no contact provided but prospect has raw contact info, create a seller contact.
    if (!contactId && (prospect.raw_name || prospect.raw_email || prospect.raw_phone)) {
      const { rows: cRows } = await query(`
        INSERT INTO contacts (type, full_name, email, phone, created_by)
        VALUES ('seller', $1, $2, $3, $4) RETURNING id
      `, [
        prospect.raw_name || 'Unknown seller',
        prospect.raw_email,
        prospect.raw_phone,
        req.userId
      ]);
      contactId = cRows[0].id;

      await query(`
        INSERT INTO property_contacts (property_id, contact_id, role, is_primary)
        VALUES ($1, $2, 'seller', TRUE)
        ON CONFLICT DO NOTHING
      `, [prospect.property_id, contactId]);
    }

    const { rows: leadRows } = await query(`
      INSERT INTO leads (property_id, source, contact_id, motivation_notes,
                         status, previous_prospect_id, created_by)
      VALUES ($1, 'prospect_response', $2, $3, 'new', $4, $5)
      RETURNING *
    `, [
      prospect.property_id,
      contactId,
      req.body.motivation_notes || null,
      prospect.id,
      req.userId
    ]);

    await query(`UPDATE prospects SET status = 'promoted', updated_at = NOW() WHERE id = $1`, [prospect.id]);

    await logActivity({
      actorUserId: req.userId, entityType: 'prospect', entityId: prospect.id,
      action: 'promoted', payload: { lead_id: leadRows[0].id }
    });

    const { rows: [actor] } = await query(`SELECT full_name FROM users WHERE id = $1`, [req.userId]);
    const { rows: [prop] }  = await query(`SELECT address_line1 FROM properties WHERE id = $1`, [prospect.property_id]);
    notifyOwners({
      excludeUserId: req.userId, type: 'pipeline_promotion',
      title: `${actor?.full_name || 'Someone'} promoted a prospect to a lead`,
      body: prop?.address_line1 || 'Pipeline updated',
      url: '/acquisitions.html',
      payload: { stage: 'lead', lead_id: leadRows[0].id, prospect_id: prospect.id }
    });

    res.status(201).json(leadRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to promote prospect' });
  }
});

module.exports = router;
