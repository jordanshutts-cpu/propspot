const express = require('express');
const { query } = require('../../db');
const { logFieldChange } = require('../../lib/timesheets-audit');
const { flagsFor } = require('../../lib/timesheets-anomaly');

function requireApprover(req, res, next) {
  const role = req.timesheetsGrant?.role;
  if (role === 'approver' || role === 'admin') return next();
  return res.status(403).json({ error: 'Approver access required' });
}
function requireAdmin(req, res, next) {
  if (req.timesheetsGrant?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Pulse mention helper ──────────────────────────────────────────────
async function postPulseMention(toUserId, fromUserId, text) {
  // Create a 1:1 DM (or reuse existing one for this pair).
  // dm_key is the canonical key for 1:1 dedup — use sorted user IDs joined.
  const dmKey = [fromUserId, toUserId].sort().join('|');
  const { rows: existingDm } = await query(
    `SELECT id FROM chat_dms WHERE dm_key = $1 LIMIT 1`, [dmKey]);
  let dmId = existingDm[0]?.id;
  if (!dmId) {
    const { rows: newDm } = await query(
      `INSERT INTO chat_dms (created_by, dm_key, is_group)
       VALUES ($1, $2, FALSE) RETURNING id`,
      [fromUserId, dmKey]);
    dmId = newDm[0].id;
    await query(
      `INSERT INTO chat_dm_members (dm_id, user_id) VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [dmId, fromUserId, toUserId]);
  }
  await query(
    `INSERT INTO chat_messages (dm_id, sender_id, body)
     VALUES ($1, $2, $3)`,
    [dmId, fromUserId, text]);
}

// ── Factory ──────────────────────────────────────────────────────────────
function createRouter({ skipAuth = false } = {}) {
  const router = express.Router();

  if (!skipAuth) {
    const { requireAuth, requireTimesheetsGrant } = require('../../middleware/auth');
    router.use(requireAuth);
    router.use(requireTimesheetsGrant);
  }

  router.use(requireApprover);

  router.get('/live', async (req, res) => {
    const { rows } = await query(`
      SELECT e.id, e.user_id, e.started_at, e.category, u.full_name
        FROM timesheet_entries e
        JOIN users u ON u.id = e.user_id
       WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
       ORDER BY e.started_at ASC
    `);
    res.json(rows);
  });

  router.get('/pay-periods', async (req, res) => {
    // Anomaly count uses SQL-computable flags only (long_shift, no_tags,
    // auto_closed, manual_entry, edited_after_close). The weekend_off_pattern
    // flag requires per-worker history and is computed in the drill-in.
    const { rows } = await query(`
      SELECT pp.*,
             (SELECT json_agg(json_build_object(
               'user_id', u.id, 'full_name', u.full_name,
               'minutes', COALESCE(t.minutes, 0),
               'statuses', COALESCE(t.statuses, '{}'::jsonb),
               'anomaly_count', COALESCE(t.anomaly_count, 0)))
                FROM users u
                LEFT JOIN (
                  SELECT user_id,
                         SUM(duration_minutes) AS minutes,
                         jsonb_agg(DISTINCT status) AS statuses,
                         COUNT(*) FILTER (
                           WHERE duration_minutes > 720
                              OR (project_id IS NULL AND property_id IS NULL
                                  AND work_order_id IS NULL
                                  AND (category IS NULL OR category = ''))
                              OR auto_closed = TRUE
                              OR source = 'manual'
                              OR (ended_at IS NOT NULL AND updated_at > ended_at)
                         ) AS anomaly_count
                    FROM timesheet_entries
                   WHERE pay_period_id = pp.id AND deleted_at IS NULL
                   GROUP BY user_id
                ) t ON t.user_id = u.id
               WHERE EXISTS (SELECT 1 FROM app_grants ag JOIN apps a ON a.id = ag.app_id
                              WHERE ag.user_id = u.id AND a.slug = 'timesheets')
                  OR u.is_owner = TRUE
             ) AS workers
        FROM timesheet_pay_periods pp
       ORDER BY pp.starts_on DESC
       LIMIT 24
    `);
    res.json(rows);
  });

  router.get('/pay-periods/:id', async (req, res) => {
    const { rows: ppRows } = await query(
      `SELECT * FROM timesheet_pay_periods WHERE id = $1`, [req.params.id]);
    if (!ppRows[0]) return res.status(404).json({ error: 'Not found' });

    const { rows: entries } = await query(`
      SELECT e.*, u.full_name AS user_name
        FROM timesheet_entries e
        JOIN users u ON u.id = e.user_id
       WHERE e.pay_period_id = $1 AND e.deleted_at IS NULL
       ORDER BY u.full_name, e.started_at
    `, [req.params.id]);

    // Worker history for weekend pattern detection: last 30 days of weekday names
    const userIds = [...new Set(entries.map(e => e.user_id))];
    const historyByUser = {};
    for (const uid of userIds) {
      const { rows: h } = await query(`
        SELECT DISTINCT to_char(started_at AT TIME ZONE 'UTC', 'Dy') AS d
          FROM timesheet_entries
         WHERE user_id = $1 AND started_at > NOW() - INTERVAL '30 days'
           AND deleted_at IS NULL
      `, [uid]);
      historyByUser[uid] = h.map(r => r.d);
    }

    const enriched = entries.map(e => ({
      ...e, flags: flagsFor(e, { workerWeekdayHistory: historyByUser[e.user_id] || [] }),
    }));

    res.json({ pay_period: ppRows[0], entries: enriched });
  });

  router.get('/users/:userId/entries', async (req, res) => {
    const { rows } = await query(`
      SELECT e.* FROM timesheet_entries e
       WHERE e.user_id = $1 AND e.deleted_at IS NULL
         ${req.query.pay_period_id ? 'AND e.pay_period_id = $2' : ''}
       ORDER BY e.started_at DESC
    `, req.query.pay_period_id ? [req.params.userId, req.query.pay_period_id]
                                : [req.params.userId]);
    res.json(rows);
  });

  router.post('/pay-periods/:id/workers/:userId/approve', async (req, res) => {
    const { rows: entries } = await query(`
      UPDATE timesheet_entries
         SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE pay_period_id = $2 AND user_id = $3
         AND status IN ('open','submitted') AND deleted_at IS NULL
         AND ended_at IS NOT NULL
       RETURNING id
    `, [req.userId, req.params.id, req.params.userId]);
    for (const e of entries) {
      await logFieldChange({ entryId: e.id, changedBy: req.userId,
                             field: 'status', oldValue: 'open', newValue: 'approved' });
    }
    res.json({ approved_count: entries.length });
  });

  router.post('/pay-periods/:id/workers/:userId/send-back', async (req, res) => {
    if (!req.body.reason) return res.status(400).json({ error: 'reason required' });
    const { rows: entries } = await query(`
      UPDATE timesheet_entries
         SET status = 'open', approved_by = NULL, approved_at = NULL, updated_at = NOW()
       WHERE pay_period_id = $1 AND user_id = $2 AND status = 'approved' AND deleted_at IS NULL
       RETURNING id
    `, [req.params.id, req.params.userId]);
    for (const e of entries) {
      await logFieldChange({ entryId: e.id, changedBy: req.userId,
                             field: 'status', oldValue: 'approved', newValue: 'open',
                             reason: req.body.reason });
    }
    try {
      await postPulseMention(req.params.userId, req.userId,
        `Timesheet for pay period needs corrections: ${req.body.reason}`);
    } catch (err) { console.error('[timesheets] pulse mention failed:', err.message); }
    res.json({ sent_back_count: entries.length });
  });

  router.post('/entries/:id/unlock', requireAdmin, async (req, res) => {
    if (!req.body.reason) return res.status(400).json({ error: 'reason required' });
    const { rows: [existing] } = await query(
      `SELECT status FROM timesheet_entries WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await query(
      `UPDATE timesheet_entries SET status = 'open', approved_by = NULL,
                                    approved_at = NULL, updated_at = NOW()
        WHERE id = $1`, [req.params.id]);
    await logFieldChange({ entryId: req.params.id, changedBy: req.userId,
                           field: 'status', oldValue: existing.status, newValue: 'open',
                           reason: req.body.reason });
    res.json({ ok: true });
  });

  router.get('/pay-periods/:id/csv', async (req, res) => {
    const { rows } = await query(`
      SELECT u.email, u.full_name, e.started_at, e.ended_at, e.duration_minutes,
             e.category, e.status
        FROM timesheet_entries e JOIN users u ON u.id = e.user_id
       WHERE e.pay_period_id = $1 AND e.deleted_at IS NULL
       ORDER BY u.full_name, e.started_at
    `, [req.params.id]);
    const lines = ['email,full_name,started_at,ended_at,minutes,category,status'];
    for (const r of rows) {
      lines.push([r.email, r.full_name, r.started_at?.toISOString() || '',
                  r.ended_at?.toISOString() || '', r.duration_minutes || 0,
                  JSON.stringify(r.category || ''), r.status].join(','));
    }
    res.set('Content-Type', 'text/csv');
    res.send(lines.join('\n'));
  });

  return router;
}

module.exports = createRouter();
module.exports.unsafe = () => createRouter({ skipAuth: true });
