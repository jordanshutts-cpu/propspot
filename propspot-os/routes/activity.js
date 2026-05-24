const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/activity?limit=50&entity_type=property&entity_id=<uuid>
router.get('/', async (req, res) => {
  const { limit = 50, entity_type, entity_id } = req.query;
  const where = []; const params = [];
  if (entity_type) { params.push(entity_type); where.push(`a.entity_type = $${params.length}`); }
  if (entity_id)   { params.push(entity_id);   where.push(`a.entity_id   = $${params.length}`); }
  params.push(Math.min(parseInt(limit) || 50, 200));
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    // Resolve the property associated with each activity row:
    //   - when entity_type = 'property', entity_id IS the property id
    //   - otherwise look for payload.property_id (every CRUD log
    //     populates this for prospect/lead/opp/purchase/project/photo/
    //     holding rows tied to a property)
    // Cast through ::text → ::uuid via a safe regex check so bad
    // payload values can't crash the query.
    const { rows } = await query(`
      SELECT a.*,
             u.full_name AS actor_name,
             u.email     AS actor_email,
             p.id        AS prop_id,
             p.display_name AS prop_display_name,
             p.address_line1 AS prop_address_line1,
             p.city      AS prop_city,
             p.state     AS prop_state
        FROM activity a
        LEFT JOIN users u ON u.id = a.actor_user_id
        LEFT JOIN properties p ON p.id = (
          CASE
            WHEN a.entity_type = 'property' THEN a.entity_id
            WHEN a.payload ? 'property_id'
                 AND (a.payload->>'property_id') ~ '^[0-9a-fA-F-]{36}$'
              THEN (a.payload->>'property_id')::uuid
          END
        )
        ${whereSQL}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('activity GET failed:', err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
