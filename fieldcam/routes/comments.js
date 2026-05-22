const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/comments/mentions — comments that @mention the current user ──
router.get('/mentions', async (req, res) => {
  try {
    // Get current user's name to search for
    const { rows: me } = await query(
      'SELECT full_name FROM users WHERE id = $1', [req.userId]
    );
    const fullName = me[0]?.full_name;
    if (!fullName) return res.json([]);

    const { rows } = await query(`
      SELECT
        c.*,
        u.full_name  AS commenter_name,
        u.email      AS commenter_email,
        ph.url       AS photo_url,
        ph.id        AS photo_id,
        prop.id      AS property_id,
        prop.name    AS property_name
      FROM comments c
      JOIN users      u    ON u.id    = c.user_id
      JOIN photos     ph   ON ph.id   = c.photo_id
      JOIN properties prop ON prop.id = ph.property_id
      WHERE c.body ILIKE '%@' || $1 || '%'
        AND c.user_id != $2
      ORDER BY c.created_at DESC
      LIMIT 50
    `, [fullName, req.userId]);

    res.json(rows);
  } catch (err) {
    console.error('Mentions fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch mentions' });
  }
});

// ── GET /api/comments?photo_id=xxx ────────────────────────────
router.get('/', async (req, res) => {
  const { photo_id } = req.query;
  if (!photo_id) return res.status(400).json({ error: 'photo_id required' });
  try {
    const { rows } = await query(`
      SELECT c.*, u.full_name, u.email
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.photo_id = $1
      ORDER BY c.created_at ASC
    `, [photo_id]);
    res.json(rows);
  } catch (err) {
    console.error('Comments fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ── POST /api/comments ────────────────────────────────────────
router.post('/', async (req, res) => {
  const { photo_id, body } = req.body;
  if (!photo_id || !body?.trim()) {
    return res.status(400).json({ error: 'photo_id and body are required' });
  }
  try {
    // Confirm photo exists
    const { rows: photoRows } = await query(
      'SELECT id FROM photos WHERE id = $1', [photo_id]
    );
    if (!photoRows[0]) return res.status(404).json({ error: 'Photo not found' });

    const { rows } = await query(`
      INSERT INTO comments (photo_id, user_id, body)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [photo_id, req.userId, body.trim()]);

    // Return with user info joined
    const { rows: full } = await query(`
      SELECT c.*, u.full_name, u.email
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = $1
    `, [rows[0].id]);

    res.status(201).json(full[0]);
  } catch (err) {
    console.error('Comment create error:', err);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// ── DELETE /api/comments/:id ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM comments WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Comment not found' });
    if (rows[0].user_id !== req.userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    await query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Comment delete error:', err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

module.exports = router;
