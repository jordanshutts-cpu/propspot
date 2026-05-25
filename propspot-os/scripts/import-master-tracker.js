// scripts/import-master-tracker.js
//
// One-time (re-runnable) import of all RH deals from the master Finance Tracker
// workbook into the propspot-os Postgres `properties` table.
//
// Usage (from propspot-os/):
//   npm run import-master-tracker
//   node scripts/import-master-tracker.js [/absolute/path/to/tracker.xlsx]
//
// Safe to re-run: ON CONFLICT (normalized_address) DO UPDATE.
// Existing values are NEVER overwritten with null — COALESCE keeps whatever is
// already stored when the tracker row is missing a value.
//
// Sources read from the workbook:
//   "1a. RHI"          — ~147 purchased / active / historical deals
//   "5. A. Projects"   — ~103 Dead pipeline deals that never closed

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { normalizeAddress, parseFreetextAddress } = require('../lib/address');

// ── Default path: tracker lives next to propspot-os/ ────────────────────────
const DEFAULT_XLSX = path.join(
  __dirname, '..', '..',
  'RH Master Finance Tracker and Loan Facility (Updated 3-13-26 v1).xlsx'
);

// ── Column indices (0-based) in "1a. RHI" row-2 headers ─────────────────────
// Verified against the live workbook.
const COL = {
  status:           0,   // A  — Sold / Renovations / Purchasing / Rented / …
  strategy:         1,   // B  — Fix N' Flip / LTR / LTR Fund I / Wholetail / …
  lender:           2,   // C  — Lender (text; used for contact lookup later)
  dataSource:       3,   // D  — Referral / FC / PPL / MLS / PPC / Wholesaler
  conversion:       4,   // E  — Door Knocking / Cold Calling / Auction / …
  propType:         5,   // F  — SFH / Mobile / etc.
  address:          6,   // G  — Full street address (canonical key)
  purchaseDate:    10,   // K
  purchasePrice:   11,   // L  — Purchase Price on HUD
  bridgeOrigFee:   28,   // AC — Bridge Origination Fee
  loanServicing:   29,   // AD — Loan Servicing Fee
  renoHoldback:    55,   // BD — Reno Holdback
  totalBorrowed:   57,   // BF — Total Borrowed
  purchaseLoanAmt: 60,   // BI — Purchase Loan Amount
  lenderArv:       62,   // BK — Lender ARV
  interestRate:    64,   // BM — Interest Rate (decimal or %)
  renoBudget:      71,   // BT — Reno Budget
  renoSpent:       72,   // BU — Reno Spend (Salesforce actual)
  renoDraws:       74,   // BW — Reno Draws Received
  saleDate:       103,   // CZ — Sale Date
  uwArv:          105,   // DB — ARV (from sales section)
  soldPrice:      106,   // DC — Actual Sale Price
  dscrArv:        144,   // EO — DSCR ARV (LTR / rental deals)
};

// ── Status mapping: tracker text → propspot status enum ─────────────────────
// Valid propspot values: purchasing | renovating | selling | renting | rented |
//   sold | dropped | assigned | listed_for_rent | listed_for_sale |
//   under_contract_buyer
const STATUS_MAP = {
  'Sold':            'sold',
  'Assigned':        'assigned',
  'Rented':          'rented',
  'Listed for Rent': 'listed_for_rent',
  'Listed on MLS':   'listed_for_sale',
  'UC with Buyer':   'under_contract_buyer',
  'Renovations':     'renovating',
  'Purchasing':      'purchasing',
  'Dead':            'dropped',
  'Wholesale':       'dropped',
};

// ── Value cleaners ──────────────────────────────────────────────────────────
function num(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,\s]/g, '');
  if (!s || s.startsWith('#')) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function rate(v) {
  // Rate may be stored as decimal (0.1099) or percentage points (10.99)
  const n = num(v);
  if (n == null) return null;
  return n > 1 ? parseFloat((n / 100).toFixed(4)) : n;
}

