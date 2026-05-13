const express = require('express');
const { query } = require('../db');
const { requireAuth, requireWorkerOrAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// PATCH /api/tasks/:id  { done: bool }
router.patch('/:id', requireWorkerOrAdmin, async (req, res) => {
  const done = !!req.body.done;
  try {
    const t = await query(
      `SELECT t.id, v.assigned_to
         FROM maintenance_tasks t
         JOIN maintenance_visits v ON v.id = t.visit_id
        WHERE t.id = $1`,
      [req.params.id]
    );
    if (!t.rows[0]) return res.status(404).json({ error: 'Task not found' });
    if (t.rows[0].assigned_to !== req.userId && !req.user.is_owner) {
      return res.status(403).json({ error: 'Not your task' });
    }

    const { rows } = await query(
      `UPDATE maintenance_tasks
          SET done    = $2,
              done_at = CASE WHEN $2 THEN NOW() ELSE NULL END
        WHERE id = $1
        RETURNING *`,
      [req.params.id, done]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('toggle task:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

module.exports = router;
