const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizeAddress } = require('../lib/address');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);

function badAddressBody({ address_line1, city, state, zip }) {
  if (!address_line1?.trim()) return 'address_line1 required';
  if (!city?.trim())          return 'city required';
  if (!state?.trim())         return 'state required';
  if (!zip?.toString().trim())return 'zip required';
  return null;
}

// GET /api/properties
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.*,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM prospects     WHERE property_id = p.id)::int AS prospect_count,
             (SELECT COUNT(*) FROM leads         WHERE property_id = p.id)::int AS lead_count,
             (SELECT COUNT(*) FROM opportunities WHERE property_id = p.id)::int AS opportunity_count,
             (SELECT COUNT(*) FROM purchases     WHERE property_id = p.id)::int AS purchase_count,
             (SELECT COUNT(*) FROM projects      WHERE property_id = p.id)::int AS project_count,
             (SELECT COUNT(*) FROM photos        WHERE property_id = p.id)::int AS photo_count
        FROM properties p
        LEFT JOIN users u ON u.id = p.created_by
       ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// GET /api/properties/:id — full detail with all pipeline records
router.get('/:id', async (req, res) => {
  try {
    const { rows: pRows } = await query(`
      SELECT p.*,
             u.full_name  AS created_by_name,
             lc.full_name AS lender_name,
             sc.full_name AS seller_name
        FROM properties p
        LEFT JOIN users    u  ON u.id  = p.created_by
        LEFT JOIN contacts lc ON lc.id = p.lender_contact_id
        LEFT JOIN contacts sc ON sc.id = p.seller_contact_id
       WHERE p.id = $1
    `, [req.params.id]);
    if (!pRows[0]) return res.status(404).json({ error: 'Property not found' });

    const [prospects, leads, opps, purchases, projects, contacts, photos, holdings] = await Promise.all([
      query('SELECT * FROM prospects     WHERE property_id = $1 ORDER BY created_at DESC', [req.params.id]),
      query('SELECT * FROM leads         WHERE property_id = $1 ORDER BY created_at DESC', [req.params.id]),
      query('SELECT * FROM opportunities WHERE property_id = $1 ORDER BY created_at DESC', [req.params.id]),
      query('SELECT * FROM purchases     WHERE property_id = $1 ORDER BY created_at DESC', [req.params.id]),
      query('SELECT * FROM projects      WHERE property_id = $1 ORDER BY created_at DESC', [req.params.id]),
      query(`SELECT pc.role, pc.is_primary, c.*
               FROM property_contacts pc
               JOIN contacts c ON c.id = pc.contact_id
              WHERE pc.property_id = $1
              ORDER BY pc.is_primary DESC, c.full_name`, [req.params.id]),
      query(`SELECT ph.*, u.full_name AS uploader_name
               FROM photos ph
               LEFT JOIN users u ON u.id = ph.uploaded_by
              WHERE ph.property_id = $1
              ORDER BY ph.taken_at DESC`, [req.params.id]),
      query(`SELECT i.*, c.full_name AS contact_name
               FROM holdings_items i
               LEFT JOIN contacts c ON c.id = i.contact_id
              WHERE i.property_id = $1
              ORDER BY i.next_due_date NULLS LAST, i.created_at DESC`, [req.params.id])
    ]);

    res.json({
      ...pRows[0],
      prospects: prospects.rows,
      leads: leads.rows,
      opportunities: opps.rows,
      purchases: purchases.rows,
      projects: projects.rows,
      contacts: contacts.rows,
      photos: photos.rows,
      holdings_items: holdings.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

// POST /api/properties — with dedup (returns existing on conflict, 409 not 500)
router.post('/', async (req, res) => {
  const err = badAddressBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const {
    address_line1, unit, city, state, zip, parcel_id, lat, lng, notes,
    display_name, status,
    owner, county, tms, lockbox_code,
    purchase_date, purchase_price, sold_date, sold_price,
    lender_contact_id, seller_contact_id
  } = req.body;
  const normalized = normalizeAddress({ address_line1, unit, city, state, zip });

  try {
    const { rows: existing } = await query(
      'SELECT * FROM properties WHERE normalized_address = $1',
      [normalized]
    );
    if (existing[0]) {
      return res.status(409).json({
        error: 'A property at this address already exists',
        existing: existing[0]
      });
    }

    const { rows } = await query(`
      INSERT INTO properties
        (address_line1, unit, city, state, zip, normalized_address, parcel_id, lat, lng, notes,
         display_name, status,
         owner, county, tms, lockbox_code,
         purchase_date, purchase_price, sold_date, sold_price,
         lender_contact_id, seller_contact_id,
         created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,COALESCE($12,'purchasing'),
              $13,$14,$15,$16,
              $17,$18,$19,$20,
              $21,$22,
              $23)
      RETURNING *
    `, [
      address_line1.trim(),
      unit?.trim() || null,
      city.trim(),
      state.trim(),
      zip.toString().trim(),
      normalized,
      parcel_id?.trim() || null,
      lat ? parseFloat(lat) : null,
      lng ? parseFloat(lng) : null,
      notes?.trim() || null,
      display_name?.trim() || null,
      status?.trim() || null,
      owner?.trim() || null,
      county?.trim() || null,
      tms?.trim() || null,
      lockbox_code?.trim() || null,
      purchase_date || null,
      purchase_price != null && purchase_price !== '' ? parseFloat(purchase_price) : null,
      sold_date || null,
      sold_price != null && sold_price !== '' ? parseFloat(sold_price) : null,
      lender_contact_id || null,
      seller_contact_id || null,
      req.userId
    ]);

    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: rows[0].id,
      action: 'created', payload: { address_line1, city, state, zip }
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create property' });
  }
});

// PATCH /api/properties/:id
router.patch('/:id', async (req, res) => {
  const allowed = [
    'address_line1','unit','city','state','zip','parcel_id','lat','lng','notes','cover_url','display_name','status',
    'owner','county','tms','lockbox_code',
    'purchase_date','purchase_price','sold_date','sold_price',
    'lender_contact_id','seller_contact_id'
  ];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(req.params.id);

  try {
    const { rows } = await query(
      `UPDATE properties SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });

    // If any address field changed, recompute normalized_address.
    if (['address_line1','unit','city','state','zip'].some(k => req.body[k] !== undefined)) {
      const p = rows[0];
      const newNorm = normalizeAddress(p);
      await query(
        `UPDATE properties SET normalized_address = $1 WHERE id = $2`,
        [newNorm, p.id]
      );
      rows[0].normalized_address = newNorm;
    }

    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: req.params.id,
      action: 'updated', payload: req.body
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// DELETE /api/properties/:id (owner only — destructive)
router.delete('/:id', async (req, res) => {
  try {
    const { rows: u } = await query('SELECT is_owner FROM users WHERE id = $1', [req.userId]);
    if (!u[0]?.is_owner) return res.status(403).json({ error: 'Owner access required' });

    await query('DELETE FROM properties WHERE id = $1', [req.params.id]);
    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: req.params.id,
      action: 'deleted'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete property' });
  }
});

module.exports = router;
