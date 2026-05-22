const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/folders/:propertyId ────────────────────────────────
router.get('/:propertyId', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        f.*,
        COUNT(ph.id)::int AS photo_count
      FROM folders f
      LEFT JOIN photos ph ON ph.folder_id = f.id
      WHERE f.property_id = $1
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.created_at ASC
    `, [req.params.propertyId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

// ── POST /api/folders/:propertyId ───────────────────────────────
// Body: { name } for single OR { names: ['Before','During','After'] } for bulk
router.post('/:propertyId', async (req, res) => {
  const { propertyId } = req.params;
  const { name, names } = req.body;

  // Build list of names to create
  let nameList = [];
  if (Array.isArray(names) && names.length > 0) {
    nameList = names.map(n => String(n).trim()).filter(Boolean);
  } else if (name && String(name).trim()) {
    nameList = [String(name).trim()];
  }

  if (nameList.length === 0) {
    return res.status(400).json({ error: 'Folder name(s) required' });
  }

  try {
    // Confirm property exists
    const { rows: propRows } = await query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if (!propRows[0]) return res.status(404).json({ error: 'Property not found' });

    // Get current max sort_order
    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(sort_order), -1)::int AS max_order FROM folders WHERE property_id = $1',
      [propertyId]
    );
    let sortOrder = maxRows[0].max_order + 1;

    const created = [];
    for (const folderName of nameList) {
      const { rows } = await query(`
        INSERT INTO folders (property_id, name, sort_order, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [propertyId, folderName, sortOrder++, req.userId]);
      created.push(rows[0]);
    }

    res.status(201).json(created.length === 1 ? created[0] : created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create folder(s)' });
  }
});

// ── PATCH /api/folders/:id ──────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Folder name is required' });

  try {
    const { rows } = await query(`
      UPDATE folders SET name = $1 WHERE id = $2 RETURNING *
    `, [name.trim(), req.params.id]);

    if (!rows[0]) return res.status(404).json({ error: 'Folder not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

// ── DELETE /api/folders/:id ─────────────────────────────────────
// Photos in this folder become unassigned (folder_id → NULL) via FK SET NULL
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT id FROM folders WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Folder not found' });

    await query('DELETE FROM folders WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

module.exports = router;