function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  return null;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ── Read all property rows from the workbook ─────────────────────────────────
function readTracker(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath, {
    cellDates:  true,
    sheetRows:  600,    // enough for all RHI rows; limits large sheets for speed
  });

  const rows = [];
  const seen = new Set();  // dedup by address (case-insensitive)

  // ── 1a. RHI ─────────────────────────────────────────────────────────────
  const ws = wb.Sheets['1a. RHI'];
  if (!ws) throw new Error('Sheet "1a. RHI" not found in workbook');

  // header:1 → 2-D array; row 0 = Excel row 1 (section title)
  //                        row 1 = Excel row 2 (column headers)
  //                        row 2+ = data rows
  const data = XLSX.utils.sheet_to_json(ws, {
    header:    1,
    defval:    null,
    raw:       true,
    cellDates: true,
  });

  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const addrRaw = row[COL.address];
    if (!addrRaw || typeof addrRaw !== 'string') continue;
    const addrStr = addrRaw.trim();
    if (!addrStr || addrStr.includes('Total')) continue;

    const statusText   = String(row[COL.status]   || '').trim();
    const strategyText = String(row[COL.strategy] || '').trim();
    const purchase     = num(row[COL.purchasePrice]);
    // Skip pure section-label / totals rows
    if (!statusText && !strategyText && !purchase) continue;

    const key = addrStr.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      addrStr,
      status:               STATUS_MAP[statusText] || null,
      strategy:             strategyText || null,
      property_type:        str(row[COL.propType]),
      data_source:          str(row[COL.dataSource]),
      conversion_method:    str(row[COL.conversion]),
      purchase_date:        isoDate(row[COL.purchaseDate]),
      purchase_price:       purchase,
      bridge_origination_fee: num(row[COL.bridgeOrigFee]),
      loan_servicing_fee:   num(row[COL.loanServicing]),
      reno_holdback:        num(row[COL.renoHoldback]),
      total_borrowed:       num(row[COL.totalBorrowed]),
      purchase_loan_amount: num(row[COL.purchaseLoanAmt]),
      lender_arv:           num(row[COL.lenderArv]),
      interest_rate:        rate(row[COL.interestRate]),
      reno_budget:          num(row[COL.renoBudget]),
      reno_spent:           num(row[COL.renoSpent]),
      reno_draws_received:  num(row[COL.renoDraws]),
      sold_date:            isoDate(row[COL.saleDate]),
      sold_price:           num(row[COL.soldPrice]),
      uw_arv:               num(row[COL.uwArv]) || num(row[COL.dscrArv]),
    });
  }

  // ── 5. A. Projects — Dead pipeline deals ────────────────────────────────
  const ws2 = wb.Sheets['5. A. Projects'];
  if (ws2) {
    const data2 = XLSX.utils.sheet_to_json(ws2, {
      header: 1, defval: null, raw: true, cellDates: true,
    });
    for (let i = 1; i < data2.length; i++) {
      const row = data2[i];
      if (!row || !row[0]) continue;
      const statusVal = String(row[28] || '').trim();  // AC = 0-based 28
      if (!statusVal.includes('Dead')) continue;
      const addrStr = String(row[0]).trim();
      if (!addrStr) continue;
      const key = addrStr.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ addrStr, status: 'dropped', strategy: null });
    }
  }

  return rows;
}

