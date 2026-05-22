// Holdings Desk — per-property system of record for ongoing obligations:
// utilities, insurance, property taxes, mortgages, business licenses, HOA.
// Three resources mounted under /api/holdings:
//   • items      — the policy / account / loan / utility-service record
//   • payments   — payment history per item
//   • documents  — files (policy PDFs, statements, receipts) on Cloudinary
// Plus aggregates: /summary (dashboard) and /upcoming-due.
//
// v2 follow-up: a daily Railway cron at scripts/holdings-reminders.js that
// reads /upcoming-due and uses lib/email.js to send digest emails when an
// item has reminder_enabled = true and next_due_date is within
// reminder_days_before.

const express    = require('express');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { query, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES      = ['utility','insurance','property_tax','mortgage','business_license','hoa'];
const FREQUENCIES     = ['monthly','quarterly','semiannual','annual','one_time','variable'];
const STATUSES        = ['active','paused','closed'];
const PAYMENT_METHODS = ['ach','check','card','cash','autopay','other'];

const ITEM_FIELDS = [
  'property_id','category','name','vendor','account_number',
  'provider_phone','provider_email','provider_website','provider_portal_url','provider_address',
  'contact_id','amount','frequency','next_due_date','start_date','end_date',
  'status','auto_pay','reminder_enabled','reminder_days_before','details','notes'
];
const PAYMENT_FIELDS = [
  'item_id','property_id','amount','paid_on',
  'covers_period_start','covers_period_end','method','reference','notes'
];
const PAYMENT_PATCH_FIELDS = PAYMENT_FIELDS.filter(f => f !== 'item_id' && f !== 'property_id');
const DOC_PATCH_FIELDS = ['label','doc_type','payment_id','valid_from','valid_to','notes'];

// ── helpers ─────────────────────────────────────────────────────────────
function buildInsert(table, allowed, body, userId) {
  const cols = ['created_by'];
  const placeholders = ['$1'];
  const vals = [userId];
  let i = 2;
  for (const k of allowed) {
    if (body[k] === undefined) continue;
    cols.push(k);
    placeholders.push(`$${i++}`);
    vals.push(body[k]);
  }
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    vals
  };
}

function buildUpdate(table, allowed, body) {
  const sets = []; const vals = []; let i = 1;
  for (const k of allowed) {
    if (body[k] === undefined) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(body[k]);
  }
  if (!sets.length) return null;
  return { sets, vals, nextIndex: i };
}

function badEnum(name, value, list) {
  if (value === undefined || value === null || value === '') return null;
  return list.includes(value) ? null : `${name} must be one of: ${list.join(', ')}`;
}

// ── Aggregates ──────────────────────────────────────────────────────────

// GET /api/holdings/summary — portfolio-wide rollup for the dashboard tile.
router.get('/summary', async (req, res) => {
  try {
    const [summary, byCat] = await Promise.all([
      query(`
        SELECT
          COALESCE(SUM(CASE frequency
            WHEN 'monthly'    THEN COALESCE(amount, 0)
            WHEN 'quarterly'  THEN COALESCE(amount, 0) / 3
            WHEN 'semiannual' THEN COALESCE(amount, 0) / 6
            WHEN 'annual'     THEN COALESCE(amount, 0) / 12
            ELSE 0
          END), 0)::numeric(12,2) AS monthly_carry,
          COUNT(*) FILTER (WHERE next_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS due_this_week,
          COUNT(*) FILTER (WHERE next_due_date < CURRENT_DATE)::int AS overdue,
          COUNT(*)::int AS active_count
          FROM holdings_items
         WHERE status = 'active'
      `),
      query(`
        SELECT category, COUNT(*)::int AS count
          FROM holdings_items
         WHERE status = 'active'
         GROUP BY category
      `)
    ]);
    const by_category = byCat.rows.reduce((acc, r) => { acc[r.category] = r.count; return acc; }, {});
    res.json({ ...summary.rows[0], by_category });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holdings summary' });
  }
});

