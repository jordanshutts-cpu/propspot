const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/task-projects
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT tp.*,
             u.full_name AS created_by_name,
             (SELECT COUNT(*)::int FROM tasks WHERE project_id = tp.id AND status != 'cancelled') AS task_count,
             (SELECT COUNT(*)::int FROM tasks WHERE project_id = tp.id AND status = 'done') AS done_count
        FROM task_projects tp
        LEFT JOIN users u ON u.id = tp.created_by
       WHERE tp.visibility = 'team' OR tp.created_by = $1
       ORDER BY tp.sort_order, tp.created_at
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// POST /api/task-projects
router.post('/', async (req, res) => {
  try {
    const { name, description, color, visibility } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows: [maxOrder] } = await query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM task_projects`);
    const { rows: [project] } = await query(`
      INSERT INTO task_projects (name, description, color, visibility, sort_order, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name.trim(), description || null, color || '#2563eb', visibility || 'team', maxOrder.next, req.userId]);
    res.status(201).json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// PATCH /api/task-projects/:id
router.patch('/:id', async (req, res) => {
  try {
    const { name, description, color, visibility, sort_order } = req.body;
    const { rows: [project] } = await query(`
      UPDATE task_projects SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        color = COALESCE($4, color),
        visibility = COALESCE($5, visibility),
        sort_order = COALESCE($6, sort_order)
      WHERE id = $1 RETURNING *
    `, [req.params.id, name || null, description !== undefined ? description : null, color || null, visibility || null, sort_order !== undefined ? sort_order : null]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/task-projects/:id — unlinks tasks (doesn't delete them)
router.delete('/:id', async (req, res) => {
  try {
    await query(`UPDATE tasks SET project_id = NULL WHERE project_id = $1`, [req.params.id]);
    await query(`DELETE FROM task_projects WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

module.exports = router;
