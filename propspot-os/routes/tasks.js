const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// GET /api/tasks — list tasks (filterable by status, assigned_to, created_by)
router.get('/', async (req, res) => {
  try {
    const { status, assigned_to, created_by } = req.query;
    let sql = `
      SELECT t.*,
             u_creator.full_name AS created_by_name,
             u_assignee.full_name AS assigned_to_name,
             p.address_line1 AS property_address
        FROM tasks t
        LEFT JOIN users u_creator ON u_creator.id = t.created_by
        LEFT JOIN users u_assignee ON u_assignee.id = t.assigned_to
        LEFT JOIN properties p ON p.id = t.property_id
       WHERE (t.visibility = 'team' OR t.created_by = $1 OR t.assigned_to = $1)
    `;
    const params = [req.userId];
    if (status && status !== 'all') {
      params.push(status);
      sql += ` AND t.status = $${params.length}`;
    }
    if (assigned_to) {
      params.push(assigned_to);
      sql += ` AND t.assigned_to = $${params.length}`;
    }
    if (created_by) {
      params.push(created_by);
      sql += ` AND t.created_by = $${params.length}`;
    }
    if (req.query.visibility) {
      params.push(req.query.visibility);
      sql += ` AND t.visibility = $${params.length}`;
    }
    sql += ` ORDER BY
      CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      t.due_date ASC NULLS LAST,
      t.created_at DESC`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// GET /api/tasks/:id — single task with items, attachments, comments
router.get('/:id', async (req, res) => {
  try {
    const { rows: [task] } = await query(`
      SELECT t.*,
             u_creator.full_name AS created_by_name,
             u_creator.avatar_url AS created_by_avatar,
             u_assignee.full_name AS assigned_to_name,
             u_assignee.avatar_url AS assigned_to_avatar,
             p.address_line1 AS property_address
        FROM tasks t
        LEFT JOIN users u_creator ON u_creator.id = t.created_by
        LEFT JOIN users u_assignee ON u_assignee.id = t.assigned_to
        LEFT JOIN properties p ON p.id = t.property_id
       WHERE t.id = $1
    `, [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const [items, attachments, comments] = await Promise.all([
      query(`SELECT * FROM task_items WHERE task_id = $1 ORDER BY sort_order, created_at`, [task.id]),
      query(`
        SELECT ta.*, u.full_name AS uploaded_by_name
          FROM task_attachments ta
          LEFT JOIN users u ON u.id = ta.uploaded_by
         WHERE ta.task_id = $1
         ORDER BY ta.created_at DESC
      `, [task.id]),
      query(`
        SELECT tc.*, u.full_name AS user_name, u.avatar_url AS user_avatar
          FROM task_comments tc
          JOIN users u ON u.id = tc.user_id
         WHERE tc.task_id = $1
         ORDER BY tc.created_at ASC
      `, [task.id])
    ]);

    task.items = items.rows;
    task.attachments = attachments.rows;
    task.comments = comments.rows;
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get task' });
  }
});

// POST /api/tasks — create a task
router.post('/', async (req, res) => {
  try {
    const { title, description, priority, due_date, assigned_to, property_id, items, visibility } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });

    const { rows: [task] } = await query(`
      INSERT INTO tasks (title, description, priority, due_date, assigned_to, property_id, created_by, visibility)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [title.trim(), description || null, priority || 'normal', due_date || null, assigned_to || null, property_id || null, req.userId, visibility || 'team']);

    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].text && items[i].text.trim()) {
          await query(
            `INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)`,
            [task.id, items[i].text.trim(), i]
          );
        }
      }
    }

    await logActivity({
      actorUserId: req.userId, entityType: 'task', entityId: task.id,
      action: 'task_created', payload: { title: task.title, assigned_to }
    });

    res.status(201).json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/tasks/:id — update a task
router.patch('/:id', async (req, res) => {
  try {
    const { title, description, status, priority, due_date, assigned_to, property_id, visibility } = req.body;
    const { rows: [existing] } = await query(`SELECT * FROM tasks WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const { rows: [task] } = await query(`
      UPDATE tasks SET
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        status = COALESCE($4, status),
        priority = COALESCE($5, priority),
        due_date = $6,
        assigned_to = $7,
        property_id = $8,
        visibility = COALESCE($9, visibility),
        completed_at = CASE
          WHEN $4 = 'done' AND status != 'done' THEN NOW()
          WHEN $4 IS NOT NULL AND $4 != 'done' THEN NULL
          ELSE completed_at
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [req.params.id, title || null, description !== undefined ? description : null, status || null, priority || null, due_date !== undefined ? due_date : existing.due_date, assigned_to !== undefined ? assigned_to : existing.assigned_to, property_id !== undefined ? property_id : existing.property_id, visibility || null]);

    await logActivity({
      actorUserId: req.userId, entityType: 'task', entityId: task.id,
      action: 'task_updated', payload: { status, priority, assigned_to }
    });

    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows: [task] } = await query(`SELECT id, title FROM tasks WHERE id = $1`, [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Delete attachments from Cloudinary
    const { rows: attachments } = await query(`SELECT cloudinary_id FROM task_attachments WHERE task_id = $1`, [task.id]);
    for (const att of attachments) {
      if (att.cloudinary_id) {
        try { await cloudinary.uploader.destroy(att.cloudinary_id, { resource_type: 'raw' }); } catch {}
      }
    }

    await query(`DELETE FROM tasks WHERE id = $1`, [task.id]);
    await logActivity({
      actorUserId: req.userId, entityType: 'task', entityId: task.id,
      action: 'task_deleted', payload: { title: task.title }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ── Task Items (sub-bullets / requirements) ──────────────────────────

// POST /api/tasks/:id/items
router.post('/:id/items', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });
    const { rows: [item] } = await query(`
      INSERT INTO task_items (task_id, text, sort_order)
      VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order),0)+1 FROM task_items WHERE task_id = $1))
      RETURNING *
    `, [req.params.id, text.trim()]);
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// PATCH /api/tasks/:taskId/items/:itemId
router.patch('/:taskId/items/:itemId', async (req, res) => {
  try {
    const { text, is_done, sort_order } = req.body;
    const { rows: [item] } = await query(`
      UPDATE task_items SET
        text = COALESCE($3, text),
        is_done = COALESCE($4, is_done),
        sort_order = COALESCE($5, sort_order)
      WHERE id = $2 AND task_id = $1
      RETURNING *
    `, [req.params.taskId, req.params.itemId, text || null, is_done !== undefined ? is_done : null, sort_order !== undefined ? sort_order : null]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/tasks/:taskId/items/:itemId
router.delete('/:taskId/items/:itemId', async (req, res) => {
  try {
    await query(`DELETE FROM task_items WHERE id = $1 AND task_id = $2`, [req.params.itemId, req.params.taskId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ── Attachments ──────────────────────────────────────────────────────

// POST /api/tasks/:id/attachments — upload file
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [task] } = await query(`SELECT id FROM tasks WHERE id = $1`, [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: `propspot/tasks/${req.params.id}` },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    const taskItemId = req.body && req.body.task_item_id ? req.body.task_item_id : null;
    const { rows: [att] } = await query(`
      INSERT INTO task_attachments (task_id, task_item_id, filename, url, cloudinary_id, mime_type, size_bytes, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [req.params.id, taskItemId, req.file.originalname || 'upload', result.secure_url, result.public_id, req.file.mimetype || null, req.file.size || null, req.userId]);

    res.status(201).json(att);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload attachment' });
  }
});