// GET /api/holdings/upcoming-due?days=14
router.get('/upcoming-due', async (req, res) => {
  const days = Math.max(0, Math.min(365, parseInt(req.query.days, 10) || 14));
  try {
    const { rows } = await query(`
      SELECT i.*, p.address_line1, p.city, p.state, p.display_name
        FROM holdings_items i
        JOIN properties p ON p.id = i.property_id
       WHERE i.status = 'active'
         AND i.next_due_date IS NOT NULL
         AND i.next_due_date <= CURRENT_DATE + $1::int
       ORDER BY i.next_due_date ASC
    `, [days]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch upcoming-due holdings' });
  }
});

// ── Items ───────────────────────────────────────────────────────────────

// GET /api/holdings/items
router.get('/items', async (req, res) => {
  try {
    const where = []; const params = [];
    if (req.query.property_id) { params.push(req.query.property_id); where.push(`i.property_id = $${params.length}`); }
    if (req.query.category)    { params.push(req.query.category);    where.push(`i.category = $${params.length}`); }
    if (req.query.status)      { params.push(req.query.status);      where.push(`i.status = $${params.length}`); }
    const { rows } = await query(`
      SELECT i.*,
             c.full_name      AS contact_name,
             p.address_line1  AS property_address,
             p.city           AS property_city,
             p.state          AS property_state,
             p.display_name   AS property_display_name
        FROM holdings_items i
        LEFT JOIN contacts   c ON c.id = i.contact_id
        LEFT JOIN properties p ON p.id = i.property_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY i.next_due_date NULLS LAST, i.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// GET /api/holdings/items/:id — item plus its payments and documents.
router.get('/items/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT i.*,
             c.full_name     AS contact_name,
             c.phone         AS contact_phone,
             c.email         AS contact_email,
             p.address_line1 AS property_address,
             p.city          AS property_city,
             p.state         AS property_state,
             p.display_name  AS property_display_name
        FROM holdings_items i
        LEFT JOIN contacts   c ON c.id = i.contact_id
        LEFT JOIN properties p ON p.id = i.property_id
       WHERE i.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Holding not found' });

    const [payments, documents] = await Promise.all([
      query('SELECT * FROM holdings_payments WHERE item_id = $1 ORDER BY paid_on DESC, created_at DESC', [req.params.id]),
      query('SELECT * FROM holdings_documents WHERE item_id = $1 ORDER BY created_at DESC', [req.params.id])
    ]);
    res.json({ ...rows[0], payments: payments.rows, documents: documents.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holding' });
  }
});

// POST /api/holdings/items
router.post('/items', async (req, res) => {
  if (!req.body.property_id) return res.status(400).json({ error: 'property_id required' });
  if (!req.body.category)    return res.status(400).json({ error: 'category required' });
  if (!req.body.name)        return res.status(400).json({ error: 'name required' });
  const e1 = badEnum('category',  req.body.category,  CATEGORIES);  if (e1) return res.status(400).json({ error: e1 });
  const e2 = badEnum('frequency', req.body.frequency, FREQUENCIES); if (e2) return res.status(400).json({ error: e2 });
  const e3 = badEnum('status',    req.body.status,    STATUSES);    if (e3) return res.status(400).json({ error: e3 });

  try {
    const { sql, vals } = buildInsert('holdings_items', ITEM_FIELDS, req.body, req.userId);
    const { rows } = await query(sql, vals);
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_item', entityId: rows[0].id,
      action: 'created', payload: { property_id: rows[0].property_id, category: rows[0].category }
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create holding' });
  }
});

// PATCH /api/holdings/items/:id
router.patch('/items/:id', async (req, res) => {
  const e1 = badEnum('category',  req.body.category,  CATEGORIES);  if (e1) return res.status(400).json({ error: e1 });
  const e2 = badEnum('frequency', req.body.frequency, FREQUENCIES); if (e2) return res.status(400).json({ error: e2 });
  const e3 = badEnum('status',    req.body.status,    STATUSES);    if (e3) return res.status(400).json({ error: e3 });

  const built = buildUpdate('holdings_items', ITEM_FIELDS, req.body);
  if (!built) return res.status(400).json({ error: 'no fields to update' });
  built.vals.push(req.params.id);

  try {
    const { rows } = await query(
      `UPDATE holdings_items SET ${built.sets.join(', ')}, updated_at = NOW()
        WHERE id = $${built.nextIndex} RETURNING *`,
      built.vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Holding not found' });
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_item', entityId: req.params.id,
      action: req.body.status ? 'status_changed' : 'updated', payload: req.body
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update holding' });
  }
});

// DELETE /api/holdings/items/:id — cascades payments + documents via FK,
// but Cloudinary assets need explicit cleanup first.
router.delete('/items/:id', async (req, res) => {
  try {
    const { rows: docs } = await query(
      'SELECT cloudinary_id FROM holdings_documents WHERE item_id = $1',
      [req.params.id]
    );
    for (const d of docs) {
      if (!d.cloudinary_id) continue;
      await cloudinary.uploader.destroy(d.cloudinary_id, { resource_type: 'auto' })
        .catch(e => console.warn('Cloudinary delete warning:', e.message));
    }
    await query('DELETE FROM holdings_items WHERE id = $1', [req.params.id]);
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_item', entityId: req.params.id, action: 'deleted'
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

// POST /api/holdings/items/:id/mark-paid — record a payment + advance next_due_date
// in a single transaction so we can't end up with an inserted payment and a
// stale due date if two clicks race.
router.post('/items/:id/mark-paid', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: iRows } = await client.query(
      'SELECT * FROM holdings_items WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!iRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Holding not found' }); }
    const item = iRows[0];

    const paidOn = req.body.paid_on || new Date().toISOString().slice(0, 10);
    const amountIn = req.body.amount != null ? Number(req.body.amount) : item.amount;
    if (amountIn === null || amountIn === undefined || Number.isNaN(Number(amountIn))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount required (item has no default)' });
    }
    const method = req.body.method || (item.auto_pay ? 'autopay' : null);
    const em = badEnum('method', method, PAYMENT_METHODS);
    if (em) { await client.query('ROLLBACK'); return res.status(400).json({ error: em }); }

    const { rows: pRows } = await client.query(`
      INSERT INTO holdings_payments
        (item_id, property_id, amount, paid_on, method, reference, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [item.id, item.property_id, amountIn, paidOn, method,
        req.body.reference || null, req.body.notes || null, req.userId]);

    // Advance next_due_date server-side so DST / month-end math stays in Postgres.
    const { rows: aRows } = await client.query(`
      UPDATE holdings_items
         SET next_due_date = (CASE frequency
               WHEN 'monthly'    THEN COALESCE(next_due_date, $2::date) + INTERVAL '1 month'
               WHEN 'quarterly'  THEN COALESCE(next_due_date, $2::date) + INTERVAL '3 months'
               WHEN 'semiannual' THEN COALESCE(next_due_date, $2::date) + INTERVAL '6 months'
               WHEN 'annual'     THEN COALESCE(next_due_date, $2::date) + INTERVAL '1 year'
               ELSE next_due_date
             END)::date,
             updated_at = NOW()
       WHERE id = $1
       RETURNING next_due_date
    `, [item.id, paidOn]);

    await client.query('COMMIT');

    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_item', entityId: item.id,
      action: 'marked_paid', payload: { payment_id: pRows[0].id, amount: amountIn, next_due_date: aRows[0].next_due_date }
    });
    res.status(201).json({ payment: pRows[0], next_due_date: aRows[0].next_due_date });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to mark paid' });
  } finally {
    client.release();
  }
});

