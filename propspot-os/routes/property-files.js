const express = require('express');
const multer  = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);

// Hold uploads in memory; we stream them straight to Cloudinary.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }   // 20 MB per file
});

// GET /api/property-files/:propertyId  — list all files for a property
router.get('/:propertyId', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT pf.*, u.full_name AS uploaded_by_name
        FROM property_files pf
        LEFT JOIN users u ON u.id = pf.uploaded_by
       WHERE pf.property_id = $1
       ORDER BY pf.created_at DESC
    `, [req.params.propertyId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// POST /api/property-files/:propertyId  — upload one file (multipart "file")
router.post('/:propertyId', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Confirm property exists (so we get a clean 404 instead of an FK error)
    const { rows: pp } = await query('SELECT id FROM properties WHERE id = $1', [req.params.propertyId]);
    if (!pp[0]) return res.status(404).json({ error: 'Property not found' });

    // Stream buffer to Cloudinary as a generic resource (handles non-image types).
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: `propspot/property-files/${req.params.propertyId}` },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    const { rows } = await query(`
      INSERT INTO property_files
        (property_id, filename, url, cloudinary_id, mime_type, size_bytes, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      req.params.propertyId,
      req.file.originalname || 'upload',
      result.secure_url,
      result.public_id,
      req.file.mimetype || null,
      req.file.size || null,
      req.userId
    ]);

    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: req.params.propertyId,
      action: 'file_uploaded', payload: { filename: req.file.originalname, size: req.file.size }
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('property file upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// DELETE /api/property-files/:fileId  — remove a file
router.delete('/file/:fileId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT property_id, cloudinary_id FROM property_files WHERE id = $1`,
      [req.params.fileId]
    );
    const f = rows[0];
    if (!f) return res.status(404).json({ error: 'File not found' });

    if (f.cloudinary_id) {
      try {
        await cloudinary.uploader.destroy(f.cloudinary_id, { resource_type: 'raw' });
      } catch {
        // Best-effort: also try image type if 'raw' fails.
        try { await cloudinary.uploader.destroy(f.cloudinary_id); } catch {}
      }
    }
    await query(`DELETE FROM property_files WHERE id = $1`, [req.params.fileId]);

    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: f.property_id,
      action: 'file_deleted', payload: { file_id: req.params.fileId }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;
