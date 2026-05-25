// scripts/import-master-tracker.js
//
// Re-runnable import of all RH deals from the master Finance Tracker
// workbook into the propspot-os Postgres `properties` table.
//
// Usage (from propspot-os/):
//   npm run import-master-tracker
//   node scripts/import-master-tracker.js [/absolute/path/to/tracker.xlsx]
//
// Source: "1a. RHI" sheet only — all purchased / active / historical deals.
// Dead pipeline deals ("5. A. Projects") are intentionally excluded.
//
// Rules for sold_date / sold_price:
//   Only populated for status = Sold or Assigned (actual dispositions).
//   Active deals (Renovations, Purchasing, Listed, UC with Buyer, Rented)
//   have projected dates/prices in those columns — those are NOT stored.
//
// Safe to re-run: ON CONFLICT (normalized_address) DO UPDATE.
// sold_date and sold_price are direct-assigned so bad projected values
// already in the DB get corrected on re-run.

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
const COL = {
  status:           0,   // A  — Sold / Renovations / Purchasing / Rented / …
  strategy:         1,   // B  — Fix N' Flip / LTR / LTR Fund I / Wholetail / …
  dataSource:       3,   // D  — Referral / FC / PPL / MLS / PPC / Wholesaler
  conversion:       4,   // E  — Door Knocking / Cold Calling / Auction / …
  propType:         5,   // F  — SFH / Mobile / etc.
  address:          6,   // G  — Full street address (canonical key)
  purchaseDate:    10,   // K  — Purchase Date
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
  saleDate:       103,   // CZ — Sale Date (actual for Sold/Assigned only)
  uwArv:          105,   // DB — ARV (flip/sales underwrite)
  soldPrice:      106,   // DC — Actual Sale Price (Sold only)
  dscrArv:        144,   // EO — DSCR ARV (LTR / rental deals)
};

// ── Statuses that represent actual closed/disposed deals ─────────────────────
// Only these get sold_date / sold_price populated.
const CLOSED_STATUSES = new Set(['Sold', 'Assigned']);

// ── Status mapping: tracker text → propspot status enum ─────────────────────
const STATUS_MAP = {
  'Sold':            'sold',
  'Assigned':        'assigned',
  'Rented':          'rented',
  'Listed for Rent': 'listed_for_rent',
  'Listed on MLS':   'listed_for_sale',
  'UC with Buyer':   'under_contract_buyer',
  'Renovations':     'renovating',
  'Purchasing':      'purchasing',
};

// ── Rental strategies / statuses (prefer DSCR ARV over flip ARV) ─────────────
const RENTAL_STATUSES   = new Set(['Rented', 'Listed for Rent']);
const RENTAL_STRATEGIES = new Set(['LTR', 'LTR Fund I', 'STR']);

// ── Value cleaners ──────────────────────────────────────────────────────────
function num(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,\s]/g, '');
  if (!s || s.startsWith('#')) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function rate(v) {
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
  // M/D/YYYY format
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return null;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ── Read all property rows from "1a. RHI" ────────────────────────────────────
function readTracker(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath, {
    cellDates:  true,
    sheetRows:  300,
  });

  const ws = wb.Sheets['1a. RHI'];
  if (!ws) throw new Error('Sheet "1a. RHI" not found in workbook');

  const data = XLSX.utils.sheet_to_json(ws, {
    header:    1,
    defval:    null,
    raw:       false,   // parse everything as formatted strings
    cellDates: true,
  });

  const rows = [];
  const seen = new Set();

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

    // Skip section-header / totals rows with no meaningful data
    if (!statusText && !strategyText && !purchase) continue;

    // Skip rows whose status doesn't map to a known propspot value
    // (catches section labels like "2021 Closings", "LTR Fund", etc.)
    if (statusText && !STATUS_MAP[statusText]) continue;

    const key = addrStr.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const isClosed  = CLOSED_STATUSES.has(statusText);
    const isRental  = RENTAL_STATUSES.has(statusText) || RENTAL_STRATEGIES.has(strategyText);

    // ARV: rentals prefer DSCR ARV; flips prefer sales section ARV
    const flipArv  = num(row[COL.uwArv]);
    const dscrArv  = num(row[COL.dscrArv]);
    const uwArv    = isRental
      ? (dscrArv || flipArv)
      : (flipArv  || dscrArv);

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
      // sold_date / sold_price: ONLY for actual closed deals
      sold_date:            isClosed ? isoDate(row[COL.saleDate])  : null,
      sold_price:           statusText === 'Sold' ? num(row[COL.soldPrice]) : null,
      uw_arv:               uwArv,
    });
  }

  return rows;
}

// ── Upsert one row ──────────────────────────────────────────────────────────
// Note: sold_date and sold_price are NOT wrapped in COALESCE — they are
// direct-assigned so re-running the script can correct previously stored
// projected values.
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
    sold_date              = EXCLUDED.sold_date,
    sold_price             = EXCLUDED.sold_price,
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
      if (done % 50 === 0) process.stdout.write(`  ... ${done} processed\r`);

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
