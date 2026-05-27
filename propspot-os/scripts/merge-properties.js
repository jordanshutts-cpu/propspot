#!/usr/bin/env node
/**
 * merge-properties.js
 *
 * Re-homes every related record from a DISCARD property into a KEEP property,
 * then deletes the discard. Runs inside a single transaction — if anything
 * fails the database is left unchanged.
 *
 * Usage (Railway):
 *   railway run node scripts/merge-properties.js "<keep address>" "<discard address>"
 *   railway run node scripts/merge-properties.js <keep-uuid> <discard-uuid>
 *
 * Example:
 *   railway run node scripts/merge-properties.js "451 Loring" "452 Loring"
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Tables where a plain UPDATE property_id is safe ──────────────────────────
const SIMPLE_TABLES = [
  'calendar_events',
  'property_files',
  'prospects',
  'leads',
  'opportunities',
  'purchases',
  'projects',
  'holdings_items',
  'holdings_payments',
  'holdings_documents',
  'folders',
  'photos',
  'share_links',
  'work_orders',
  'lawn_mow_events',
  'inbox_threads',
  'inbox_attachment_saves',
  'uw_deals',
  'uw_audit_log',
  'tasks',
  'drive_folders',
  'drive_files',
  'inkd_envelopes',
];

async function findProperty(client, arg) {
  // UUID?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
    const { rows } = await client.query('SELECT * FROM properties WHERE id = $1', [arg]);
    return rows[0] || null;
  }
  // Address search
  const { rows } = await client.query(
    `SELECT * FROM properties WHERE address_line1 ILIKE $1 ORDER BY created_at DESC`,
    [`%${arg}%`]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.error(`\n❌ "${arg}" matched ${rows.length} properties — be more specific or use UUID:`);
    rows.forEach(r => console.error(`   ${r.id}  ${r.address_line1}, ${r.city} (${r.status})`));
    process.exit(1);
  }
  return rows[0];
}

async function main() {
  const [,, keepArg, discardArg] = process.argv;

  if (!keepArg || !discardArg) {
    console.error('Usage: node scripts/merge-properties.js "<keep>" "<discard>"');
    console.error('       Arguments can be a UUID or an address fragment.');
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    const keep    = await findProperty(client, keepArg);
    const discard = await findProperty(client, discardArg);

    if (!keep)    { console.error(`❌ Keep property not found: "${keepArg}"`);    process.exit(1); }
    if (!discard) { console.error(`❌ Discard property not found: "${discardArg}"`); process.exit(1); }
    if (keep.id === discard.id) { console.error('❌ Both arguments resolve to the same property.'); process.exit(1); }

    const NEW = keep.id;
    const OLD = discard.id;

    console.log('\n📋 Merge plan');
    console.log('─────────────────────────────────────────────────────────');
    console.log(`  KEEP    [${NEW}]`);
    console.log(`          ${keep.address_line1}, ${keep.city}, ${keep.state}  (${keep.status})`);
    console.log(`  DISCARD [${OLD}]`);
    console.log(`          ${discard.address_line1}, ${discard.city}, ${discard.state}  (${discard.status})`);
    console.log('─────────────────────────────────────────────────────────\n');

    await client.query('BEGIN');

    // ── Simple re-assignments ───────────────────────────────────────────────
    for (const table of SIMPLE_TABLES) {
      try {
        const { rowCount } = await client.query(
          `UPDATE ${table} SET property_id = $1 WHERE property_id = $2`,
          [NEW, OLD]
        );
        if (rowCount > 0) console.log(`  ✓ ${table}: ${rowCount} row(s) moved`);
      } catch (e) {
        // Table might not exist yet in older deploys — skip it
        if (e.code === '42P01') { console.log(`  – ${table}: table not found, skipping`); }
        else throw e;
      }
    }

    // ── activity — uses generic entity_id, not a property_id column ────────
    const { rowCount: actRows } = await client.query(
      `UPDATE activity SET entity_id = $1
        WHERE entity_type = 'property' AND entity_id = $2`,
      [NEW, OLD]
    );
    if (actRows > 0) console.log(`  ✓ activity: ${actRows} row(s) moved`);

    // ── property_contacts — PK (property_id, contact_id, role) ─────────────
    await client.query(`
      INSERT INTO property_contacts (property_id, contact_id, role, created_at)
        SELECT $1, contact_id, role, created_at
          FROM property_contacts WHERE property_id = $2
        ON CONFLICT DO NOTHING
    `, [NEW, OLD]);
    const { rowCount: pcDel } = await client.query(
      `DELETE FROM property_contacts WHERE property_id = $1`, [OLD]
    );
    if (pcDel > 0) console.log(`  ✓ property_contacts: merged`);

    // ── property_access — UNIQUE (property_id, user_id) ────────────────────
    await client.query(`
      INSERT INTO property_access (property_id, user_id, granted_by, created_at)
        SELECT $1, user_id, granted_by, created_at
          FROM property_access WHERE property_id = $2
        ON CONFLICT DO NOTHING
    `, [NEW, OLD]);
    const { rowCount: paDel } = await client.query(
      `DELETE FROM property_access WHERE property_id = $1`, [OLD]
    );
    if (paDel > 0) console.log(`  ✓ property_access: merged`);

    // ── lawn_maintenance — property_id IS the primary key ──────────────────
    const { rows: lmKeep }    = await client.query(
      `SELECT 1 FROM lawn_maintenance WHERE property_id = $1`, [NEW]
    );
    const { rows: lmDiscard } = await client.query(
      `SELECT 1 FROM lawn_maintenance WHERE property_id = $1`, [OLD]
    );
    if (lmDiscard.length > 0) {
      if (lmKeep.length === 0) {
        await client.query(
          `UPDATE lawn_maintenance SET property_id = $1 WHERE property_id = $2`, [NEW, OLD]
        );
        console.log(`  ✓ lawn_maintenance: moved`);
      } else {
        await client.query(`DELETE FROM lawn_maintenance WHERE property_id = $1`, [OLD]);
        console.log(`  ✓ lawn_maintenance: discard row dropped (keep already has one)`);
      }
    }

    // ── pinned_properties / recent_properties — PK (user_id, property_id) ──
    for (const table of ['pinned_properties', 'recent_properties']) {
      await client.query(`
        INSERT INTO ${table} (user_id, property_id)
          SELECT user_id, $1 FROM ${table} WHERE property_id = $2
          ON CONFLICT DO NOTHING
      `, [NEW, OLD]);
      const { rowCount: rDel } = await client.query(
        `DELETE FROM ${table} WHERE property_id = $1`, [OLD]
      );
      if (rDel > 0) console.log(`  ✓ ${table}: merged`);
    }

    // ── Finally: delete the discard property ───────────────────────────────
    await client.query(`DELETE FROM properties WHERE id = $1`, [OLD]);

    await client.query('COMMIT');

    console.log('\n─────────────────────────────────────────────────────────');
    console.log(`🎉 Done!  ${OLD}`);
    console.log(`         ↳ all data now lives under ${NEW}`);
    console.log('─────────────────────────────────────────────────────────\n');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Merge failed — database rolled back to its original state.');
    console.error('   Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
