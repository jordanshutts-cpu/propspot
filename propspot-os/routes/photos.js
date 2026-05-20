const express    = require('express');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { query }  = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'fieldcam', resource_type: 'image', ...options },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// GET /api/photos/:propertyId
router.get('/:propertyId', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ph.*,
             u.full_name AS uploader_name,
             u.email     AS uploader_email
        FROM photos ph
        LEFT JOIN users u ON u.id = ph.uploaded_by
       WHERE ph.property_id = $1
       ORDER BY ph.taken_at DESC
    `, [req.params.propertyId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// POST /api/photos/:propertyId
router.post('/:propertyId', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo file provided' });

  const { propertyId } = req.params;
  const { lat, lng, notes } = req.body;

  try {
    const { rows: propRows } = await query(
      'SELECT id FROM properties WHERE id = $1', [propertyId]
    );
    if (!propRows[0]) return res.status(404).json({ error: 'Property not found' });

    const result = await uploadToCloudinary(req.file.buffer, {
      public_id: `${propertyId}/${Date.now()}`,
      transformation: [{ quality: 'auto', fetch_format: 'auto' }]
    });

    const { rows } = await query(`
      INSERT INTO photos
        (property_id, uploaded_by, url, cloudinary_id, lat, lng, notes, taken_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `, [
      propertyId,
      req.userId,
      result.secure_url,
      result.public_id,
      lat ? parseFloat(lat) : null,
      lng ? parseFloat(lng) : null,
      notes?.trim() || null
    ]);

    await query(
      'UPDATE properties SET cover_url = $1, updated_at = NOW() WHERE id = $2',
      [result.secure_url, propertyId]
    );

    await logActivity({
      actorUserId: req.userId, entityType: 'photo', entityId: rows[0].id,
      action: 'created', payload: { property_id: propertyId }
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Failed to upload photo: ' + err.message });
  }
});

// DELETE /api/photos/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM photos WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Photo not found' });

    const photo = rows[0];

    // Allow uploader OR owner to delete
    const { rows: u } = await query('SELECT is_owner FROM users WHERE id = $1', [req.userId]);
    if (photo.uploaded_by !== req.userId && !u[0]?.is_owner) {
      return res.status(403).json({ error: 'You can only delete your own photos' });
    }

    if (photo.cloudinary_id) {
      await cloudinary.uploader.destroy(photo.cloudinary_id).catch(e =>
        console.warn('Cloudinary delete warning:', e.message)
      );
    }

    await query('DELETE FROM photos WHERE id = $1', [req.params.id]);

    const { rows: remaining } = await query(
      'SELECT url FROM photos WHERE property_id = $1 ORDER BY taken_at DESC LIMIT 1',
      [photo.property_id]
    );
    await query(
      'UPDATE properties SET cover_url = $1, updated_at = NOW() WHERE id = $2',
      [remaining[0]?.url || null, photo.property_id]
    );

    await logActivity({
      actorUserId: req.userId, entityType: 'photo', entityId: req.params.id,
      action: 'deleted', payload: { property_id: photo.property_id }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Photo delete error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

module.exports = router;
