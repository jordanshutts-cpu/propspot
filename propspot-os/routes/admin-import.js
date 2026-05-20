// One-time bulk import for the legacy properties spreadsheet (import.csv).
// Owner-only. Accepts a multipart upload of the raw CSV; matches each row
// to an existing property by normalized_address; updates the columns we
// care about; auto-creates lender + acquisition_agent contacts as needed.
//
// Returns a per-row report so the user can see what matched / was skipped.

const express = require('express');
const multer  = require('multer');
const { query, pool } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { normalizeAddress, parseFreetextAddress } = require('../lib/address');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }    // 5 MB
});

// ── Tiny CSV parser (RFC-4180-ish, handles quoted fields w/ commas) ──
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"')  { inQuotes = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cleanMoney(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,]/g, '').replace(/\s+/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function cleanPercent(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/%/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return Number((n / 100).toFixed(4));   // 10.99 → 0.1099
}
function cleanDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Accepts M/D/YY or M/D/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, d, y] = m;
  if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
  const date = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00Z`);
  return isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// CSV "Status" → properties.status
function mapStatus(s) {
  const v = (s || '').trim().toLowerCase();
  return ({
    'assigned':         'assigned',
    'purchasing':       'purchasing',
    'renovations':      'renovating',
    'listed for rent':  'listed_for_rent',
    'rented':           'rented',
    'listed on mls':    'listed_for_sale',
    'uc with buyer':    'under_contract_buyer',
    'sold':             'sold'
  })[v] || null;
}

// "Cash" / "NA" / "" mean no real lender — return null and don't make a contact
const NON_LENDER = new Set(['', 'cash', 'na', 'n/a']);

router.post('/properties', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const text = req.file.buffer.toString('utf8');
  const rows = parseCsv(text);
  if (!rows.length) return res.status(400).json({ error: 'CSV has no rows' });

  const header = rows[0].map(h => (h || '').trim());
  const colIdx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

  // Resolve column indices once.
  const C = {
    status:         colIdx('Status'),
    strategy:       colIdx('Strategy'),
    lender:         colIdx('Lender'),
    data_source:    colIdx('Data Source'),
    conv_method:    colIdx('Conversion Method'),
    type:           colIdx('Type'),
    property:       colIdx('Property'),
    purchase_date:  colIdx('Purchase Date'),
    purchase_price: colIdx('Purchase Price on HUD'),
    bridge_orig:    colIdx('Bridge Origination Fee'),
    loan_servicing: colIdx('Loan Servicing Fee'),
    acq_agent:      colIdx('Acquisition Agent'),
    reno_holdback:  colIdx('Reno Holdback'),
    total_borrowed: colIdx('Total Borrowed'),
    purchase_loan:  colIdx('Purchase Loan Amount'),
    lender_arv:     colIdx('Lender ARV'),
    interest_rate:  colIdx('Interest Rate'),
    reno_budget:    colIdx('Reno Budget'),
    reno_spent:     colIdx('Reno Spent'),
    reno_draws:     colIdx('Reno Draws Received'),
    sale_date:      colIdx('Sale Date'),
    uw_arv:         colIdx('UW ARV'),
    sale_price:     colIdx('Actual Sale Price')
  };
  if (C.property < 0) return res.status(400).json({ error: 'CSV missing required "Property" column' });

  // Collect unique lender + agent names so we can pre-create contacts.
  const lenderNames = new Set();
  const agentNames  = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const lenderRaw = clean(r[C.lender]);
    if (lenderRaw && !NON_LENDER.has(lenderRaw.toLowerCase())) lenderNames.add(lenderRaw);
    const agentRaw  = clean(r[C.acq_agent]);
    if (agentRaw && agentRaw.toLowerCase() !== 'none') agentNames.add(agentRaw);
  }

  // ── Resolve / create lender contacts ──
  const lenderId = {};                       // lenderName → contact_id
  for (const name of lenderNames) {
    const { rows: existing } = await query(
      `SELECT id FROM contacts WHERE LOWER(full_name) = LOWER($1) AND type = 'lender' LIMIT 1`,
      [name]
    );
    if (existing[0]) {
      lenderId[name] = existing[0].id;
    } else {
      const { rows: ins } = await query(
        `INSERT INTO contacts (type, full_name, created_by) VALUES ('lender', $1, $2) RETURNING id`,
        [name, req.userId]
      );
      lenderId[name] = ins[0].id;
    }
  }

  // ── Resolve / create acquisition_agent contacts ──
  const agentId = {};
  for (const name of agentNames) {
    const { rows: existing } = await query(
      `SELECT id FROM contacts WHERE LOWER(full_name) = LOWER($1) AND type = 'acquisition_agent' LIMIT 1`,
      [name]
    );
    if (existing[0]) {
      agentId[name] = existing[0].id;
    } else {
      const { rows: ins } = await query(
        `INSERT INTO contacts (type, full_name, created_by) VALUES ('acquisition_agent', $1, $2) RETURNING id`,
        [name, req.userId]
      );
      agentId[name] = ins[0].id;
    }
  }

  // ── De-dupe rows by normalized address, keeping the last occurrence ──
  const byNorm = new Map();
  const skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const propStr = clean(r[C.property]);
    if (!propStr) continue;
    const parsed = parseFreetextAddress(propStr);
    if (!parsed.ok) {
      skipped.push({ row: i + 1, address: propStr, reason: 'could not parse address' });
      continue;
    }
    const norm = normalizeAddress(parsed);
    byNorm.set(norm, { row: i + 1, raw: r, parsed });
  }

  // ── For each unique normalized address, look up existing property + UPDATE ──
  const report = {
    total_csv_rows:     rows.length - 1,
    unique_addresses:   byNorm.size,
    matched_updated:    0,
    skipped_not_found:  [],
    skipped_parse_fail: skipped,
    contacts_created:   {
      lenders: Object.keys(lenderId).length,
      agents:  Object.keys(agentId).length
    }
  };

  for (const [norm, entry] of byNorm.entries()) {
    const { rows: existing } = await query(
      'SELECT id FROM properties WHERE normalized_address = $1',
      [norm]
    );
    if (!existing[0]) {
      report.skipped_not_found.push({
        row: entry.row,
        address: `${entry.parsed.address_line1}, ${entry.parsed.city}, ${entry.parsed.state} ${entry.parsed.zip}`
      });
      continue;
    }

    const r = entry.raw;
    const lenderRaw = clean(r[C.lender]);
    const agentRaw  = clean(r[C.acq_agent]);
    const fields = {
      status:                       mapStatus(r[C.status]),
      strategy:                     clean(r[C.strategy]),
      property_type:                clean(r[C.type]),
      data_source:                  clean(r[C.data_source]),
      conversion_method:            clean(r[C.conv_method]),
      lender_contact_id:            (lenderRaw && !NON_LENDER.has(lenderRaw.toLowerCase()))
                                      ? lenderId[lenderRaw] : null,
      acquisition_agent_contact_id: (agentRaw && agentRaw.toLowerCase() !== 'none')
                                      ? agentId[agentRaw] : null,
      purchase_date:                cleanDate(r[C.purchase_date]),
      purchase_price:               cleanMoney(r[C.purchase_price]),
      sold_date:                    cleanDate(r[C.sale_date]),
      sold_price:                   cleanMoney(r[C.sale_price]),
      bridge_origination_fee:       cleanMoney(r[C.bridge_orig]),
      loan_servicing_fee:           cleanMoney(r[C.loan_servicing]),
      reno_holdback:                cleanMoney(r[C.reno_holdback]),
      total_borrowed:               cleanMoney(r[C.total_borrowed]),
      purchase_loan_amount:         cleanMoney(r[C.purchase_loan]),
      lender_arv:                   cleanMoney(r[C.lender_arv]),
      interest_rate:                cleanPercent(r[C.interest_rate]),
      reno_budget:                  cleanMoney(r[C.reno_budget]),
      reno_spent:                   cleanMoney(r[C.reno_spent]),
      reno_draws_received:          cleanMoney(r[C.reno_draws]),
      uw_arv:                       cleanMoney(r[C.uw_arv])
    };

    // Only set columns where we have a non-null value (don't blow away
    // existing fields just because the CSV cell is blank).
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) {
        sets.push(`${k} = $${i++}`);
        vals.push(v);
      }
    }
    if (!sets.length) continue;
    vals.push(existing[0].id);
    await query(
      `UPDATE properties SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
      vals
    );
    report.matched_updated++;
  }

  await logActivity({
    actorUserId: req.userId, entityType: 'property', entityId: null,
    action: 'bulk_imported', payload: {
      matched: report.matched_updated,
      not_found: report.skipped_not_found.length,
      parse_fail: report.skipped_parse_fail.length,
      lenders_created: report.contacts_created.lenders,
      agents_created: report.contacts_created.agents
    }
  });

  res.json(report);
});

module.exports = router;
