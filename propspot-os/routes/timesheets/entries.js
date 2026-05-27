const express = require('express');
const { query } = require('../../db');
const { durationMinutes } = require('../../lib/timesheets-duration');
const { logFieldChanges } = require('../../lib/timesheets-audit');

// ── Helpers ─────────────────────────────────────────────────────────────
async function findOpenEntry(userId) {
  const { rows } = await query(`
    SELECT * FROM timesheet_entries
     WHERE user_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
     LIMIT 1
  `, [userId]);
  return rows[0] || null;
}

async function findPayPeriodFor(startedAt) {
  const { rows } = await query(`
    SELECT id FROM timesheet_pay_periods
     WHERE starts_on <= $1::date AND ends_on >= $1::date
     LIMIT 1
  `, [startedAt]);
  return rows[0]?.id || null;
}

async function insertEntry(userId, tags) {
  const payPeriodId = await findPayPeriodFor(new Date());
  const { rows } = await query(`
    INSERT INTO timesheet_entries
      (user_id, pay_period_id, started_at,
       project_id, property_id, work_order_id, category, notes, source)
    VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, 'clock')
    RETURNING *
  `, [userId, payPeriodId,
      tags.project_id || null, tags.property_id || null,
      tags.work_order_id || null, tags.category || null, tags.notes || null]);
  return rows[0];
}

async function closeEntry(entryId) {
  const { rows } = await query(`
    UPDATE timesheet_entries
       SET ended_at = NOW(),
           duration_minutes = EXTRACT(EPOCH FROM (NOW() - started_at))::int / 60,
           updated_at = NOW()
     WHERE id = $1
     RETURNING *
  `, [entryId]);
  return rows[0];
}

// ── Factory ──────────────────────────────────────────────────────────────
function createRouter({ skipAuth = false } = {}) {
  const router = express.Router();

  if (!skipAuth) {
    const { requireAuth, requireTimesheetsGrant } = require('../../middleware/auth');
    router.use(requireAuth);
    router.use(requireTimesheetsGrant);
  }

  // ── Routes ──────────────────────────────────────────────────────────────
  router.post('/clock-in', async (req, res) => {
    const open = await findOpenEntry(req.userId);
    if (open) return res.status(409).json({ error: 'Already clocked in', open });
    const entry = await insertEntry(req.userId, req.body || {});
    res.json(entry);
  });

  router.post('/clock-out', async (req, res) => {
    const open = await findOpenEntry(req.userId);
    if (!open) return res.status(404).json({ error: 'No open entry' });
    const updated = await closeEntry(open.id);
    res.json(updated);
  });

  router.post('/switch', async (req, res) => {
    const open = await findOpenEntry(req.userId);
    if (open) await closeEntry(open.id);
    const entry = await insertEntry(req.userId, req.body || {});
    res.json(entry);
  });

  router.get('/me/current', async (req, res) => {
    res.json(await findOpenEntry(req.userId));
  });

  router.get('/me/entries', async (req, res) => {
    const params = [req.userId];
    let where = `user_id = $1 AND deleted_at IS NULL`;
    if (req.query.pay_period_id) {
      params.push(req.query.pay_period_id);
      where += ` AND pay_period_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT * FROM timesheet_entries WHERE ${where} ORDER BY started_at DESC`,
      params
    );
    res.json(rows);
  });

  router.patch('/entries/:id', async (req, res) => {
    const { rows: [existing] } = await query(
      `SELECT * FROM timesheet_entries WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.userId]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.status === 'approved' || existing.status === 'pushed' ||
        existing.status === 'paid') {
      return res.status(409).json({ error: 'Entry is locked (approved)' });
    }
    const editable = ['started_at','ended_at','project_id','property_id',
                      'work_order_id','category','notes'];
    const patch = {};
    for (const k of editable) if (k in req.body) patch[k] = req.body[k];
    if (Object.keys(patch).length === 0) return res.json(existing);

    const sets = []; const vals = [req.params.id];
    for (const k of Object.keys(patch)) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
    sets.push(`updated_at = NOW()`);
    if (patch.ended_at !== undefined || patch.started_at !== undefined) {
      sets.push(`duration_minutes = CASE WHEN ended_at IS NULL THEN NULL
                                         ELSE EXTRACT(EPOCH FROM (ended_at - started_at))::int / 60 END`);
    }
    const { rows: [updated] } = await query(
      `UPDATE timesheet_entries SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      vals
    );
    await logFieldChanges({
      entryId: existing.id, changedBy: req.userId,
      before: existing, after: updated,
    });
    res.json(updated);
  });

  router.post('/entries', async (req, res) => {
    const { started_at, ended_at } = req.body || {};
    if (!started_at || !ended_at) {
      return res.status(400).json({ error: 'started_at and ended_at required' });
    }
    const payPeriodId = await findPayPeriodFor(started_at);
    const { rows: [entry] } = await query(`
      INSERT INTO timesheet_entries
        (user_id, pay_period_id, started_at, ended_at,
         duration_minutes, project_id, property_id, work_order_id, category, notes, source)
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz,
              EXTRACT(EPOCH FROM ($4::timestamptz - $3::timestamptz))::int / 60,
              $5, $6, $7, $8, $9, 'manual')
      RETURNING *
    `, [req.userId, payPeriodId, started_at, ended_at,
        req.body.project_id || null, req.body.property_id || null,
        req.body.work_order_id || null, req.body.category || null,
        req.body.notes || null]);
    res.json(entry);
  });

  router.delete('/entries/:id', async (req, res) => {
    const { rows: [existing] } = await query(
      `SELECT * FROM timesheet_entries WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.userId]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.status !== 'open' && existing.status !== 'submitted') {
      return res.status(409).json({ error: 'Cannot delete approved entry' });
    }
    await query(`UPDATE timesheet_entries SET deleted_at = NOW() WHERE id = $1`,
                [req.params.id]);
    await logFieldChanges({
      entryId: existing.id, changedBy: req.userId,
      before: { deleted_at: null }, after: { deleted_at: new Date().toISOString() },
    });
    res.json({ ok: true });
  });

  return router;
}

module.exports = createRouter();
module.exports.unsafe = () => createRouter({ skipAuth: true });
