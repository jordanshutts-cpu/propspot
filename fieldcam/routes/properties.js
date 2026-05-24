const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizeAddress, parseFreetextAddress } = require('../lib/address');

const router = express.Router();
router.use(requireAuth);

// Computed-alias view: surface FieldCam-shaped `name` and `address` fields
// alongside Prop Spot's structured columns so the existing UI keeps working
// without page edits. `name` falls back to address_line1 when display_name
// is empty (bulk-added properties have no nickname).
const SELECT_FIELDS = `
  p.*,
  COALESCE(NULLIF(p.display_name, ''), p.address_line1) AS name,
  NULLIF(CONCAT_WS(', ',
    NULLIF(p.address_line1, ''),
    NULLIF(p.city, ''),
    CONCAT_WS(' ', NULLIF(p.state, ''), NULLIF(p.zip, ''))
  ), '') AS address,
  u.full_name AS created_by_name
`;

// Prop Spot uses users.is_owner BOOLEAN as the global-admin signal.
async function getIsAdmin(userId) {
  const { rows } = await query('SELECT is_owner FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_owner === true;
}

// GET /api/properties
router.get('/', async (req, res) => {
  try {
    const isAdmin = await getIsAdmin(req.userId);

    const baseSelect = `
      SELECT ${SELECT_FIELDS},
             (SELECT COUNT(*) FROM photos
                WHERE property_id = p.id AND deleted_at IS NULL)::int AS photo_count,
             (SELECT url FROM photos
                WHERE property_id = p.id AND deleted_at IS NULL AND media_type = 'image'
                ORDER BY COALESCE(taken_at, created_at) DESC LIMIT 1) AS latest_photo_url
        FROM properties p
        LEFT JOIN users u ON u.id = p.created_by
    `;

    let sql, params;
    if (isAdmin) {
      sql = baseSelect + ' ORDER BY p.created_at DESC';
      params = [];
    } else {
      // Restricted properties (those with any property_access rows) are
      // only visible to listed users. Unrestricted properties are public
      // within the org.
      sql = baseSelect + `
        WHERE NOT EXISTS (SELECT 1 FROM property_access pa WHERE pa.property_id = p.id)
           OR EXISTS (SELECT 1 FROM property_access pa
                       WHERE pa.property_id = p.id AND pa.user_id = $1)
        ORDER BY p.created_at DESC
      `;
      params = [req.userId];
    }

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// GET /api/properties/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ${SELECT_FIELDS},
             (SELECT COUNT(*) FROM photos
                WHERE property_id = p.id AND deleted_at IS NULL)::int AS photo_count
        FROM properties p
        LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

// POST /api/properties
// Accepts either FieldCam-legacy {name, address} or Prop Spot structured fields.
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
      `SELECT ${SELECT_FIELDS}
         FROM properties p
         LEFT JOIN users u ON u.id = p.created_by
        WHERE p.normalized_address = $1`,
      [normalized]
    );
    if (existing[0]) {
      // Return existing so the UI can offer "use existing" instead of bouncing.
      return res.status(200).json(existing[0]);
    }

    const { rows } = await query(`
      INSERT INTO properties
        (address_line1, unit, city, state, zip, normalized_address, parcel_id,
         lat, lng, notes, display_name, created_by)
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
  try {
    const { rows: existing } = await query(
      'SELECT created_by FROM properties WHERE id = $1', [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Property not found' });

    const isAdmin = await getIsAdmin(req.userId);
    if (!isAdmin && existing[0].created_by !== req.userId) {
      return res.status(403).json({ error: 'Only an admin or the property creator can edit it' });
    }

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

    const allowed = ['address_line1','unit','city','state','zip','parcel_id','lat','lng','notes','cover_url','display_name'];
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

    const { rows } = await query(
      `UPDATE properties SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${i} RETURNING *`,
      vals
    );

    if (['address_line1','unit','city','state','zip'].some(k => req.body[k] !== undefined)) {
      const p = rows[0];
      const newNorm = normalizeAddress(p);
      await query(`UPDATE properties SET normalized_address = $1 WHERE id = $2`, [newNorm, p.id]);
      rows[0].normalized_address = newNorm;
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// DELETE /api/properties/:id — admin only (delegates to Prop Spot policy).
router.delete('/:id', async (req, res) => {
  try {
    const isAdmin = await getIsAdmin(req.userId);
    if (!isAdmin) return res.status(403).json({ error: 'Only an admin can delete properties — do it from Prop Spot' });
    await query('DELETE FROM properties WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete property' });
  }
});

module.exports = router;
