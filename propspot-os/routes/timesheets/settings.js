const express = require('express');
const router = express.Router();
const { query } = require('../../db');

function requireAdmin(req, res, next) {
  if (req.timesheetsGrant?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

router.get('/settings', async (req, res) => {
  const { rows: [s] } = await query(`SELECT * FROM timesheet_settings WHERE id = 1`);
  res.json({
    category_options: s.category_options,
    weekly_overtime_threshold_min: s.weekly_overtime_threshold_min,
    auto_close_after_hours: s.auto_close_after_hours,
    gusto_connected: !!s.gusto_company_uuid && !!s.gusto_access_encrypted && !s.gusto_disconnected_at,
    gusto_connected_at: s.gusto_connected_at,
    gusto_disconnected_at: s.gusto_disconnected_at,
  });
});

router.patch('/settings', requireAdmin, async (req, res) => {
  const sets = []; const vals = [];
  if (Array.isArray(req.body.category_options)) {
    vals.push(JSON.stringify(req.body.category_options));
    sets.push(`category_options = $${vals.length}::jsonb`);
  }
  if (req.body.weekly_overtime_threshold_min != null) {
    vals.push(req.body.weekly_overtime_threshold_min);
    sets.push(`weekly_overtime_threshold_min = $${vals.length}`);
  }
  if (req.body.auto_close_after_hours != null) {
    vals.push(req.body.auto_close_after_hours);
    sets.push(`auto_close_after_hours = $${vals.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No changes' });
  sets.push(`updated_at = NOW()`);
  await query(`UPDATE timesheet_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
  res.json({ ok: true });
});

router.get('/users', requireAdmin, async (req, res) => {
  const { rows } = await query(`
    SELECT u.id, u.email, u.full_name, ag.role
      FROM users u
      LEFT JOIN app_grants ag ON ag.user_id = u.id
                              AND ag.app_id = (SELECT id FROM apps WHERE slug = 'timesheets')
     WHERE u.user_type = 'team'
     ORDER BY u.full_name
  `);
  res.json(rows);
});

router.put('/users/:userId/role', requireAdmin, async (req, res) => {
  const role = req.body?.role;
  if (!['member','approver','admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be member|approver|admin' });
  }
  await query(`
    INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
    SELECT $1, a.id, $2, '{"all": true}'::jsonb, $3
      FROM apps a WHERE a.slug = 'timesheets'
    ON CONFLICT (user_id, app_id) DO UPDATE SET role = EXCLUDED.role, granted_at = NOW()
  `, [req.params.userId, role, req.userId]);
  res.json({ ok: true });
});

router.delete('/users/:userId/role', requireAdmin, async (req, res) => {
  await query(`
    DELETE FROM app_grants
     WHERE user_id = $1 AND app_id = (SELECT id FROM apps WHERE slug = 'timesheets')
  `, [req.params.userId]);
  res.json({ ok: true });
});

module.exports = router;
