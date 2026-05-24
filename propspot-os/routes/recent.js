// ============================================================
//  Prop Spot — Recent properties (new-chrome Phase 2)
//  Read-only; writes happen as a side-effect inside
//  GET /api/properties/:id (see touchRecent helper).
// ============================================================

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/recent — last 5 properties this user visited (most recent first)
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.id, p.display_name, p.address_line1, p.unit, p.city, p.state, p.zip,
             p.status, p.acquisition_status,
             rp.visited_at
        FROM recent_properties rp
        JOIN properties p ON p.id = rp.property_id
       WHERE rp.user_id = $1
       ORDER BY rp.visited_at DESC
       LIMIT 5
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recent properties' });
  }
});

// Helper used by routes/properties.js whenever a single property
// is fetched. Fire-and-forget — never fails the parent request.
async function touchRecent(userId, propertyId) {
  if (!userId || !propertyId) return;
  try {
    await query(`
      INSERT INTO recent_properties (user_id, property_id, visited_at)
      VALUES ($1, $2, now())
      ON CONFLICT (user_id, property_id)
        DO UPDATE SET visited_at = EXCLUDED.visited_at
    `, [userId, propertyId]);
  } catch (err) {
    // Recent tracking is best-effort — don't surface errors.
    console.warn('touchRecent failed:', err.message);
  }
}

module.exports = router;
module.exports.touchRecent = touchRecent;
