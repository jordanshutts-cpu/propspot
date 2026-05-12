const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizeAddress } = require('../lib/address');

const router = express.Router();
router.use(requireAuth);

// Computed-alias view: surface FieldCam-shaped `name` and `address` fields
// alongside Prop Spot's structured columns so the existing UI keeps working
// without page edits.
const SELECT_WITH_ALIASES = `
  SELECT p.*,
         p.display_name AS name,
         NULLIF(CONCAT_WS(', ',
           NULLIF(p.address_line1, ''),
           NULLIF(p.city, ''),
           CONCAT_WS(' ', NULLIF(p.state, ''), NULLIF(p.zip, ''))
         ), '') AS address,
         u.full_name AS created_by_name,
         (SELECT COUNT(*) FROM photos WHERE property_id = p.id)::int AS photo_count
    FROM properties p
    LEFT JOIN users u ON u.id = p.created_by
`;

// Parse a freetext address into Prop Spot's structured columns. Falls back
// to placeholder city/state/zip if parsing fails — the row is still
// useful, the original lives in notes for review.
function parseFreetextAddress(text) {
  if (!text || !text.trim()) {
    return { address_line1: '(unknown)', city: 'UNKNOWN', state: 'XX', zip: '00000', ok: false };
  }
  const raw = text.trim();
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    const m = last.match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
    if (m) {
      return {
        address_line1: parts[0],
        city:          parts[parts.length - 2],
        state:         m[1].toUpperCase(),
        zip:           m[2],
        ok: true
      };
    }
  }
  return { address_line1: raw.slice(0, 200), city: 'UNKNOWN', state: 'XX', zip: '00000', ok: false };
}

// GET /api/properties
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(SELECT_WITH_ALIASES + ' ORDER BY p.created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// GET /api/properties/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(SELECT_WITH_ALIASES + ' WHERE p.id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

// POST /api/properties
// Accepts either FieldCam-legacy {name, address} or structured Prop Spot fields.
router.post('/', async (req, res) => {
  const { name, address, notes, lat, lng } = req.body;
  let { address_line1, unit, city, state, zip, parcel_id } = req.body;

  if (!address_line1) {
    const parsed = parseFreetextAddress(address);
    address_line1 = parsed.address_line1;
    city          = parsed.city;
    state         = parsed.state;
    zip           = parsed.zip;
  }
  if (!address_line1?.trim() && !name?.trim()) {
    return res.status(400).json({ error: 'address or name required' });
  }

  const normalized = normalizeAddress({ address_line1, unit, city, state, zip });

  try {
    const { rows: existing } = await query(
      `SELECT * FROM properties WHERE normalized_address = $1`, [normalized]
    );
    if (existing[0]) {
      // Return existing so the UI can offer "use existing" instead of bouncing.
      return res.status(200).json(existing[0]);
    }

    const { rows } = await query(`
      INSERT INTO properties
        (address_line1, unit, city, state, zip, normalized_address, parcel_id, lat, lng, notes, display_name, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      name?.trim()  || null,
      req.userId
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create property' });
  }
});

// PATCH /api/properties/:id
router.patch('/:id', async (req, res) => {
  const allowed = ['address_line1','unit','city','state','zip','parcel_id','lat','lng','notes','cover_url','display_name'];
  // Map legacy {name, address} onto {display_name, parsed parts}.
  if (req.body.name !== undefined && req.body.display_name === undefined) {
    req.body.display_name = req.body.name;
  }
  if (req.body.address !== undefined && req.body.address_line1 === undefined) {
    const parsed = parseFreetextAddress(req.body.address);
    req.body.address_line1 = parsed.address_line1;
    req.body.city          = parsed.city;
    req.body.state         = parsed.state;
    req.body.zip           = parsed.zip;
  }

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

    if (['address_line1','unit','city','state','zip'].some(k => req.body[k] !== undefined)) {
      const p = rows[0];
      const newNorm = normalizeAddress(p);
      await query(
        `UPDATE properties SET normalized_address = $1 WHERE id = $2`,
        [newNorm, p.id]
      );
      rows[0].normalized_address = newNorm;
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// DELETE removed — destructive deletes go through Prop Spot (owner-only).

module.exports = router;
