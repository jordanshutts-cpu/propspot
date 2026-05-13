const express = require('express');
const crypto  = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/share/:token — PUBLIC ──────────────────────────────
// Must be declared before requireAuth middleware so it's accessible without auth
router.get('/:token', async (req, res) => {
  // Skip if token looks like a query-string route (handled below)
  const { token } = req.params;
  if (!token || token.length < 10) {
    return res.status(404).json({ error: 'Invalid share link' });
  }

  try {
    const { rows: linkRows } = await query(`
      SELECT sl.*, p.name AS property_name, p.address, p.notes,
             f.name AS folder_name
      FROM share_links sl
      JOIN properties p ON p.id = sl.property_id
      LEFT JOIN folders f ON f.id = sl.folder_id
      WHERE sl.token = $1
    `, [token]);

    if (!linkRows[0]) return res.status(404).json({ error: 'Share link not found or expired' });
    const link = linkRows[0];

    // Fetch folders for this property
    const { rows: folderRows } = await query(`
      SELECT f.*, COUNT(ph.id)::int AS photo_count
      FROM folders f
      LEFT JOIN photos ph ON ph.folder_id = f.id
      WHERE f.property_id = $1
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.created_at ASC
    `, [link.property_id]);

    // Fetch photos — filtered by folder if the link has a folder_id
    let photoQuery, photoParams;
    if (link.folder_id) {
      photoQuery = `
        SELECT ph.*, f.name AS folder_name
        FROM photos ph
        LEFT JOIN folders f ON f.id = ph.folder_id
        WHERE ph.property_id = $1 AND ph.folder_id = $2
        ORDER BY ph.taken_at DESC
      `;
      photoParams = [link.property_id, link.folder_id];
    } else {
      photoQuery = `
        SELECT ph.*, f.name AS folder_name
        FROM photos ph
        LEFT JOIN folders f ON f.id = ph.folder_id
        WHERE ph.property_id = $1
        ORDER BY ph.taken_at DESC
      `;
      photoParams = [link.property_id];
    }

    const { rows: photoRows } = await query(photoQuery, photoParams);

    res.json({
      property: {
        id:      link.property_id,
        name:    link.property_name,
        address: link.address,
        notes:   link.notes
      },
      folder:  link.folder_id ? { id: link.folder_id, name: link.folder_name } : null,
      folders: folderRows,
      photos:  photoRows,
      label:   link.label
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load share link' });
  }
});

// All routes below this point require authentication
router.use(requireAuth);

// ── GET /api/share?propertyId=xxx ───────────────────────────────
// List share links for a property
router.get('/', async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId query param required' });

  try {
    const { rows } = await query(`
      SELECT sl.*, f.name AS folder_name
      FROM share_links sl
      LEFT JOIN folders f ON f.id = sl.folder_id
      WHERE sl.property_id = $1
      ORDER BY sl.created_at DESC
    `, [propertyId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch share links' });
  }
});

// ── POST /api/share ──────────────────────────────────────────────
// Create a new share link; body: { propertyId, folderId?, label? }
router.post('/', async (req, res) => {
  const { propertyId, folderId, label } = req.body;
  if (!propertyId) return res.status(400).json({ error: 'propertyId is required' });

  try {
    const token = crypto.randomBytes(16).toString('hex');
    const { rows } = await query(`
      INSERT INTO share_links (token, property_id, folder_id, label, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [token, propertyId, folderId || null, label || null, req.userId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// ── DELETE /api/share/:token ─────────────────────────────────────
// Revoke a share link; only the creator can revoke
router.delete('/:token', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM share_links WHERE token = $1', [req.params.token]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Share link not found' });
    if (rows[0].created_by !== req.userId) {
      return res.status(403).json({ error: 'Only the creator can revoke this link' });
    }

    await query('DELETE FROM share_links WHERE token = $1', [req.params.token]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
});

module.exports = router;
