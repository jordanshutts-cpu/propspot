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
    const { rows } = await query(`
      SELECT a.*, u.full_name AS actor_name, u.email AS actor_email
        FROM activity a
        LEFT JOIN users u ON u.id = a.actor_user_id
        ${whereSQL}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
