// scripts/add-prospect-status.js
//
// One-time migration:
//   1) Expand properties_status_check to include 'prospect'.
//   2) Convert every property currently status='purchasing' to status='prospect',
//      EXCEPT 145 Gala and 309 Remington (which remain as 'purchasing').
//
// Safe to re-run: the CHECK swap is idempotent, and the UPDATE is a no-op
// once nothing matches status='purchasing' other than the two kept addresses.
//
// Usage (from propspot-os/):
//   node scripts/add-prospect-status.js

'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const KEEP_PURCHASING_PATTERNS = [
  '145 Gala',
  '309 Remington',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Make sure .env is present in propspot-os/');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ── 1) Update the CHECK constraint ──────────────────────────────────
  console.log('Updating properties_status_check to include "prospect"...');
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_status_check') THEN
        ALTER TABLE properties DROP CONSTRAINT properties_status_check;
      END IF;
      ALTER TABLE properties ADD CONSTRAINT properties_status_check
        CHECK (status IN (
          'prospect','purchasing','renovating','selling','renting','rented','sold','dropped',
          'assigned','listed_for_rent','listed_for_sale','under_contract_buyer'
        ));
    END $$;
  `);
  console.log('  ok\n');

  // ── 2) Show which purchasing properties exist ───────────────────────
  const { rows: before } = await pool.query(`
    SELECT id, address_line1, city, state, zip
      FROM properties
     WHERE status = 'purchasing'
     ORDER BY address_line1
  `);
  console.log(`Found ${before.length} properties currently status='purchasing':`);
  for (const p of before) {
    const kept = KEEP_PURCHASING_PATTERNS.some(pat =>
      (p.address_line1 || '').toLowerCase().includes(pat.toLowerCase())
    );
    console.log(`  ${kept ? 'KEEP   ' : 'CONVERT'}  ${p.address_line1}, ${p.city}, ${p.state}`);
  }
  console.log('');

  // ── 3) Convert everything except the kept addresses ─────────────────
  const ilikeClauses = KEEP_PURCHASING_PATTERNS.map((_, i) => `address_line1 ILIKE $${i + 1}`).join(' OR ');
  const params = KEEP_PURCHASING_PATTERNS.map(p => `%${p}%`);
  const { rowCount } = await pool.query(`
    UPDATE properties
       SET status = 'prospect',
           updated_at = NOW()
     WHERE status = 'purchasing'
       AND NOT (${ilikeClauses})
  `, params);
  console.log(`Converted ${rowCount} properties from 'purchasing' → 'prospect'`);

  // ── 4) Final counts ─────────────────────────────────────────────────
  const { rows: after } = await pool.query(`
    SELECT status, COUNT(*)::int AS n
      FROM properties
     WHERE status IN ('prospect','purchasing')
     GROUP BY status
     ORDER BY status
  `);
  console.log('\nFinal counts:');
  for (const r of after) console.log(`  ${r.status.padEnd(12)} ${r.n}`);

  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
