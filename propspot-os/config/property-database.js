// =============================================================================
//  PROPERTY DATABASE — Single Source of Truth
//  config/property-database.js
//
//  This file owns every constant, mapping, and field list that touches the
//  `properties` Postgres table.  Any time you need to:
//    • Add a new status or strategy value
//    • Add / rename a financial field
//    • Change how tracker columns map to DB columns
//    • Update display labels or colours in the UI
//
//  …make the change HERE and nowhere else.  All other files import from this
//  module so the rest of the codebase stays in sync automatically.
//
//  DATA SOURCE
//  -----------
//  The authoritative address list comes from the RH Master Finance Tracker
//  workbook (see DEFAULT_TRACKER_XLSX below).  Run the import script to
//  refresh the DB from the spreadsheet:
//
//    cd propspot-os/
//    npm run import-master-tracker
//
//  The script is idempotent — safe to re-run at any time.
// =============================================================================

'use strict';

// ── Master Tracker workbook path (relative to repo root) ──────────────────
// The file lives one directory above propspot-os/ in the local checkout.
// Pass an absolute path as argv[2] to override:
//   node scripts/import-master-tracker.js "/path/to/other.xlsx"
const path = require('path');
const DEFAULT_TRACKER_XLSX = path.join(
  __dirname, '..', '..',
  'RH Master Finance Tracker and Loan Facility (Updated 3-13-26 v1).xlsx'
);

// =============================================================================
//  STATUS VALUES
//  Postgres CHECK constraint: properties_status_check (see db/schema.sql)
//  Any new value must be added here AND in the ALTER TABLE in schema.sql.
// =============================================================================
const STATUSES = {
  purchasing:            { label: 'Purchasing',          color: '#f59e0b' },
  renovating:            { label: 'Renovating',          color: '#3b82f6' },
  selling:               { label: 'Selling',             color: '#8b5cf6' },
  renting:               { label: 'Renting',             color: '#06b6d4' },
  rented:                { label: 'Rented',              color: '#10b981' },
  sold:                  { label: 'Sold',                color: '#22c55e' },
  dropped:               { label: 'Dead',                color: '#6b7280' },
  assigned:              { label: 'Assigned',            color: '#a3e635' },
  listed_for_rent:       { label: 'Listed for Rent',     color: '#14b8a6' },
  listed_for_sale:       { label: 'Listed on MLS',       color: '#a855f7' },
  under_contract_buyer:  { label: 'UC with Buyer',       color: '#f97316' },
};

// Convenience set of all valid status strings
const STATUS_VALUES = new Set(Object.keys(STATUSES));

// Statuses that represent a fully closed / disposed deal.
// Only these get sold_date and sold_price populated during import.
const CLOSED_STATUSES = new Set(['sold', 'assigned']);

// =============================================================================
//  ACQUISITION SUB-STATUS VALUES
//  Used on properties with status='purchasing' to track pipeline sub-stage.
//  Postgres CHECK constraint: properties_acquisition_status_check
// =============================================================================
const ACQUISITION_STATUSES = {
  approved_to_close: { label: 'Approved to Close' },
  due_diligence:     { label: 'Due Diligence' },
  under_contract:    { label: 'Under Contract' },
  assigning:         { label: 'Assigning' },
};

// =============================================================================
//  STRATEGY VALUES  (free-text column — no DB constraint, just convention)
// =============================================================================
const STRATEGIES = [
  "Fix N' Flip",
  'LTR',          // Long-Term Rental
  'LTR Fund I',
  'STR',          // Short-Term Rental
  'Wholesale',
  'Wholetail',
];

// Strategies / statuses that indicate a rental deal.
// Rental deals prefer DSCR ARV over flip/sales ARV during import.
const RENTAL_STATUSES   = new Set(['rented', 'listed_for_rent', 'renting']);
const RENTAL_STRATEGIES = new Set(['LTR', 'LTR Fund I', 'STR']);

// =============================================================================
//  MASTER TRACKER → DB STATUS MAP
//  Used by:  scripts/import-master-tracker.js
//            routes/admin-import.js (CSV import)
//  Tracker text (exact) → propspot DB status enum
// =============================================================================
const TRACKER_STATUS_MAP = {
  // Tracker value        → DB status
  'Sold':                  'sold',
  'Assigned':              'assigned',
  'Rented':                'rented',
  'Listed for Rent':       'listed_for_rent',
  'Listed on MLS':         'listed_for_sale',
  'UC with Buyer':         'under_contract_buyer',
  'Renovations':           'renovating',
  'Purchasing':            'purchasing',
  // Dead / pipeline deals are excluded from the DB entirely (see import script)
};

// CSV import variant (lowercase keys — used by admin-import.js)
const CSV_STATUS_MAP = {
  'assigned':         'assigned',
  'purchasing':       'purchasing',
  'renovations':      'renovating',
  'listed for rent':  'listed_for_rent',
  'rented':           'rented',
  'listed on mls':    'listed_for_sale',
  'uc with buyer':    'under_contract_buyer',
  'sold':             'sold',
};

