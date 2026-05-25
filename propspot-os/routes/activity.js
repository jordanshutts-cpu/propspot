const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/activity
//   ?limit=50             (max 500)
//   &entity_type=property  (single, exact)
//   &entity_id=<uuid>      (single)
//   &actor=<uuid>          (single user id)
//   &action=updated        (single action verb)
//   &since=ISO8601         (created_at >= since)
//   &until=ISO8601         (created_at <= until)
router.get('/', async (req, res) => {
  const { limit = 50, entity_type, entity_id, actor, action, since, until } = req.query;
  const where = []; const params = [];
  if (entity_type) { params.push(entity_type); where.push(`a.entity_type = $${params.length}`); }
  if (entity_id)   { params.push(entity_id);   where.push(`a.entity_id   = $${params.length}`); }
  if (actor)       { params.push(actor);       where.push(`a.actor_user_id = $${params.length}`); }
  if (action)      { params.push(action);      where.push(`a.action      = $${params.length}`); }
  if (since)       { params.push(since);       where.push(`a.created_at >= $${params.length}`); }
  if (until)       { params.push(until);       where.push(`a.created_at <= $${params.length}`); }
  params.push(Math.min(parseInt(limit) || 50, 500));
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

// GET /api/activity/insights — bird's-eye stats for the Activity Monitor.
//   Returns totals + breakdowns over a date window (default last 30 days):
//   { window: { since, until }, total, by_user[], by_action[],
//     by_entity[], by_day[], top_properties[] }
router.get('/insights', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const [total, byUser, byAction, byEntity, byDay, topProps] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM activity WHERE created_at >= $1`, [since]),
      query(`
        SELECT a.actor_user_id AS user_id,
               COALESCE(u.full_name, u.email, 'System') AS name,
               COUNT(*)::int AS n
          FROM activity a
          LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.created_at >= $1
         GROUP BY a.actor_user_id, u.full_name, u.email
         ORDER BY n DESC
         LIMIT 12
      `, [since]),
      query(`
        SELECT action, COUNT(*)::int AS n
          FROM activity
         WHERE created_at >= $1
         GROUP BY action
         ORDER BY n DESC
      `, [since]),
      query(`
        SELECT entity_type, COUNT(*)::int AS n
          FROM activity
         WHERE created_at >= $1
         GROUP BY entity_type
         ORDER BY n DESC
      `, [since]),
      query(`
        SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS n
          FROM activity
         WHERE created_at >= $1
         GROUP BY day
         ORDER BY day
      `, [since]),
      query(`
        SELECT p.id, p.display_name, p.address_line1, p.city, p.state,
               COUNT(*)::int AS n
          FROM activity a
          JOIN properties p ON p.id = (
            CASE
              WHEN a.entity_type = 'property' THEN a.entity_id
              WHEN a.payload ? 'property_id'
                   AND (a.payload->>'property_id') ~ '^[0-9a-fA-F-]{36}$'
                THEN (a.payload->>'property_id')::uuid
            END
          )
         WHERE a.created_at >= $1
         GROUP BY p.id, p.display_name, p.address_line1, p.city, p.state
         ORDER BY n DESC
         LIMIT 10
      `, [since])
    ]);

    res.json({
      window: { since, days },
      total: total.rows[0]?.n || 0,
      by_user:        byUser.rows,
      by_action:      byAction.rows,
      by_entity:      byEntity.rows,
      by_day:         byDay.rows,
      top_properties: topProps.rows
    });
  } catch (err) {
    console.error('activity insights GET failed:', err);
    res.status(500).json({ error: 'Failed to compute activity insights' });
  }
});

module.exports = router;