// ── Payments ────────────────────────────────────────────────────────────

router.get('/payments', async (req, res) => {
  try {
    const where = []; const params = [];
    if (req.query.property_id) { params.push(req.query.property_id); where.push(`property_id = $${params.length}`); }
    if (req.query.item_id)     { params.push(req.query.item_id);     where.push(`item_id = $${params.length}`); }
    const { rows } = await query(
      `SELECT * FROM holdings_payments
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY paid_on DESC, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch payments' }); }
});

router.get('/payments/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM holdings_payments WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch payment' }); }
});

// POST /api/holdings/payments — derives property_id from the parent item;
// never trusts the client to supply it.
router.post('/payments', async (req, res) => {
  if (!req.body.item_id)        return res.status(400).json({ error: 'item_id required' });
  if (req.body.amount == null)  return res.status(400).json({ error: 'amount required' });
  if (!req.body.paid_on)        return res.status(400).json({ error: 'paid_on required' });
  const em = badEnum('method', req.body.method, PAYMENT_METHODS);
  if (em) return res.status(400).json({ error: em });

  try {
    const { rows: iRows } = await query(
      'SELECT property_id FROM holdings_items WHERE id = $1',
      [req.body.item_id]
    );
    if (!iRows[0]) return res.status(400).json({ error: 'parent item not found' });

    const payload = { ...req.body, property_id: iRows[0].property_id };
    const { sql, vals } = buildInsert('holdings_payments', PAYMENT_FIELDS, payload, req.userId);
    const { rows } = await query(sql, vals);
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_payment', entityId: rows[0].id,
      action: 'created', payload: { item_id: rows[0].item_id, property_id: rows[0].property_id }
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.patch('/payments/:id', async (req, res) => {
  const em = badEnum('method', req.body.method, PAYMENT_METHODS);
  if (em) return res.status(400).json({ error: em });
  const built = buildUpdate('holdings_payments', PAYMENT_PATCH_FIELDS, req.body);
  if (!built) return res.status(400).json({ error: 'no fields to update' });
  built.vals.push(req.params.id);
  try {
    const { rows } = await query(
      `UPDATE holdings_payments SET ${built.sets.join(', ')}, updated_at = NOW()
        WHERE id = $${built.nextIndex} RETURNING *`,
      built.vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_payment', entityId: req.params.id,
      action: 'updated', payload: req.body
    });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update payment' }); }
});

router.delete('/payments/:id', async (req, res) => {
  try {
    await query('DELETE FROM holdings_payments WHERE id = $1', [req.params.id]);
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_payment', entityId: req.params.id, action: 'deleted'
    });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete payment' }); }
});

// ── Documents ───────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = file.mimetype === 'application/pdf'
      || file.mimetype.startsWith('image/')
      || file.mimetype === 'application/msword'
      || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || file.mimetype === 'application/vnd.ms-excel'
      || file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      || file.mimetype === 'text/plain';
    if (!ok) return cb(new Error('Unsupported file type'));
    cb(null, true);
  }
});

function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'holdings', resource_type: 'auto', ...options },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// POST /api/holdings/items/:itemId/documents (multipart)
router.post('/items/:itemId/documents', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const { rows: iRows } = await query(
      'SELECT property_id FROM holdings_items WHERE id = $1',
      [req.params.itemId]
    );
    if (!iRows[0]) return res.status(404).json({ error: 'Holding not found' });

    const result = await uploadToCloudinary(req.file.buffer, {
      public_id: `${req.params.itemId}/${Date.now()}`
    });

    const { rows } = await query(`
      INSERT INTO holdings_documents
        (item_id, property_id, payment_id, label, doc_type, url, cloudinary_id,
         mime_type, size_bytes, valid_from, valid_to, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      req.params.itemId,
      iRows[0].property_id,
      req.body.payment_id || null,
      (req.body.label && req.body.label.trim()) || req.file.originalname || null,
      req.body.doc_type || 'other',
      result.secure_url,
      result.public_id,
      req.file.mimetype,
      req.file.size,
      req.body.valid_from || null,
      req.body.valid_to || null,
      req.body.notes || null,
      req.userId
    ]);

    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_document', entityId: rows[0].id,
      action: 'created', payload: { item_id: req.params.itemId, property_id: iRows[0].property_id }
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Holdings document upload error:', err);
    res.status(500).json({ error: 'Failed to upload document: ' + err.message });
  }
});

