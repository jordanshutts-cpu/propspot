// ============================================================
//  Prop Spot — Pinned properties (new-chrome Phase 2)
//  Per-user pinning that powers the sidebar's "Pinned" zone.
//  Returns full property rows (joined) so the sidebar can show
//  address + status without a second round-trip.
// ============================================================

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/pinned — list this user's pinned properties (ordered)
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.id, p.display_name, p.address_line1, p.unit, p.city, p.state, p.zip,
             p.status, p.acquisition_status,
             pp.pinned_at, pp.position
        FROM pinned_properties pp
        JOIN properties p ON p.id = pp.property_id
       WHERE pp.user_id = $1
       ORDER BY pp.position ASC, pp.pinned_at DESC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load pinned properties' });
  }
});

// POST /api/pinned — pin a property (idempotent)
//   body: { property_id }
router.post('/', async (req, res) => {
  const propertyId = req.body?.property_id;
  if (!propertyId) return res.status(400).json({ error: 'property_id required' });
  try {
    await query(`
      INSERT INTO pinned_properties (user_id, property_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, property_id) DO NOTHING
    `, [req.userId, propertyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to pin property' });
  }
});

// DELETE /api/pinned/:propertyId — unpin
router.delete('/:propertyId', async (req, res) => {
  try {
    await query(`
      DELETE FROM pinned_properties
       WHERE user_id = $1 AND property_id = $2
    `, [req.userId, req.params.propertyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unpin property' });
  }
});

module.exports = router;
