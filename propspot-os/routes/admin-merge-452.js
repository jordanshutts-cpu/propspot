/**
 * ONE-TIME admin route: merge 452 Loring (duplicate/prospect) into 451 Loring (correct/renovating).
 * DELETE THIS FILE after the merge is confirmed.
 *
 * Call:  POST /api/admin/merge-452?secret=loring-merge-2026
 */
const express = require('express');
const { pool } = require('../db');
const router = express.Router();

const ONE_TIME_SECRET = 'loring-merge-2026';

const SIMPLE_TABLES = [
  'calendar_events','property_files','prospects','leads','opportunities',
  'purchases','projects','holdings_items','holdings_payments','holdings_documents',
  'folders','photos','share_links','work_orders','lawn_mow_events',
  'inbox_threads','inbox_attachment_saves','uw_deals','uw_audit_log','tasks',
  'drive_folders','drive_files','inkd_envelopes',
];

router.post('/', async (req, res) => {
  if (req.query.secret !== ONE_TIME_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const client = await pool.connect();
  const log = [];

  try {
    const keepRows = await client.query(
      "SELECT id, address_line1, city, state, status FROM properties WHERE address_line1 ILIKE '%451 Loring%' LIMIT 1"
    );
    const discardRows = await client.query(
      "SELECT id, address_line1, city, state, status FROM properties WHERE address_line1 ILIKE '%452 Loring%' LIMIT 1"
    );

    if (!keepRows.rows[0])    return res.status(404).json({ error: 'KEEP property (451 Loring) not found' });
    if (!discardRows.rows[0]) return res.status(404).json({ error: 'DISCARD property (452 Loring) not found' });

    const NEW = keepRows.rows[0].id;
    const OLD = discardRows.rows[0].id;
    const keepInfo    = keepRows.rows[0];
    const discardInfo = discardRows.rows[0];

    if (NEW === OLD) return res.status(400).json({ error: 'same property' });

    log.push(`KEEP    [${NEW}]  ${keepInfo.address_line1}, ${keepInfo.city} (${keepInfo.status})`);
    log.push(`DISCARD [${OLD}]  ${discardInfo.address_line1}, ${discardInfo.city} (${discardInfo.status})`);

    await client.query('BEGIN');

    for (const table of SIMPLE_TABLES) {
      try {
        const { rowCount } = await client.query(
          `UPDATE ${table} SET property_id = $1 WHERE property_id = $2`, [NEW, OLD]
        );
        if (rowCount > 0) log.push(`${table}: ${rowCount} row(s) moved`);
      } catch (e) {
        if (e.code === '42P01') log.push(`${table}: table not found, skipped`);
        else if (e.code === '42703') log.push(`${table}: no property_id column, skipped`);
        else throw e;
      }
    }

    const { rowCount: actRows } = await client.query(
      `UPDATE activity SET entity_id = $1 WHERE entity_type = 'property' AND entity_id = $2`, [NEW, OLD]
    );
    if (actRows > 0) log.push(`activity: ${actRows} row(s) moved`);

    await client.query(`
      INSERT INTO property_contacts (property_id, contact_id, role, created_at)
        SELECT $1, contact_id, role, created_at FROM property_contacts WHERE property_id = $2
        ON CONFLICT DO NOTHING`, [NEW, OLD]);
    await client.query('DELETE FROM property_contacts WHERE property_id = $1', [OLD]);
    log.push('property_contacts: merged');

    await client.query(`
      INSERT INTO property_access (property_id, user_id, granted_by, created_at)
        SELECT $1, user_id, granted_by, created_at FROM property_access WHERE property_id = $2
        ON CONFLICT DO NOTHING`, [NEW, OLD]);
    await client.query('DELETE FROM property_access WHERE property_id = $1', [OLD]);
    log.push('property_access: merged');

    const { rows: lmKeep }    = await client.query('SELECT 1 FROM lawn_maintenance WHERE property_id = $1', [NEW]);
    const { rows: lmDiscard } = await client.query('SELECT 1 FROM lawn_maintenance WHERE property_id = $1', [OLD]);
    if (lmDiscard.length > 0) {
      if (lmKeep.length === 0) {
        await client.query('UPDATE lawn_maintenance SET property_id = $1 WHERE property_id = $2', [NEW, OLD]);
        log.push('lawn_maintenance: moved');
      } else {
        await client.query('DELETE FROM lawn_maintenance WHERE property_id = $1', [OLD]);
        log.push('lawn_maintenance: discard row dropped');
      }
    }

    for (const table of ['pinned_properties', 'recent_properties']) {
      await client.query(`
        INSERT INTO ${table} (user_id, property_id)
          SELECT user_id, $1 FROM ${table} WHERE property_id = $2
          ON CONFLICT DO NOTHING`, [NEW, OLD]);
      await client.query(`DELETE FROM ${table} WHERE property_id = $1`, [OLD]);
      log.push(`${table}: merged`);
    }

    await client.query('DELETE FROM properties WHERE id = $1', [OLD]);
    await client.query('COMMIT');

    log.push(`DONE — ${OLD} deleted, all data now under ${NEW}`);
    res.json({ success: true, kept: NEW, deleted: OLD, log });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin-merge-452] ROLLBACK:', err);
    res.status(500).json({ error: err.message, log });
  } finally {
    client.release();
  }
});

module.exports = router;