// ── Upsert one row ──────────────────────────────────────────────────────────
const UPSERT_SQL = `
  INSERT INTO properties (
    address_line1, city, state, zip, normalized_address,
    status, strategy, property_type, data_source, conversion_method,
    purchase_date, purchase_price,
    bridge_origination_fee, loan_servicing_fee, reno_holdback,
    total_borrowed, purchase_loan_amount, lender_arv, interest_rate,
    reno_budget, reno_spent, reno_draws_received,
    sold_date, sold_price, uw_arv
  ) VALUES (
    $1,$2,$3,$4,$5,
    COALESCE($6,'purchasing'), $7,$8,$9,$10,
    $11,$12,
    $13,$14,$15,
    $16,$17,$18,$19,
    $20,$21,$22,
    $23,$24,$25
  )
  ON CONFLICT (normalized_address) DO UPDATE SET
    status                 = COALESCE(EXCLUDED.status,                 properties.status),
    strategy               = COALESCE(EXCLUDED.strategy,               properties.strategy),
    property_type          = COALESCE(EXCLUDED.property_type,          properties.property_type),
    data_source            = COALESCE(EXCLUDED.data_source,            properties.data_source),
    conversion_method      = COALESCE(EXCLUDED.conversion_method,      properties.conversion_method),
    purchase_date          = COALESCE(EXCLUDED.purchase_date,          properties.purchase_date),
    purchase_price         = COALESCE(EXCLUDED.purchase_price,         properties.purchase_price),
    bridge_origination_fee = COALESCE(EXCLUDED.bridge_origination_fee, properties.bridge_origination_fee),
    loan_servicing_fee     = COALESCE(EXCLUDED.loan_servicing_fee,     properties.loan_servicing_fee),
    reno_holdback          = COALESCE(EXCLUDED.reno_holdback,          properties.reno_holdback),
    total_borrowed         = COALESCE(EXCLUDED.total_borrowed,         properties.total_borrowed),
    purchase_loan_amount   = COALESCE(EXCLUDED.purchase_loan_amount,   properties.purchase_loan_amount),
    lender_arv             = COALESCE(EXCLUDED.lender_arv,             properties.lender_arv),
    interest_rate          = COALESCE(EXCLUDED.interest_rate,          properties.interest_rate),
    reno_budget            = COALESCE(EXCLUDED.reno_budget,            properties.reno_budget),
    reno_spent             = COALESCE(EXCLUDED.reno_spent,             properties.reno_spent),
    reno_draws_received    = COALESCE(EXCLUDED.reno_draws_received,    properties.reno_draws_received),
    sold_date              = COALESCE(EXCLUDED.sold_date,              properties.sold_date),
    sold_price             = COALESCE(EXCLUDED.sold_price,             properties.sold_price),
    uw_arv                 = COALESCE(EXCLUDED.uw_arv,                 properties.uw_arv),
    updated_at             = NOW()
  RETURNING (xmax = 0) AS is_insert
`;

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = process.argv[2] || DEFAULT_XLSX;

  if (!fs.existsSync(xlsxPath)) {
    console.error(`\nFile not found:\n  ${xlsxPath}`);
    console.error('\nUsage:');
    console.error('  npm run import-master-tracker');
    console.error('  node scripts/import-master-tracker.js "/path/to/tracker.xlsx"');
    process.exit(1);
  }

  console.log(`\nReading: ${path.basename(xlsxPath)}`);
  const rows = readTracker(xlsxPath);
  console.log(`Found ${rows.length} properties\n`);

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Make sure .env is present in propspot-os/');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let inserted = 0, updated = 0, errors = 0;

  for (const r of rows) {
    try {
      const parsed   = parseFreetextAddress(r.addrStr);
      const normAddr = normalizeAddress(parsed);

      const res = await pool.query(UPSERT_SQL, [
        parsed.address_line1, parsed.city, parsed.state, parsed.zip, normAddr,
        r.status ?? null, r.strategy ?? null,
        r.property_type ?? null, r.data_source ?? null, r.conversion_method ?? null,
        r.purchase_date ?? null, r.purchase_price ?? null,
        r.bridge_origination_fee ?? null, r.loan_servicing_fee ?? null,
        r.reno_holdback ?? null, r.total_borrowed ?? null,
        r.purchase_loan_amount ?? null, r.lender_arv ?? null,
        r.interest_rate ?? null,
        r.reno_budget ?? null, r.reno_spent ?? null,
        r.reno_draws_received ?? null,
        r.sold_date ?? null, r.sold_price ?? null, r.uw_arv ?? null,
      ]);

      if (res.rows[0]?.is_insert) inserted++;
      else updated++;

      const done = inserted + updated;
      if (done % 50 === 0) process.stdout.write(`  … ${done} processed\r`);

    } catch (e) {
      errors++;
      console.error(`  [ERROR] ${r.addrStr}: ${e.message}`);
    }
  }

  await pool.end();

  console.log(`\nComplete:`);
  console.log(`  ${inserted} new properties inserted`);
  console.log(`  ${updated}  existing properties updated`);
  if (errors) console.log(`  ${errors}  errors (see above)`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
