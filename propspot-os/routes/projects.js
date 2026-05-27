const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { attachCrud } = require('../lib/crud');
const { logActivity } = require('../lib/activity');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth);

attachCrud(router, {
  table: 'projects',
  entityType: 'project',
  allowedFields: [
    'property_id','purchase_id','kind','status',
    'insurance_active','insurance_carrier','utilities_status',
    'taxes_paid_through','mortgage_active','last_mowed_at','last_cleaned_at',
    'list_price','sold_price','monthly_rent','sold_at','rented_at','notes'
  ]
});

// Convenience status transitions
const VALID_PROJECT_STATUSES = ['renovating','listed_for_sale','listed_for_rent','rented','sold'];

router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!VALID_PROJECT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_PROJECT_STATUSES.join(', ')}` });
  }
  try {
    const updates = ['status = $1', 'updated_at = NOW()'];
    const vals = [status];
    if (status === 'sold')   { updates.push(`sold_at   = COALESCE(sold_at,   NOW())`); }
    if (status === 'rented') { updates.push(`rented_at = COALESCE(rented_at, NOW())`); }
    vals.push(req.params.id);

    const { rows } = await query(
      `UPDATE projects SET ${updates.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Project not found' });

    await logActivity({
      actorUserId: req.userId, entityType: 'project', entityId: req.params.id,
      action: 'status_changed', payload: { status }
    });

    // Notify owners on meaningful project transitions (listed/sold/rented)
    if (['sold','rented','listed_for_sale','listed_for_rent'].includes(status)) {
      const { rows: [actor] } = await query(`SELECT full_name FROM users WHERE id = $1`, [req.userId]);
      const { rows: [prop] }  = await query(`SELECT address_line1 FROM properties WHERE id = $1`, [rows[0].property_id]);
      const label = ({
        sold: 'marked a property sold',
        rented: 'marked a property rented',
        listed_for_sale: 'listed a property for sale',
        listed_for_rent: 'listed a property for rent'
      })[status];
      notifyOwners({
        excludeUserId: req.userId, type: 'pipeline_promotion',
        title: `${actor?.full_name || 'Someone'} ${label}`,
        body: prop?.address_line1 || 'Project updated',
        url: '/projects.html',
        payload: { stage: status, project_id: req.params.id }
      });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;
