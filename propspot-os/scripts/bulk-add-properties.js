#!/usr/bin/env node
/**
 * One-off: add a batch of properties to Prop Spot.
 *
 * Idempotent: addresses that already exist (by normalized_address)
 * are skipped, not duplicated.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/bulk-add-properties.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const { normalizeAddress, parseFreetextAddress } = require('../lib/address');

const ADDRESSES = [
  '210 Hunters Blind Dr, Columbia, Sc 29212',
  '1611 Holland Street, West Columbia, Sc 29169',
  '3521 Baywater Dr, Columbia, Sc 29209',
  '422 N Magnolia St, Sumter, SC 29150',
  '429 Greenlake Dr, Hopkins, SC 29061',
  '1773 D Ave,West Columbia,Sc,29169',
  '219 S Guignard Drive, Sumter, Sc 29150',
  '379 Curtis Drive, Sumter, Sc 29153',
  '631 1/2 Gibson Road, Lexington, Sc 29072',
  '2516 Flamingo Dr, Columbia, Sc 29209',
  '237 Woodlawn Ave, Sumter, South carolina 29150-3457',
  '112 North Trace Lane, Columbia, Sc 29223',
  '557 Fredonia Rd, Leesville, South carolina 29070',
  '1338 Hornsby Circle, Lugoff, Sc 29078',
  '225 Hickory Forest Drive, Columbia, Sc 29209',
  '535 Batty Way, Sumter, Sc 29154',
  '221 Arbor Falls Dr, Columbia, South carolina 29229-8055',
  '1830 Cupstid Street, Cayce, Sc 29033',
  '2113 Kathleen Dr, Columbia, Sc 29210',
  '2331 Johnstone Street, Newberry, Sc 29108',
  '451 Loring Dr, Sumter, South carolina 29150-4453',
  '659 Stonebury Cir, Blythewood, SC 29016',
  '201 Sandhurst Road, Columbia, Sc 29210',
  '103 Partridge Point, Fountain Inn, Sc 29644',
  '1545 Clarkson Rd, Hopkins, South carolina 29061-9717',
  '145 Gala Drive, Columbia, Sc 29209',
  '442 Robney Drive, Sumter, Sc 29150',
  '518 Laurens Ave, Sumter, Sc 29154',
  '309 Remington Dr, Columbia, Sc 29223',
  '234 Kingnut Dr, Columbia, Sc 29209',
  '31 Pipestove Ct, Irmo, South carolina 29063-7613',
  '4416 Revelstoke Dr, Columbia, SC 29203',
  '186 Stonewood Dr, West Columbia, Sc 29170',
  '1321 Lotus St, Columbia, Sc 29205',
  '105 Midway Dr, Westminster, SC 29693',
  '6417 N Trenholm Road, Columbia, Sc 29206',
  '1225 Charles Town Rd, Leesville, Sc 29070',
  '141 Sulton Johnson Rd, Hopkins, South carolina 29061'
];

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

// Strip "( ... )" off the end and return the annotation separately so it
// can go into notes.
function splitParenthetical(text) {
  const m = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { address: text.trim(), annotation: null };
  return { address: m[1].trim(), annotation: m[2].trim() };
}

(async () => {
  const report = {
    created:      0,
    skipped:      0,
    parse_failed: 0,
    errors:       []
  };

  for (const original of ADDRESSES) {
    try {
      const { address: cleaned } = splitParenthetical(original);
      const parsed = parseFreetextAddress(cleaned);
      if (!parsed.ok) report.parse_failed++;

      const normalized = normalizeAddress(parsed);

      const { rows: existing } = await db.query(
        `SELECT id, address_line1, city FROM properties WHERE normalized_address = $1`,
        [normalized]
      );
      if (existing[0]) {
        console.log(`SKIPPED (already exists)  ${original}  →  ${existing[0].id}`);
        report.skipped++;
        continue;
      }

      const notes = parsed.ok ? null : `[bulk-added] Original: ${original}`;

      const { rows: ins } = await db.query(`
        INSERT INTO properties
          (address_line1, city, state, zip, normalized_address, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [parsed.address_line1, parsed.city, parsed.state, parsed.zip, normalized, notes]);

      console.log(`CREATED ${ins[0].id}  ${parsed.address_line1}, ${parsed.city}, ${parsed.state} ${parsed.zip}`);
      report.created++;
    } catch (err) {
      console.error(`ERROR   ${original}  →  ${err.message}`);
      report.errors.push({ address: original, error: err.message });
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Created:           ${report.created}`);
  console.log(`Skipped (dupes):   ${report.skipped}`);
  console.log(`Parse warnings:    ${report.parse_failed}`);
  console.log(`Errors:            ${report.errors.length}`);
  if (report.errors.length) {
    console.log('\nError details:');
    console.log(JSON.stringify(report.errors, null, 2));
  }
  await db.end();
})();