// DELETE /api/tasks/:taskId/attachments/:attId
router.delete('/:taskId/attachments/:attId', async (req, res) => {
  try {
    const { rows: [att] } = await query(
      `SELECT cloudinary_id FROM task_attachments WHERE id = $1 AND task_id = $2`,
      [req.params.attId, req.params.taskId]
    );
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    if (att.cloudinary_id) {
      try { await cloudinary.uploader.destroy(att.cloudinary_id, { resource_type: 'raw' }); } catch {
        try { await cloudinary.uploader.destroy(att.cloudinary_id); } catch {}
      }
    }
    await query(`DELETE FROM task_attachments WHERE id = $1`, [req.params.attId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
});

// ── Comments ─────────────────────────────────────────────────────────

// POST /api/tasks/:id/comments
router.post('/:id/comments', async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body is required' });
    const { rows: [comment] } = await query(`
      INSERT INTO task_comments (task_id, user_id, body)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [req.params.id, req.userId, body.trim()]);

    // Parse @mentions — match "@Full Name" against users list
    const { rows: users } = await query(`SELECT id, full_name FROM users WHERE full_name IS NOT NULL`);
    const mentionedIds = [];
    for (const u of users) {
      if (u.full_name && body.includes('@' + u.full_name)) {
        mentionedIds.push(u.id);
      }
    }
    for (const uid of mentionedIds) {
      await query(
        `INSERT INTO task_mentions (comment_id, mentioned_user_id, task_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [comment.id, uid, req.params.id]
      );
    }

    const { rows: [withUser] } = await query(`
      SELECT tc.*, u.full_name AS user_name, u.avatar_url AS user_avatar
        FROM task_comments tc
        JOIN users u ON u.id = tc.user_id
       WHERE tc.id = $1
    `, [comment.id]);

    res.status(201).json(withUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

module.exports = router;
