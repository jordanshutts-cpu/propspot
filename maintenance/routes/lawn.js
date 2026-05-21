const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireMaintenanceGrant } = require('../middleware/auth');
const { scopedPropertyIds } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireMaintenanceGrant);

// Append an activity row in propspot-os's shared `activity` table.
// Best-effort — failures here should not block the user action.
async function logActivity({ actorUserId, entityType, entityId, action, payload }) {
  try {
    await query(
      `INSERT INTO activity (actor_user_id, entity_type, entity_id, action, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorUserId, entityType, entityId, action, payload ? JSON.stringify(payload) : null]
    );
  } catch (err) {
    console.error('activity log failed', err);
  }
}

// ── GET /api/lawn ────────────────────────────────────────────────
// Returns one row per visible property. A property is "visible" when:
//   enabled_mode = 'force_on', OR
//   (enabled_mode = 'auto' OR no row exists) AND status is an active
//   holdings state (excluding 'rented'/'renting' — tenant in place).
router.get('/', async (req, res) => {
  try {
    const allowedIds = await scopedPropertyIds(req.maintenanceGrant.scope);

    const where = [
      `COALESCE(lm.enabled_mode, 'auto') != 'force_off'`,
      `(COALESCE(lm.enabled_mode, 'auto') = 'force_on'
        OR p.status IN ('renovating','listed_for_rent','listed_for_sale','under_contract_buyer'))`
    ];
    const params = [];
    let i = 1;
    if (allowedIds !== null) {
      if (!allowedIds.length) return res.json([]);
      params.push(allowedIds);
      where.unshift(`p.id = ANY($${i++}::uuid[])`);
    }

    const sql = `
      SELECT p.id, p.address_line1, p.unit, p.city, p.state, p.zip,
             p.lat, p.lng, p.lockbox_code, p.status, p.display_name,
             COALESCE(lm.enabled_mode, 'auto') AS enabled_mode,
             lm.assigned_user_id, lm.frequency_days,
             lm.last_mowed_at, lm.last_mowed_by,
             lm.last_checked_in_at, lm.last_checked_in_by,
             lm.last_checked_in_lat, lm.last_checked_in_lng,
             lm.sign_for_sale, lm.sign_for_rent,
             lm.route_position, lm.notes,
             u.full_name   AS assigned_user_name,
             lmu.full_name AS last_mowed_by_name,
             ciu.full_name AS last_checked_in_by_name,
             (lm.last_mowed_at IS NULL
              OR lm.last_mowed_at < NOW() - (COALESCE(lm.frequency_days, 14) || ' days')::interval)
               AS overdue,
             (SELECT COUNT(*) FROM photos
                WHERE property_id = p.id
                  AND lm.last_mowed_at IS NOT NULL
                  AND created_at >= lm.last_mowed_at)::int AS photos_since_last_mow
        FROM properties p
        LEFT JOIN lawn_maintenance lm  ON lm.property_id = p.id
        LEFT JOIN users u              ON u.id           = lm.assigned_user_id
        LEFT JOIN users lmu            ON lmu.id         = lm.last_mowed_by
        LEFT JOIN users ciu            ON ciu.id         = lm.last_checked_in_by
       WHERE ${where.join(' AND ')}
       ORDER BY lm.route_position NULLS LAST, p.address_line1
    `;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lawn list' });
  }
});

// ── POST /api/lawn/:property_id/mowed ───────────────────────────
router.post('/:property_id/mowed', async (req, res) => {
  try {
    const { rows } = await query(`
      INSERT INTO lawn_maintenance (property_id, last_mowed_at, last_mowed_by, updated_at)
      VALUES ($1, NOW(), $2, NOW())
      ON CONFLICT (property_id) DO UPDATE
        SET last_mowed_at = NOW(),
            last_mowed_by = $2,
            updated_at    = NOW()
      RETURNING property_id, last_mowed_at, last_mowed_by
    `, [req.params.property_id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: req.params.property_id,
      action: 'mowed', payload: null
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark mowed' });
  }
});

// ── POST /api/lawn/:property_id/checkin ─────────────────────────
// Body: { lat?, lng? }. Records arrival. Lat/lng optional — silently
// stored if the browser granted geolocation, omitted otherwise.
router.post('/:property_id/checkin', async (req, res) => {
  const lat = req.body?.lat != null && req.body.lat !== '' ? parseFloat(req.body.lat) : null;
  const lng = req.body?.lng != null && req.body.lng !== '' ? parseFloat(req.body.lng) : null;
  try {
    const { rows } = await query(`
      INSERT INTO lawn_maintenance (property_id, last_checked_in_at, last_checked_in_by,
                                    last_checked_in_lat, last_checked_in_lng, updated_at)
      VALUES ($1, NOW(), $2, $3, $4, NOW())
      ON CONFLICT (property_id) DO UPDATE
        SET last_checked_in_at  = NOW(),
            last_checked_in_by  = $2,
            last_checked_in_lat = $3,
            last_checked_in_lng = $4,
            updated_at          = NOW()
      RETURNING property_id, last_checked_in_at, last_checked_in_by, last_checked_in_lat, last_checked_in_lng
    `, [req.params.property_id, req.userId, lat, lng]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: req.params.property_id,
      action: 'checked_in', payload: lat != null && lng != null ? { lat, lng } : null
    });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

// ── PATCH /api/lawn/:property_id ────────────────────────────────
// Upserts the lawn_maintenance row with allowlisted fields. Creates
// a row if none exists so any setting (e.g. enabled_mode override)
// gets persisted.
router.patch('/:property_id', async (req, res) => {
  const allowed = ['enabled_mode','assigned_user_id','frequency_days',
                   'sign_for_sale','sign_for_rent','notes'];
  const cols = ['property_id'];
  const placeholders = ['$1'];
  const updates = [];
  const vals = [req.params.property_id];
  let i = 2;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      cols.push(k);
      placeholders.push(`$${i}`);
      updates.push(`${k} = EXCLUDED.${k}`);
      vals.push(req.body[k] === '' ? null : req.body[k]);
      i++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });

  try {
    const sql = `
      INSERT INTO lawn_maintenance (${cols.join(', ')}, updated_at)
      VALUES (${placeholders.join(', ')}, NOW())
      ON CONFLICT (property_id) DO UPDATE
        SET ${updates.join(', ')}, updated_at = NOW()
      RETURNING *
    `;
    const { rows } = await query(sql, vals);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lawn record' });
  }
});

// ── POST /api/lawn/route ────────────────────────────────────────
// Body: { order: [property_id, property_id, ...] }. Sets route_position
// 1..N for the listed properties and clears it for any other rows.
// Atomic — single transaction.
router.post('/route', async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'order array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear positions on rows that EXIST and aren't in the new order.
    if (order.length) {
      await client.query(
        `UPDATE lawn_maintenance
            SET route_position = NULL, updated_at = NOW()
          WHERE route_position IS NOT NULL
            AND property_id <> ALL($1::uuid[])`,
        [order]
      );
    } else {
      await client.query(
        `UPDATE lawn_maintenance SET route_position = NULL, updated_at = NOW()
          WHERE route_position IS NOT NULL`
      );
    }

    // Upsert each listed property with its new position.
    for (let idx = 0; idx < order.length; idx++) {
      await client.query(
        `INSERT INTO lawn_maintenance (property_id, route_position, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (property_id) DO UPDATE
           SET route_position = $2, updated_at = NOW()`,
        [order[idx], idx + 1]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, count: order.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to save route' });
  } finally {
    client.release();
  }
});

module.exports = router;
