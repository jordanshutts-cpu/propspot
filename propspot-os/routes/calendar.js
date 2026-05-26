const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/calendar?month=2026-05&visibility=company
//   or  /api/calendar?from=2026-04-26&to=2026-06-07  (preferred for grid views)
router.get('/', async (req, res) => {
  try {
    const { month, from, to, visibility } = req.query;
    let start, end;
    if (from && to) {
      start = from;
      end = to;
    } else if (month) {
      start = month + '-01';
      const d = new Date(start);
      d.setMonth(d.getMonth() + 1);
      end = d.toISOString().split('T')[0];
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      end = next.toISOString().split('T')[0];
    }

    let sql = `
      SELECT e.*, u.full_name AS created_by_name, p.address_line1 AS property_address
        FROM calendar_events e
        LEFT JOIN users u ON u.id = e.created_by
        LEFT JOIN properties p ON p.id = e.property_id
       WHERE e.start_at >= $1 AND e.start_at < $2
    `;
    const params = [start, end];

    if (visibility === 'personal') {
      params.push(req.userId);
      sql += ` AND e.visibility = 'personal' AND e.created_by = $${params.length}`;
    } else {
      params.push(req.userId);
      sql += ` AND (e.visibility = 'company' OR (e.visibility = 'personal' AND e.created_by = $${params.length}))`;
    }

    sql += ` ORDER BY e.start_at`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// POST /api/calendar
router.post('/', async (req, res) => {
  try {
    const { title, description, event_type, visibility, start_at, end_at, all_day, property_id } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!start_at) return res.status(400).json({ error: 'Start date is required' });

    const { rows: [event] } = await query(`
      INSERT INTO calendar_events (title, description, event_type, visibility, start_at, end_at, all_day, property_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [title.trim(), description || null, event_type || 'general', visibility || 'company', start_at, end_at || null, all_day || false, property_id || null, req.userId]);
    res.status(201).json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// PATCH /api/calendar/:id
router.patch('/:id', async (req, res) => {
  try {
    const { title, description, event_type, start_at, end_at, all_day, property_id } = req.body;
    const { rows: [event] } = await query(`
      UPDATE calendar_events SET
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        event_type = COALESCE($4, event_type),
        start_at = COALESCE($5, start_at),
        end_at = $6,
        all_day = COALESCE($7, all_day),
        property_id = $8
      WHERE id = $1 RETURNING *
    `, [req.params.id, title || null, description !== undefined ? description : null, event_type || null, start_at || null, end_at !== undefined ? end_at : null, all_day !== undefined ? all_day : null, property_id !== undefined ? property_id : null]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/calendar/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await query(`DELETE FROM calendar_events WHERE id = $1 AND created_by = $2`, [req.params.id, req.userId]);
    if (!rowCount) {
      await query(`DELETE FROM calendar_events WHERE id = $1`, [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

module.exports = router;