// =============================================================================
//  MASTER TRACKER COLUMN INDICES
//  Sheet: "1a. RHI" — 0-based column positions.
//  Verify against the live workbook if the spreadsheet is ever restructured.
//  Column letter → 0-based: A=0, B=1, … Z=25, AA=26, … BM=64, EO=144, etc.
// =============================================================================
const TRACKER_COL = {
  status:           0,   // A  — Sold / Renovations / Purchasing / Rented / …
  strategy:         1,   // B  — Fix N' Flip / LTR / LTR Fund I / Wholetail / …
  dataSource:       3,   // D  — Referral / FC / PPL / MLS / PPC / Wholesaler
  conversion:       4,   // E  — Door Knocking / Cold Calling / Auction / …
  propType:         5,   // F  — SFH / Mobile / etc.
  address:          6,   // G  — ★ Full street address (the canonical key)
  purchaseDate:    10,   // K  — Purchase Date
  purchasePrice:   11,   // L  — Purchase Price on HUD
  bridgeOrigFee:   28,   // AC — Bridge Origination Fee
  loanServicing:   29,   // AD — Loan Servicing Fee
  renoHoldback:    55,   // BD — Reno Holdback
  totalBorrowed:   57,   // BF — Total Borrowed
  purchaseLoanAmt: 60,   // BI — Purchase Loan Amount
  lenderArv:       62,   // BK — Lender ARV
  interestRate:    64,   // BM — Interest Rate (decimal or %)
  renoBudget:      71,   // BT — Reno Budget (estimate)
  renoSpent:       72,   // BU — Reno Spend (Salesforce actual)
  renoDraws:       74,   // BW — Reno Draws Received
  saleDate:       103,   // CZ — Sale Date (actual for Sold/Assigned ONLY)
  uwArv:          105,   // DB — ARV (flip / sales underwrite)
  soldPrice:      106,   // DC — Actual Sale Price (Sold ONLY)
  dscrArv:        144,   // EO — DSCR ARV (LTR / rental deals)
};

// =============================================================================
//  PATCHABLE FIELDS
//  The complete list of columns that the PATCH /api/properties/:id endpoint
//  allows callers to modify.  Add new columns here when you add them to the
//  schema (schema.sql) — the route reads directly from this array.
// =============================================================================
const PATCHABLE_FIELDS = [
  // ── Address / identity ───────────────────────────────────────────
  'address_line1', 'unit', 'city', 'state', 'zip',
  'parcel_id', 'lat', 'lng', 'notes', 'cover_url', 'display_name',

  // ── Status ───────────────────────────────────────────────────────
  'status', 'acquisition_status',

  // ── Ownership / contacts ─────────────────────────────────────────
  'owner', 'owner_contact_id', 'county', 'tms', 'lockbox_code',
  'lender_contact_id', 'seller_contact_id', 'acquisition_agent_contact_id',

  // ── Key dates & prices ───────────────────────────────────────────
  'purchase_date', 'purchase_price',
  'anticipated_close_date',
  'sold_date',     'sold_price',

  // ── Deal metadata ────────────────────────────────────────────────
  'strategy', 'property_type', 'data_source', 'conversion_method',

  // ── Loan / financing ─────────────────────────────────────────────
  'bridge_origination_fee', 'loan_servicing_fee',
  'reno_holdback',          'total_borrowed',
  'purchase_loan_amount',   'lender_arv',
  'interest_rate',

  // ── Renovation ───────────────────────────────────────────────────
  'reno_budget', 'reno_spent', 'reno_draws_received',

  // ── Underwriting ─────────────────────────────────────────────────
  'uw_arv',
];

// =============================================================================
//  FINANCIAL FIELDS  (subset of PATCHABLE_FIELDS — numeric / money columns)
//  Useful for display formatting, validation, and CSV import coercion.
// =============================================================================
const FINANCIAL_FIELDS = [
  'purchase_price', 'sold_price',
  'bridge_origination_fee', 'loan_servicing_fee',
  'reno_holdback', 'total_borrowed', 'purchase_loan_amount',
  'lender_arv', 'reno_budget', 'reno_spent', 'reno_draws_received',
  'uw_arv',
];

const RATE_FIELDS = ['interest_rate'];   // stored as decimal: 0.1099 = 10.99%
const DATE_FIELDS = ['purchase_date', 'anticipated_close_date', 'sold_date'];

// =============================================================================
//  EXPORTS
// =============================================================================
module.exports = {
  DEFAULT_TRACKER_XLSX,
  STATUSES,
  STATUS_VALUES,
  CLOSED_STATUSES,
  ACQUISITION_STATUSES,
  STRATEGIES,
  RENTAL_STATUSES,
  RENTAL_STRATEGIES,
  TRACKER_STATUS_MAP,
  CSV_STATUS_MAP,
  TRACKER_COL,
  PATCHABLE_FIELDS,
  FINANCIAL_FIELDS,
  RATE_FIELDS,
  DATE_FIELDS,
};
