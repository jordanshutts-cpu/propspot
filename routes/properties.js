const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/properties ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // Get current user's role
    const { rows: userRows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    const role = userRows[0]?.role || 'member';

    let sql;
    let params;

    if (role === 'admin') {
      // Admins see all properties
      sql = `
        SELECT
          p.*,
          u.full_name AS created_by_name,
          COUNT(ph.id)::int AS photo_count
        FROM properties p
        LEFT JOIN users u   ON u.id = p.created_by
        LEFT JOIN photos ph ON ph.property_id = p.id
        GROUP BY p.id, u.full_name
        ORDER BY p.created_at DESC
      `;
      params = [];
    } else {
      // Non-admins see properties that are unrestricted OR where they have explicit access
      sql = `
        SELECT
          p.*,
          u.full_name AS created_by_name,
          COUNT(ph.id)::int AS photo_count
        FROM properties p
        LEFT JOIN users u   ON u.id = p.created_by
        LEFT JOIN photos ph ON ph.property_id = p.id
        WHERE
          NOT EXISTS (
            SELECT 1 FROM property_access pa WHERE pa.property_id = p.id
          )
          OR EXISTS (
            SELECT 1 FROM property_access pa
            WHERE pa.property_id = p.id AND pa.user_id = $1
          )
        GROUP BY p.id, u.full_name
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

// ── GET /api/properties/:id ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.*, u.full_name AS created_by_name,
             COUNT(ph.id)::int AS photo_count
      FROM properties p
      LEFT JOIN users u   ON u.id = p.created_by
      LEFT JOIN photos ph ON ph.property_id = p.id
      WHERE p.id = $1
      GROUP BY p.id, u.full_name
    `, [req.params.id]);

    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

// ── POST /api/properties ────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, address, notes, lat, lng } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Property name is required' });

  try {
    const { rows } = await query(`
      INSERT INTO properties (name, address, notes, lat, lng, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      name.trim(),
      address?.trim() || null,
      notes?.trim()   || null,
      lat  ? parseFloat(lat)  : null,
      lng  ? parseFloat(lng)  : null,
      req.userId
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create property' });
  }
});

// ── PATCH /api/properties/:id ───────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { name, address, notes, lat, lng } = req.body;

  try {
    // Admins can edit any property; others only their own
    const { rows: existing } = await query(
      'SELECT * FROM properties WHERE id = $1', [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Property not found' });

    const { rows: userRows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    const isAdmin = userRows[0]?.role === 'admin';

    if (!isAdmin && existing[0].created_by !== req.userId) {
      return res.status(403).json({ error: 'Only an admin or the property creator can edit it' });
    }

    const { rows } = await query(`
      UPDATE properties SET
        name       = COALESCE($1, name),
        address    = COALESCE($2, address),
        notes      = COALESCE($3, notes),
        lat        = COALESCE($4, lat),
        lng        = COALESCE($5, lng),
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [
      name?.trim()    || null,
      address?.trim() || null,
      notes?.trim()   || null,
      lat  ? parseFloat(lat)  : null,
      lng  ? parseFloat(lng)  : null,
      req.params.id
    ]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// ── DELETE /api/properties/:id ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT created_by FROM properties WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });

    const { rows: userRows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    const isAdmin = userRows[0]?.role === 'admin';

    if (!isAdmin && rows[0].created_by !== req.userId) {
      return res.status(403).json({ error: 'Only an admin or the property creator can delete it' });
    }

    await query('DELETE FROM properties WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete property' });
  }
});

module.exports = router;