router.get('/documents', async (req, res) => {
  try {
    const where = []; const params = [];
    if (req.query.property_id) { params.push(req.query.property_id); where.push(`property_id = $${params.length}`); }
    if (req.query.item_id)     { params.push(req.query.item_id);     where.push(`item_id = $${params.length}`); }
    if (req.query.payment_id)  { params.push(req.query.payment_id);  where.push(`payment_id = $${params.length}`); }
    const { rows } = await query(
      `SELECT * FROM holdings_documents
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch documents' }); }
});

router.get('/documents/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM holdings_documents WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch document' }); }
});

router.patch('/documents/:id', async (req, res) => {
  const built = buildUpdate('holdings_documents', DOC_PATCH_FIELDS, req.body);
  if (!built) return res.status(400).json({ error: 'no fields to update' });
  built.vals.push(req.params.id);
  try {
    const { rows } = await query(
      `UPDATE holdings_documents SET ${built.sets.join(', ')}, updated_at = NOW()
        WHERE id = $${built.nextIndex} RETURNING *`,
      built.vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_document', entityId: req.params.id,
      action: 'updated', payload: req.body
    });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update document' }); }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT cloudinary_id FROM holdings_documents WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    if (rows[0].cloudinary_id) {
      await cloudinary.uploader.destroy(rows[0].cloudinary_id, { resource_type: 'auto' })
        .catch(e => console.warn('Cloudinary delete warning:', e.message));
    }
    await query('DELETE FROM holdings_documents WHERE id = $1', [req.params.id]);
    await logActivity({
      actorUserId: req.userId, entityType: 'holdings_document', entityId: req.params.id, action: 'deleted'
    });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete document' }); }
});

module.exports = router;
