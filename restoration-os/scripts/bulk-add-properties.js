#!/usr/bin/env node
/**
 * One-off: add a batch of properties to Prop Spot, and ensure a named
 * user has the `fieldcam` grant.
 *
 * Idempotent: addresses that already exist (by normalized_address)
 * are linked, not duplicated.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/bulk-add-properties.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const { normalizeAddress, parseFreetextAddress } = require('../lib/address');

const ADDRESSES = [
  '62 Thunder Ridge Rd., Acworth, GA 30101',
  '85 Thunder Ridge, Acworth, GA 30101',
  '4816 Helga Way, Woodstock, GA 30188',
  '6302 Woodlore, Acworth, GA 30101',
  '2715 Windsor Court, Kennesaw, GA 30144',
  '45 Hunt Creek, Acworth, GA 30101',
  '2702 Kaley, Kennesaw, GA 30152',
  '733 Flagstone Way, Acworth, GA 30101',
  '53 Ryans Pt, Dallas, GA 30152',
  '233 Hunt Creek, Acworth, GA 30101',
  '4857 Helga Way, Woodstock, GA 30188',
  '4334 Walforde Blvd, Acworth, GA 30101',
  '1776 Brookstone Place NW, Acworth, GA 30101',
  '4319 Clairesbrook LN, Acworth, GA 30101',
  '5538 Hurstcliffe Drive, Kennesaw, GA 30152',
  '607 Gregory Manor, Smyrna, GA 30082',
  '1045 Maris Ln., McDonough, GA 30253',
  '218 Drooping Leaf Ln, Lexington, SC 29072',
  '104 River Creek Dr, Irmo, SC 29063 (POOL)',
  '172 Berry Dr, West Columbia, SC 29170',
  '113 Double Eagle Cir, Lexington, Sc, 29073',
  '129 Crassula Dr, Lexington, Sc, 29073',
  '634 Pine Lilly Dr, Columbia, SC, 29229',
  '435 Regency Park Drive, Columbia, SC, 29210',
  '468 Regency Park Drive, Columbia, SC, 29210',
  '140 Duchess Trail, Lexington, SC, 29073',
  '156 Lanier Ave, West Columbia, SC 29170',
  '1611 Holland Street, West Columbia, Sc 29169',
  '3521 Baywater Dr, Columbia, Sc 29209',
  '422 N Magnolia St, Sumter, SC 29150',
  '429 Greenlake Dr, Hopkins, SC 29061',
  '433 Cape Jasmine Way, Lexington, SC 29073',
  '210 Hunters Blind Dr, Columbia, Sc 29212',
  '1773 D Ave,West Columbia,Sc,29169',
  '219 S Guignard Drive, Sumter, Sc 29150',
  '379 Curtis Drive, Sumter, Sc 29153',
  '631 1/2 Gibson Road, Lexington, Sc 29072',
  "300 East O'neal Street, Gaffney, Sc 29340",
  '250 Keystone Dr, Hopkins, SC 29061',
  '237 Woodlawn Ave, Sumter, South carolina 29150-3457',
  '2331 Johnstone Street, Newberry, Sc 29108',
  '2516 Flamingo Dr, Columbia, Sc 29209',
  '451 Loring Dr, Sumter, South carolina 29150-4453'
];

const FIELDCAM_USER_NAME = 'Jen';

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
    properties: { created: 0, linked: 0, parse_failed: 0, errors: [] },
    grants:     { user_id: null, full_name: null, status: null }
  };

  for (const original of ADDRESSES) {
    try {
      // Strip any trailing parenthetical like "(POOL)" — these are field
      // notes the team scribbled, not part of the canonical address.
      const { address: cleaned } = splitParenthetical(original);
      const parsed = parseFreetextAddress(cleaned);
      if (!parsed.ok) report.properties.parse_failed++;

      const normalized = normalizeAddress(parsed);

      const { rows: existing } = await db.query(
        `SELECT id, address_line1, city FROM properties WHERE normalized_address = $1`,
        [normalized]
      );
      if (existing[0]) {
        console.log(`LINKED  ${original}  →  ${existing[0].id}`);
        report.properties.linked++;
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
      report.properties.created++;
    } catch (err) {
      console.error(`ERROR   ${original}  →  ${err.message}`);
      report.properties.errors.push({ address: original, error: err.message });
    }
  }

  // Ensure user Jen has the fieldcam grant.
  try {
    const { rows: candidates } = await db.query(
      `SELECT id, email, full_name FROM users
        WHERE full_name ILIKE $1 OR email ILIKE $2
        ORDER BY created_at`,
      [`${FIELDCAM_USER_NAME}%`, `${FIELDCAM_USER_NAME.toLowerCase()}%`]
    );
    if (!candidates.length) {
      report.grants.status = `no user matching "${FIELDCAM_USER_NAME}*" — create the user first`;
    } else if (candidates.length > 1) {
      report.grants.status = `multiple users match "${FIELDCAM_USER_NAME}*": ${candidates.map(c => `${c.full_name} <${c.email}>`).join(', ')} — script skipped grant; specify which one`;
    } else {
      const u = candidates[0];
      report.grants.user_id   = u.id;
      report.grants.full_name = u.full_name;

      const { rows: app } = await db.query(`SELECT id FROM apps WHERE slug = 'fieldcam'`);
      if (!app[0]) {
        report.grants.status = 'no `fieldcam` app row found';
      } else {
        await db.query(`
          INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
          VALUES ($1, $2, 'member', '{"all": true}'::jsonb, $1)
          ON CONFLICT (user_id, app_id) DO NOTHING
        `, [u.id, app[0].id]);
        report.grants.status = `granted fieldcam access to ${u.full_name} <${u.email}>`;
      }
    }
  } catch (err) {
    report.grants.status = `error: ${err.message}`;
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(report, null, 2));
  await db.end();
})();
