// Underwriting deals API — uw_deals, uw_snapshots, uw_audit_log

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────────

function flatDiff(oldObj, newObj) {
  // Returns array of { field, old_value, new_value } for top-level key changes.
  // Skips rentalOpEx (nested) — log it as a whole if it changed.
  const changes = [];
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const k of allKeys) {
    const ov = oldObj?.[k];
    const nv = newObj?.[k];
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      changes.push({ field: k, old_value: ov === undefined ? null : ov, new_value: nv === undefined ? null : nv });
    }
  }
  return changes;
}

// ── List deals ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { rows: deals } = await query(`
      SELECT d.*,
             pf.data_json AS pro_forma_data,
             ar.data_json AS actual_results_data,
             COALESCE(ar.updated_at, pf.updated_at, d.created_at) AS last_updated,
             COALESCE(
               CASE WHEN ar.updated_at IS NOT NULL
                         AND (pf.updated_at IS NULL OR ar.updated_at >= pf.updated_at)
                    THEN ar.updated_by
                    ELSE pf.updated_by
               END,
               d.created_by
             ) AS last_updated_by,
             (
               SELECT COALESCE(NULLIF(TRIM(u.full_name), ''), u.email)
                 FROM users u
                WHERE u.id = COALESCE(
                  CASE WHEN ar.updated_at IS NOT NULL
                            AND (pf.updated_at IS NULL OR ar.updated_at >= pf.updated_at)
                       THEN ar.updated_by
                       ELSE pf.updated_by
                  END,
                  d.created_by
                )
             ) AS last_updated_by_name
        FROM uw_deals d
        LEFT JOIN uw_snapshots pf ON pf.deal_id = d.id AND pf.kind = 'initial_pro_forma'
        LEFT JOIN uw_snapshots ar ON ar.deal_id = d.id AND ar.kind = 'actual_results'
       ORDER BY COALESCE(ar.updated_at, pf.updated_at, d.created_at) DESC
    `);
    res.json(deals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list deals' });
  }
});

// ── Create deal ────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { address, city, state, zip, county, sqft, list_price, property_id, initial_data } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });

    const { rows } = await query(`
      INSERT INTO uw_deals (address, city, state, zip, county, sqft, list_price, property_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [address, city || null, state || null, zip || null, county || null,
        sqft || null, list_price || null, property_id || null, req.userId]);

    const deal = rows[0];

    // Seed both snapshots with whatever initial_data was provided (may be empty).
    const seedData = initial_data ? JSON.stringify(initial_data) : '{}';
    await query(`
      INSERT INTO uw_snapshots (deal_id, kind, data_json, updated_by)
      VALUES ($1, 'initial_pro_forma', $2::jsonb, $3),
             ($1, 'actual_results',   $2::jsonb, $3)
      ON CONFLICT (deal_id, kind) DO NOTHING
    `, [deal.id, seedData, req.userId]);

    res.status(201).json(deal);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create deal' });
  }
});

// ── Get single deal ────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { rows: deals } = await query(`
      SELECT d.*,
             pf.data_json AS pro_forma_data,
             ar.data_json AS actual_results_data
        FROM uw_deals d
        LEFT JOIN uw_snapshots pf ON pf.deal_id = d.id AND pf.kind = 'initial_pro_forma'
        LEFT JOIN uw_snapshots ar ON ar.deal_id = d.id AND ar.kind = 'actual_results'
       WHERE d.id = $1
    `, [req.params.id]);

    if (!deals.length) return res.status(404).json({ error: 'Deal not found' });
    res.json(deals[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get deal' });
  }
});

// ── Update deal metadata ───────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['address', 'city', 'state', 'zip', 'county', 'sqft', 'list_price', 'property_id', 'prelim_title_json'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const k of allowed) {
      if (k in req.body) {
        sets.push(`${k} = $${i++}`);
        vals.push(req.body[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    const { rows } = await query(
      `UPDATE uw_deals SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// ── Delete deal ────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM uw_deals WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Deal not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete deal' });
  }
});

// ── Get snapshot ───────────────────────────────────────────────────────────

router.get('/:id/snapshot/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!['initial_pro_forma', 'actual_results'].includes(kind)) {
    return res.status(400).json({ error: 'Invalid snapshot kind' });
  }
  try {
    const { rows } = await query(
      'SELECT * FROM uw_snapshots WHERE deal_id = $1 AND kind = $2',
      [req.params.id, kind]
    );
    if (!rows.length) return res.json({ deal_id: req.params.id, kind, data_json: {} });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get snapshot' });
  }
});

// ── Save (upsert) snapshot + audit ────────────────────────────────────────

router.put('/:id/snapshot/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!['initial_pro_forma', 'actual_results'].includes(kind)) {
    return res.status(400).json({ error: 'Invalid snapshot kind' });
  }
  try {
    const newData = req.body.data || req.body;

    // Fetch the existing snapshot for diffing.
    const { rows: existing } = await query(
      'SELECT data_json FROM uw_snapshots WHERE deal_id = $1 AND kind = $2',
      [req.params.id, kind]
    );
    const oldData = existing[0]?.data_json || {};

    // Upsert the snapshot.
    const { rows } = await query(`
      INSERT INTO uw_snapshots (deal_id, kind, data_json, updated_by, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, NOW())
      ON CONFLICT (deal_id, kind) DO UPDATE
        SET data_json  = EXCLUDED.data_json,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
      RETURNING *
    `, [req.params.id, kind, JSON.stringify(newData), req.userId]);

    // Write audit rows for changed fields.
    const diffs = flatDiff(oldData, newData);
    if (diffs.length) {
      // Batch insert using multiple parameter sets.
      const placeholders = diffs.map((_, idx) => {
        const base = idx * 6;
        return `($${base+1}, $${base+2}, $${base+3}, $${base+4}::jsonb, $${base+5}::jsonb, $${base+6})`;
      }).join(', ');
      const values = diffs.flatMap(d => [
        req.params.id, kind, d.field,
        JSON.stringify(d.old_value), JSON.stringify(d.new_value), req.userId
      ]);
      await query(
        `INSERT INTO uw_audit_log (deal_id, kind, field, old_value, new_value, changed_by)
         VALUES ${placeholders}`,
        values
      );
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save snapshot' });
  }
});

// ── Audit log ──────────────────────────────────────────────────────────────

router.get('/:id/audit', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.*, u.full_name AS changed_by_name
        FROM uw_audit_log a
        LEFT JOIN users u ON u.id = a.changed_by
       WHERE a.deal_id = $1
       ORDER BY a.changed_at DESC
       LIMIT 500
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
