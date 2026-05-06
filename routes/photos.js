const express    = require('express');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { query }  = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Store uploads in memory before streaming to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB (supports video)
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
      return cb(new Error('Only image and video files are allowed'));
    }
    cb(null, true);
  }
});

// Upload buffer to Cloudinary using a stream
function uploadToCloudinary(buffer, mimetype, options = {}) {
  const isVideo    = mimetype.startsWith('video/');
  const resourceType = isVideo ? 'video' : 'image';
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'fieldcam', resource_type: resourceType, ...options },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// ── GET /api/photos/:propertyId ────────────────────────────────
router.get('/:propertyId', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        ph.*,
        u.full_name AS uploader_name,
        u.email     AS uploader_email
      FROM photos ph
      LEFT JOIN users u ON u.id = ph.uploaded_by
      WHERE ph.property_id = $1
      ORDER BY ph.taken_at DESC
    `, [req.params.propertyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// ── POST /api/photos/:propertyId ───────────────────────────────
router.post('/:propertyId', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo file provided' });

  const { propertyId } = req.params;
  const { lat, lng, notes } = req.body;

  try {
    // Confirm property exists
    const { rows: propRows } = await query(
      'SELECT id FROM properties WHERE id = $1', [propertyId]
    );
    if (!propRows[0]) return res.status(404).json({ error: 'Property not found' });

    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';

    // Upload to Cloudinary
    const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, {
      public_id: `${propertyId}/${Date.now()}`,
      ...(mediaType === 'image'
        ? { transformation: [{ quality: 'auto', fetch_format: 'auto' }] }
        : {})
    });

    // Save metadata to DB
    const { rows } = await query(`
      INSERT INTO photos
        (property_id, uploaded_by, url, cloudinary_id, lat, lng, notes, media_type, taken_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *
    `, [
      propertyId,
      req.userId,
      result.secure_url,
      result.public_id,
      lat  ? parseFloat(lat)  : null,
      lng  ? parseFloat(lng)  : null,
      notes?.trim() || null,
      mediaType
    ]);

    // Update property cover_url only for images (not video URLs)
    if (mediaType === 'image') {
      await query(
        'UPDATE properties SET cover_url = $1, updated_at = NOW() WHERE id = $2',
        [result.secure_url, propertyId]
      );
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Failed to upload photo: ' + err.message });
  }
});

// ── PATCH /api/photos/:id  (replace with annotated version) ───────
router.patch('/:id', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo file provided' });
  try {
    const { rows } = await query('SELECT * FROM photos WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Photo not found' });
    const photo = rows[0];

    // Delete old Cloudinary asset
    if (photo.cloudinary_id) {
      const oldType = photo.media_type === 'video' ? 'video' : 'image';
      await cloudinary.uploader.destroy(photo.cloudinary_id, { resource_type: oldType })
        .catch(e => console.warn('Cloudinary delete warning:', e.message));
    }

    // Upload annotated image
    const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype, {
      public_id: `${photo.property_id}/${Date.now()}`,
      transformation: [{ quality: 'auto', fetch_format: 'auto' }]
    });

    // Update DB record in place
    const { rows: updated } = await query(`
      UPDATE photos SET url = $1, cloudinary_id = $2, taken_at = NOW()
      WHERE id = $3 RETURNING *
    `, [result.secure_url, result.public_id, photo.id]);

    // If this was the property cover, update it too
    await query(
      'UPDATE properties SET cover_url = $1, updated_at = NOW() WHERE id = $2 AND cover_url = $3',
      [result.secure_url, photo.property_id, photo.url]
    );

    res.json(updated[0]);
  } catch (err) {
    console.error('Photo patch error:', err);
    res.status(500).json({ error: 'Failed to update photo: ' + err.message });
  }
});

// ── DELETE /api/photos/:id ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM photos WHERE id = $1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Photo not found' });
    if (rows[0].uploaded_by !== req.userId) {
      return res.status(403).json({ error: 'You can only delete your own photos' });
    }

    const photo = rows[0];

    // Delete from Cloudinary
    if (photo.cloudinary_id) {
      const resourceType = photo.media_type === 'video' ? 'video' : 'image';
      await cloudinary.uploader.destroy(photo.cloudinary_id, { resource_type: resourceType }).catch(e =>
        console.warn('Cloudinary delete warning:', e.message)
      );
    }

    // Delete from DB
    await query('DELETE FROM photos WHERE id = $1', [req.params.id]);

    // Update property cover to next most recent image (skip videos)
    const { rows: remaining } = await query(
      `SELECT url FROM photos WHERE property_id = $1 AND (media_type IS NULL OR media_type = 'image') ORDER BY taken_at DESC LIMIT 1`,
      [photo.property_id]
    );
    await query(
      'UPDATE properties SET cover_url = $1, updated_at = NOW() WHERE id = $2',
      [remaining[0]?.url || null, photo.property_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Photo delete error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

module.exports = router;
