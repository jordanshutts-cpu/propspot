#!/usr/bin/env node
/**
 * One-off: import a CompanyCam project export (CSV) into Prop Spot's
 * `properties` table, recording the CC project ID on each row so we
 * can later attach photos via the CompanyCam API.
 *
 * The CSV is metadata only — addresses, photo counts, lat/lng — not
 * the actual photo binaries. Photo migration is a separate phase.
 *
 * Two modes:
 *   (default)  Dry run. Reports per-row outcome (MATCH-existing /
 *              MATCH-already-linked / NEW / SKIP), no writes.
 *   --import   Real run.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/import-companycam-projects.js [csv-path]
 *   DATABASE_URL='postgres://...' node scripts/import-companycam-projects.js [csv-path] --import
 *
 * Default csv-path: ~/Downloads/company cam projects.csv
 */

require('dotenv').config();
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { Pool } = require('pg');
const { normalizeAddress } = require('../lib/address');

// ── Args ────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DO_WRITE = args.includes('--import');
const csvArg   = args.find(a => !a.startsWith('-'));
const csvPath  = csvArg || path.join(os.homedir(), 'Downloads', 'company cam projects.csv');

if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

// ── CSV parsing (no external dep — handles quoted fields w/ commas) ────
function parseCsv(text) {
  const out = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"')                        { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"')                          { inQuotes = true; i++; continue; }
    if (c === ',')                          { row.push(field); field = ''; i++; continue; }
    if (c === '\r')                         { i++; continue; }
    if (c === '\n')                         { row.push(field); out.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out;
}

function rowsToObjects(grid) {
  const [header, ...body] = grid;
  return body
    .filter(r => r.length > 1 || (r.length === 1 && r[0].trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

// ── Address cleaning ────────────────────────────────────────────────────
const STATE_NAME_TO_ABBR = {
  'south carolina': 'SC', 'north carolina': 'NC', 'georgia': 'GA',
  'florida': 'FL', 'tennessee': 'TN', 'alabama': 'AL', 'virginia': 'VA',
};

function normalizeStateField(s) {
  if (!s) return '';
  const t = s.trim();
  if (t.length === 2) return t.toUpperCase();
  const ab = STATE_NAME_TO_ABBR[t.toLowerCase()];
  return ab || t.toUpperCase();
}

function cleanLine1(rawLine1, city, state, zip) {
  let s = (rawLine1 || '').trim();
  // Strip trailing country.
  s = s.replace(/\s*[,•]?\s*(United\s*states|US|USA)\.?\s*$/i, '');
  // Strip trailing zip (5 or 5+4).
  if (zip) {
    const z = zip.replace(/\D/g, '').slice(0, 5);
    if (z) s = s.replace(new RegExp(`\\s*${z}(-\\d{4})?\\s*$`), '');
  } else {
    s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, '');
  }
  // Strip trailing state (abbr OR spelled-out).
  if (state) {
    const stWords = state.replace(/[^A-Za-z\s]/g, '').trim();
    if (stWords) {
      s = s.replace(new RegExp(`\\s+${stWords.replace(/\s+/g, '\\s+')}\\s*$`, 'i'), '');
    }
  }
  s = s.replace(/\s+(SC|NC|GA|FL|TN|AL|VA|South\s+Carolina|North\s+Carolina|Georgia)\s*$/i, '');
  // Strip trailing city.
  if (city) {
    const cityEsc = city.replace(/\s+/g, '\\s+');
    s = s.replace(new RegExp(`\\s+${cityEsc}\\s*$`, 'i'), '');
  }
  // Collapse whitespace + strip dangling separators.
  s = s.replace(/[•,]\s*$/, '').replace(/\s+/g, ' ').trim();
  return s;
}

// Best-effort recovery for rows missing city/state — pull what we can
// from "Full Address" (the display string CC built).
function recoverFromFullAddress(full) {
  if (!full) return {};
  // Trim CC's "X • Y, Z" formatting.
  const cleaned = full.replace(/\s*•\s*/g, ', ');
  // Look for ", STATE ZIP" at the end.
  const m = cleaned.match(/[,\s]+([A-Za-z]{2}|South Carolina|North Carolina|Georgia|Florida|Tennessee|Alabama|Virginia)[,\s]+(\d{5})/i);
  if (!m) return {};
  return { state: normalizeStateField(m[1]), zip: m[2] };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  // Self-migrate so this script works against a DB that hasn't been
  // redeployed with the new schema.sql yet. Idempotent.
  await db.query(`
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS companycam_project_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS properties_companycam_project_uniq
      ON properties (companycam_project_id) WHERE companycam_project_id IS NOT NULL;
  `);

  const text = fs.readFileSync(csvPath, 'utf8');
  const records = rowsToObjects(parseCsv(text));
  console.log(DO_WRITE ? '=== LIVE RUN — writing properties ===' : '=== DRY RUN — no writes ===');
  console.log(`CSV: ${csvPath}`);
  console.log(`Rows: ${records.length}\n`);

  // Resolve owner for created_by attribution.
  let createdBy = null;
  try {
    const { rows } = await db.query(
      `SELECT id FROM users WHERE email = $1 OR google_email = $1 LIMIT 1`,
      ['jordan@sellrh.com']
    );
    createdBy = rows[0]?.id || null;
  } catch (_) {}

  const report = {
    matched_set:      0,  // existing property, CC ID newly attached
    matched_already:  0,  // existing property already had a CC ID (skip)
    matched_other_cc: 0,  // existing property already has a DIFFERENT CC ID (warn, skip)
    created:          0,
    placeholder:      0,  // created with UNKNOWN city/state/zip
    errors:           0,
  };

  for (const r of records) {
    const ccId  = r['ID'];
    const photos = parseInt(r['Photos'] || '0', 10) || 0;

    try {
      let state = normalizeStateField(r['State']);
      let zip   = (r['Postal Code'] || '').replace(/\D/g, '').slice(0, 5);
      let city  = r['City'] || '';

      // Recover state/zip from Full Address if structured fields are empty.
      if (!state || !zip) {
        const rec = recoverFromFullAddress(r['Full Address']);
        if (!state && rec.state) state = rec.state;
        if (!zip   && rec.zip)   zip   = rec.zip;
      }

      const line1 = cleanLine1(r['Address Line 1'], city, state, zip);
      const isPlaceholder = !city || !state || !zip;

      // For placeholders, use sentinel values that won't collide.
      const safeCity  = city  || 'UNKNOWN';
      const safeState = state || 'XX';
      const safeZip   = zip   || '00000';

      const norm = normalizeAddress({
        address_line1: line1, city: safeCity, state: safeState, zip: safeZip,
      });

      // Look up existing property by normalized address.
      const { rows: existing } = await db.query(
        `SELECT id, address_line1, city, state, zip, companycam_project_id
           FROM properties WHERE normalized_address = $1 LIMIT 1`,
        [norm]
      );
      const prop = existing[0];

      if (prop) {
        if (prop.companycam_project_id === ccId) {
          console.log(`✓ MATCH-LINKED   ${ccId.padStart(11)}  ${line1}, ${safeCity}, ${safeState} ${safeZip}`);
          report.matched_already++;
          continue;
        }
        if (prop.companycam_project_id && prop.companycam_project_id !== ccId) {
          console.log(`⚠ MATCH-OTHER-CC ${ccId.padStart(11)}  ${line1}  (already linked to CC ${prop.companycam_project_id})`);
          report.matched_other_cc++;
          continue;
        }
        if (DO_WRITE) {
          await db.query(
            `UPDATE properties SET companycam_project_id = $1, updated_at = NOW() WHERE id = $2`,
            [ccId, prop.id]
          );
        }
        console.log(`✅ MATCH-SET     ${ccId.padStart(11)}  ${line1}, ${safeCity}, ${safeState} ${safeZip}  (existing id=${prop.id.slice(0,8)})`);
        report.matched_set++;
        continue;
      }

      // No match — create new property.
      const lat = parseFloat(r['Latitude'])  || null;
      const lng = parseFloat(r['Longitude']) || null;
      const notes = isPlaceholder
        ? `[companycam-import] Original CC ID ${ccId} had incomplete address. Full Address from CC: "${r['Full Address']}". Photos: ${photos}.`
        : null;

      if (!DO_WRITE) {
        const label = isPlaceholder ? '➕ NEW (PLACEHOLDER)' : '➕ NEW           ';
        console.log(`${label} ${ccId.padStart(11)}  ${line1}, ${safeCity}, ${safeState} ${safeZip}  (would create)`);
        if (isPlaceholder) report.placeholder++; else report.created++;
        continue;
      }

      const { rows: ins } = await db.query(
        `INSERT INTO properties
           (address_line1, city, state, zip, normalized_address,
            lat, lng, notes, companycam_project_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (normalized_address) DO UPDATE
           SET companycam_project_id = COALESCE(properties.companycam_project_id, EXCLUDED.companycam_project_id)
         RETURNING id, (xmax = 0) AS inserted`,
        [line1 || '(unknown)', safeCity, safeState, safeZip, norm, lat, lng, notes, ccId, createdBy]
      );
      const row = ins[0];
      const label = isPlaceholder ? '✅ CREATED (PLACEHOLDER)' : '✅ CREATED       ';
      console.log(`${label} ${ccId.padStart(11)}  ${line1}, ${safeCity}, ${safeState} ${safeZip}  (id=${row.id.slice(0,8)})`);
      if (isPlaceholder) report.placeholder++; else report.created++;
    } catch (err) {
      console.error(`❌ ERROR         ${ccId.padStart(11)}  ${r['Address Line 1']}  →  ${err.message}`);
      report.errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Existing property, CC ID newly attached:   ${report.matched_set}`);
  console.log(`Existing property, already linked:         ${report.matched_already}`);
  console.log(`Existing property linked to OTHER CC ID:   ${report.matched_other_cc}`);
  console.log(`New properties (clean address):            ${report.created}`);
  console.log(`New properties (placeholder, needs fixup): ${report.placeholder}`);
  console.log(`Errors:                                    ${report.errors}`);

  if (report.placeholder > 0) {
    console.log(`\nPlaceholder rows were created with city=UNKNOWN, state=XX, zip=00000.`);
    console.log(`Find them in the UI by searching for "UNKNOWN" in the address — the notes field has the original CC address.`);
  }

  await db.end();
})();
