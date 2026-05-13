const express    = require('express');
const cloudinary = require('cloudinary').v2;
const { query }  = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/trash/:propertyId — list trashed photos ──────────
router.get('/:propertyId', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        ph.*,
        u.full_name  AS uploader_name,
        u.email      AS uploader_email,
        f.name       AS folder_name
      FROM photos ph
      LEFT JOIN users   u ON u.id = ph.uploaded_by
      LEFT JOIN folders f ON f.id = ph.folder_id
      WHERE ph.property_id = $1
        AND ph.deleted_at IS NOT NULL
      ORDER BY ph.deleted_at DESC
    `, [req.params.propertyId]);
    res.json(rows);
  } catch (err) {
    console.error('Trash fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch trash' });
  }
});

// ── POST /api/trash/:photoId/restore — restore from trash ──────
router.post('/:photoId/restore', async (req, res) => {
  try {
    const { rows } = await query(
      'UPDATE photos SET deleted_at = NULL WHERE id = $1 RETURNING *',
      [req.params.photoId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Photo not found' });

    // Re-set cover_url if no active cover exists for the property
    const { rows: cover } = await query(
      `SELECT cover_url FROM properties WHERE id = $1`, [rows[0].property_id]
    );
    if (!cover[0]?.cover_url && rows[0].media_type !== 'video') {
      await query(
        'UPDATE properties SET cover_url = $1, updated_at = NOW() WHERE id = $2',
        [rows[0].url, rows[0].property_id]
      );
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Failed to restore photo' });
  }
});

// ── DELETE /api/trash/:photoId — permanently delete ────────────
router.delete('/:photoId', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM photos WHERE id = $1 AND deleted_at IS NOT NULL',
      [req.params.photoId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Photo not found in trash' });

    const photo = rows[0];

    // Destroy from Cloudinary
    if (photo.cloudinary_id) {
      const resourceType = photo.media_type === 'video' ? 'video' : 'image';
      await cloudinary.uploader.destroy(photo.cloudinary_id, { resource_type: resourceType })
        .catch(e => console.warn('Cloudinary delete warning:', e.message));
    }

    // Hard-delete from DB
    await query('DELETE FROM photos WHERE id = $1', [photo.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Permanent delete error:', err);
    res.status(500).json({ error: 'Failed to permanently delete photo' });
  }
});

// ── DELETE /api/trash/empty/:propertyId — empty entire trash ───
router.delete('/empty/:propertyId', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM photos WHERE property_id = $1 AND deleted_at IS NOT NULL',
      [req.params.propertyId]
    );

    // Destroy all Cloudinary assets in parallel
    await Promise.all(rows.map(photo => {
      if (!photo.cloudinary_id) return Promise.resolve();
      const resourceType = photo.media_type === 'video' ? 'video' : 'image';
      return cloudinary.uploader.destroy(photo.cloudinary_id, { resource_type: resourceType })
        .catch(e => console.warn('Cloudinary delete warning:', e.message));
    }));

    // Hard-delete all from DB
    const { rowCount } = await query(
      'DELETE FROM photos WHERE property_id = $1 AND deleted_at IS NOT NULL',
      [req.params.propertyId]
    );

    res.json({ success: true, deleted: rowCount });
  } catch (err) {
    console.error('Empty trash error:', err);
    res.status(500).json({ error: 'Failed to empty trash' });
  }
});

module.exports = router;
