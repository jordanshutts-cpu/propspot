'use strict';

const path = require('path');

// ── Default path to the master tracker workbook ───────────────────────────────
// Override by passing a path as the first CLI arg to the import script.
const DEFAULT_TRACKER_XLSX = path.join(
  __dirname, '../../RH Master Finance Tracker and Loan Facility (Updated 3-13-26 v1).xlsx'
);

// ── Column indices in "1a. RHI" (0-indexed, header row = row index 1) ─────────
const TRACKER_COL = {
  status:          0,
  strategy:        1,
  dataSource:      3,
  conversion:      4,
  propType:        5,
  address:         6,
  purchaseDate:    10,
  purchasePrice:   11,
  bridgeOrigFee:   28,
  loanServicing:   29,
  renoHoldback:    55,
  totalBorrowed:   57,
  purchaseLoanAmt: 60,
  lenderArv:       62,
  interestRate:    64,
  renoBudget:      71,
  renoSpent:       72,
  renoDraws:       74,
  saleDate:        103,
  uwArv:           105,
  soldPrice:       106,
  dscrArv:         144,
};

// ── Spreadsheet status text → propspot DB status ──────────────────────────────
const TRACKER_STATUS_MAP = {
  'Sold':            'sold',
  'Assigned':        'assigned',
  'Rented':          'rented',
  'Renovations':     'renovating',
  'Purchasing':      'purchasing',
  'UC with Buyer':   'under_contract_buyer',
  'Listed on MLS':   'listed_for_sale',
  'Listed for Rent': 'listed_for_rent',
};

// Closed deals — actual disposition; sold_date/sold_price are real values.
const CLOSED_STATUSES = new Set(['sold', 'assigned']);

// Rental-indicating statuses.
const RENTAL_STATUSES = new Set(['rented', 'listed_for_rent', 'renting']);

// Rental-indicating strategies.
const RENTAL_STRATEGIES = new Set(['LTR', 'STR', 'LTR Fund I']);

// Flip-indicating strategies.
const FLIP_STRATEGIES = new Set(["Fix N' Flip", 'Wholesale', 'Wholetail']);

// ── Allowlist for PATCH /api/properties/:id ──────────────────────────────────
// Anything not in this list is silently ignored by the route. Keep in sync
// with the columns you actually want callers to write — the route uses this
// to prevent random fields (created_by, normalized_address, etc.) from being
// overwritten by the client.
const PATCHABLE_FIELDS = [
  // Address
  'address_line1', 'unit', 'city', 'state', 'zip', 'parcel_id', 'county', 'tms',
  'lat', 'lng', 'cover_url', 'notes', 'display_name',
  // Status / lifecycle
  'status', 'acquisition_status', 'lockbox_code',
  // Strategy + classification
  'strategy', 'property_type', 'data_source', 'conversion_method',
  'investment_type',
  // Contacts
  'lender_contact_id', 'seller_contact_id', 'owner_contact_id',
  'acquisition_agent_contact_id',
  // Dates + prices
  'purchase_date', 'purchase_price', 'sold_date', 'sold_price',
  // Lender / financing
  'bridge_origination_fee', 'loan_servicing_fee', 'reno_holdback',
  'total_borrowed', 'purchase_loan_amount', 'lender_arv', 'interest_rate',
  // Renovations
  'reno_budget', 'reno_spent', 'reno_draws_received', 'uw_arv', 'dscr_arv',
  // External refs
  'companycam_project_id', 'owner',
];

module.exports = {
  DEFAULT_TRACKER_XLSX,
  TRACKER_COL,
  TRACKER_STATUS_MAP,
  CLOSED_STATUSES,
  RENTAL_STATUSES,
  RENTAL_STRATEGIES,
  FLIP_STRATEGIES,
  PATCHABLE_FIELDS,
};
