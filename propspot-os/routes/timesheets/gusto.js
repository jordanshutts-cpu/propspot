const express = require('express');
const router = express.Router();
const crypto = require('node:crypto');
const { query } = require('../../db');
const gusto = require('../../lib/gusto');

function requireAdmin(req, res, next) {
  if (req.timesheetsGrant?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
router.use(requireAdmin);

// Begin OAuth — returns the URL to redirect the browser to.
router.get('/connect', async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('gusto_oauth_state', state, {
    httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000,
  });
  res.json({ url: gusto.oauthAuthorizeUrl(state) });
});

// OAuth callback — Gusto redirects here with ?code=... & state=...
router.get('/callback', async (req, res) => {
  if (!req.query.code) return res.status(400).send('missing code');
  if (req.cookies?.gusto_oauth_state !== req.query.state) {
    return res.status(400).send('bad state');
  }
  res.clearCookie('gusto_oauth_state');
  try {
    const tok = await gusto.exchangeCodeForToken(req.query.code);
    await gusto.saveTokens(tok);
    // Look up company uuid + persist
    const companies = await gusto.listMyCompanies().catch(() => []);
    if (companies[0]?.uuid) {
      await query(`UPDATE timesheet_settings SET gusto_company_uuid = $1 WHERE id = 1`,
                  [companies[0].uuid]);
    }
    res.redirect('/timesheets.html?gusto=connected');
  } catch (err) {
    res.status(500).send('Gusto connect failed: ' + err.message);
  }
});

router.post('/disconnect', async (req, res) => {
  await query(`UPDATE timesheet_settings
                 SET gusto_access_encrypted = NULL, gusto_refresh_encrypted = NULL,
                     gusto_company_uuid = NULL, gusto_disconnected_at = NOW()
                WHERE id = 1`);
  res.json({ ok: true });
});

router.get('/employees', async (req, res) => {
  try {
    const employees = await gusto.listEmployees();
    const emails = employees.map(e => e.email).filter(Boolean);
    const { rows: users } = emails.length
      ? await query(`SELECT id, email, full_name FROM users WHERE email = ANY($1)`, [emails])
      : { rows: [] };
    const byEmail = Object.fromEntries(users.map(u => [u.email.toLowerCase(), u]));
    const { rows: existingLinks } = await query(
      `SELECT user_id, gusto_employee_uuid FROM gusto_employee_links`);
    const linkedByEmp = Object.fromEntries(existingLinks.map(l => [l.gusto_employee_uuid, l.user_id]));
    res.json(employees.map(e => ({
      gusto_employee_uuid: e.uuid,
      email: e.email,
      full_name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      suggested_user: byEmail[e.email?.toLowerCase()] || null,
      linked_user_id: linkedByEmp[e.uuid] || null,
    })));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/links', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'array required' });
  for (const link of req.body) {
    if (!link.user_id || !link.gusto_employee_uuid) continue;
    await query(`
      INSERT INTO gusto_employee_links (user_id, gusto_employee_uuid, gusto_email, linked_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET gusto_employee_uuid = EXCLUDED.gusto_employee_uuid,
                                          gusto_email = EXCLUDED.gusto_email,
                                          linked_by = EXCLUDED.linked_by,
                                          linked_at = NOW()
    `, [link.user_id, link.gusto_employee_uuid, link.gusto_email || null, req.userId]);
  }
  res.json({ ok: true });
});

// Push approved hours for one pay period to Gusto.
router.post('/pay-periods/:id/push', async (req, res) => {
  const { rows: [pp] } = await query(
    `SELECT * FROM timesheet_pay_periods WHERE id = $1`, [req.params.id]);
  if (!pp) return res.status(404).json({ error: 'Pay period not found' });

  const { rows: workers } = await query(`
    SELECT e.user_id, gl.gusto_employee_uuid,
           json_agg(json_build_object(
             'id', e.id,
             'started_at', e.started_at,
             'ended_at',   e.ended_at,
             'duration_minutes', e.duration_minutes)) AS entries
      FROM timesheet_entries e
      JOIN gusto_employee_links gl ON gl.user_id = e.user_id
     WHERE e.pay_period_id = $1 AND e.status = 'approved' AND e.deleted_at IS NULL
     GROUP BY e.user_id, gl.gusto_employee_uuid
  `, [req.params.id]);

  const { splitOvertime } = require('../../lib/timesheets-duration');
  const results = [];
  for (const w of workers) {
    const split = splitOvertime(w.entries, 40 * 60);
    try {
      const ts = await gusto.pushTimeSheet({
        employeeUuid: w.gusto_employee_uuid,
        startDate: pp.starts_on,
        endDate: pp.ends_on,
        regularMinutes: split.regularMinutes,
        overtimeMinutes: split.overtimeMinutes,
      });
      await query(`
        UPDATE timesheet_entries
           SET status = 'pushed', gusto_time_sheet_uuid = $1, updated_at = NOW()
         WHERE pay_period_id = $2 AND user_id = $3 AND status = 'approved'
      `, [ts.uuid, req.params.id, w.user_id]);
      results.push({ user_id: w.user_id, status: 'pushed', uuid: ts.uuid });
    } catch (err) {
      results.push({ user_id: w.user_id, status: 'failed', error: err.message });
    }
  }
  await query(`UPDATE timesheet_pay_periods SET status = 'pushed' WHERE id = $1`,
              [req.params.id]);
  res.json({ results });
});

module.exports = router;
