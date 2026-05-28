const express = require('express');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { normalizeAddress, parseFreetextAddress } = require('../../lib/address');
const { propertyFilterSql } = require('../../lib/property-access');

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

    // last_activity_at = most recent photo upload (taken_at preferred,
    // falls back to created_at) for that property, ignoring trashed photos.
    // Properties with no photos sort by their own updated_at/created_at so
    // newly-created properties still appear near the top until something
    // happens at them.
    const baseSelect = `
      SELECT ${SELECT_FIELDS},
             (SELECT COUNT(*) FROM photos
                WHERE property_id = p.id AND deleted_at IS NULL)::int AS photo_count,
             (SELECT url FROM photos
                WHERE property_id = p.id AND deleted_at IS NULL AND media_type = 'image'
                ORDER BY COALESCE(taken_at, created_at) DESC LIMIT 1) AS latest_photo_url,
             COALESCE(
               (SELECT MAX(COALESCE(taken_at, created_at)) FROM photos
                  WHERE property_id = p.id AND deleted_at IS NULL),
               p.updated_at,
               p.created_at
             ) AS last_activity_at
        FROM properties p
        LEFT JOIN users u ON u.id = p.created_by
    `;

    // Centralized visibility filter:
    //   • Owner                → no filter (sees all)
    //   • Team member          → unrestricted + listed restricted (team-rows only count as restricting)
    //   • External worker      → ONLY properties they have an explicit
    //                            property_access row for
    const filter = await propertyFilterSql(req.userId, 'p.id');
    let sql, params;
    if (!filter) {
      sql = baseSelect + ' ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC';
      params = [];
    } else {
      sql = baseSelect + ' WHERE ' + filter.sql +
            ' ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC';
      params = [filter.param];
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
// Dedup strategy (three layers):
//   1. Exact normalized_address match — same address, unit, city, state, zip
//   2. Fuzzy match — same street line + city + state, ignoring zip/unit variance
//      (catches '00000' zip fallbacks from CSV imports vs real zips)
//   3. ON CONFLICT DO NOTHING + re-select — closes the race-condition window
//      between the pre-insert check and the actual INSERT
const VALID_STATUSES = ['prospect','purchasing','renovating','selling','renting','rented','sold','dropped','assigned','listed_for_rent','listed_for_sale','under_contract_buyer'];

router.post('/', async (req, res) => {
  const { name, address, notes, lat, lng, status } = req.body;
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

  // Normalised street line only (no unit / zip) — used for fuzzy fallback
  const normLine = normalizeAddress({ address_line1, unit: '', city: '', state: '', zip: '' })
    .split('|')[0];

  try {
    // ── Layer 1: exact normalized_address match ──────────────────
    const { rows: exact } = await query(
      `SELECT ${SELECT_FIELDS}
         FROM properties p
         LEFT JOIN users u ON u.id = p.created_by
        WHERE p.normalized_address = $1`,
      [normalized]
    );
    if (exact[0]) return res.status(200).json(exact[0]);

    // ── Layer 2: fuzzy match (same street + city + state) ────────
    // Catches cases where zip differs (e.g. '00000' default vs real zip)
    // or unit was omitted in one version of the address.
    if (normLine && city && state) {
      const { rows: fuzzy } = await query(
        `SELECT ${SELECT_FIELDS}
           FROM properties p
           LEFT JOIN users u ON u.id = p.created_by
          WHERE SPLIT_PART(p.normalized_address, '|', 1) = $1
            AND UPPER(TRIM(p.city))  = $2
            AND UPPER(TRIM(p.state)) = $3
          LIMIT 1`,
        [normLine, city.trim().toUpperCase(), state.trim().toUpperCase()]
      );
      if (fuzzy[0]) {
        console.log(`[properties] fuzzy dedup: "${normalized}" → existing id ${fuzzy[0].id}`);
        return res.status(200).json(fuzzy[0]);
      }
    }

    // ── Layer 3: atomic upsert — closes the race-condition window ─
    // If two concurrent requests both pass the checks above, the DB
    // UNIQUE constraint on normalized_address fires. ON CONFLICT DO
    // NOTHING suppresses the error; we then re-select the winner.
    const insertStatus = VALID_STATUSES.includes(status) ? status : 'purchasing';
    const { rows: inserted } = await query(`
      INSERT INTO properties
        (address_line1, unit, city, state, zip, normalized_address, parcel_id,
         lat, lng, notes, display_name, created_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (normalized_address) DO NOTHING
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
      req.userId,
      insertStatus
    ]);

    if (inserted[0]) return res.status(201).json(inserted[0]);

    // ON CONFLICT path: another concurrent request beat us — return theirs
    const { rows: winner } = await query(
      `SELECT ${SELECT_FIELDS}
         FROM properties p
         LEFT JOIN users u ON u.id = p.created_by
        WHERE p.normalized_address = $1`,
      [normalized]
    );
    return res.status(200).json(winner[0]);

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
