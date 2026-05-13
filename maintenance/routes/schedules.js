const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin, requireWorkerOrAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Shape returned by GET endpoints. address_line1 is the canonical address
// field; display_name is the optional friendly override Prop Spot uses.
const SELECT_SCHEDULE = `
  SELECT
    s.id, s.property_id, s.cadence, s.custom_days, s.preferred_dow,
    s.next_due_at, s.active, s.default_tasks, s.assigned_to,
    s.created_at, s.updated_at,
    COALESCE(NULLIF(p.display_name, ''), p.address_line1) AS property_name,
    p.address_line1, p.city, p.state, p.zip, p.lat, p.lng,
    p.lockbox_code, p.gate_code, p.access_notes
  FROM maintenance_schedules s
  JOIN properties p ON p.id = s.property_id
`;

// GET /api/schedules
//   admin → every active schedule
//   worker → schedules assigned to them
router.get('/', requireWorkerOrAdmin, async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE s.active = TRUE';
    if (!req.user.is_owner) {
      params.push(req.userId);
      where += ` AND s.assigned_to = $${params.length}`;
    }
    const { rows } = await query(
      `${SELECT_SCHEDULE} ${where} ORDER BY s.next_due_at NULLS LAST, property_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('list schedules:', err);
    res.status(500).json({ error: 'Failed to list schedules' });
  }
});

// GET /api/schedules/:propertyId
router.get('/:propertyId', requireWorkerOrAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `${SELECT_SCHEDULE} WHERE s.property_id = $1`,
      [req.params.propertyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Schedule not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('get schedule:', err);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

// PUT /api/schedules/:propertyId — upsert (admin only).
router.put('/:propertyId', requireAdmin, async (req, res) => {
  const {
    cadence, custom_days, preferred_dow,
    next_due_at, active, default_tasks, assigned_to
  } = req.body;

  if (cadence && !['weekly', 'biweekly', 'monthly', 'custom'].includes(cadence)) {
    return res.status(400).json({ error: 'Invalid cadence' });
  }
  if (cadence === 'custom' && (!custom_days || custom_days < 1)) {
    return res.status(400).json({ error: 'custom_days required when cadence=custom' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO maintenance_schedules
         (property_id, cadence, custom_days, preferred_dow,
          next_due_at, active, default_tasks, assigned_to)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE), COALESCE($7, '[]'::jsonb), $8)
       ON CONFLICT (property_id) DO UPDATE SET
         cadence       = COALESCE(EXCLUDED.cadence,       maintenance_schedules.cadence),
         custom_days   = EXCLUDED.custom_days,
         preferred_dow = EXCLUDED.preferred_dow,
         next_due_at   = COALESCE(EXCLUDED.next_due_at,   maintenance_schedules.next_due_at),
         active        = COALESCE(EXCLUDED.active,        maintenance_schedules.active),
         default_tasks = COALESCE(EXCLUDED.default_tasks, maintenance_schedules.default_tasks),
         assigned_to   = EXCLUDED.assigned_to,
         updated_at    = NOW()
       RETURNING *`,
      [
        req.params.propertyId,
        cadence || 'weekly',
        custom_days || null,
        preferred_dow ?? null,
        next_due_at || null,
        active,
        default_tasks ? JSON.stringify(default_tasks) : null,
        assigned_to || null
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Property not found' });
    console.error('upsert schedule:', err);
    res.status(500).json({ error: 'Failed to save schedule' });
  }
});

module.exports = router;
