const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// GET /api/org — get org settings
router.get('/', async (req, res) => {
  try {
    const { rows: [org] } = await query(`SELECT * FROM org_settings WHERE id = 1`);
    res.json(org || { company_name: 'My Company', company_logo_url: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load org settings' });
  }
});

// PATCH /api/org — update org settings (owner only)
router.patch('/', async (req, res) => {
  try {
    const { rows: [user] } = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
    if (!user || !user.is_owner) return res.status(403).json({ error: 'Only owners can update org settings' });

    const { company_name } = req.body;
    const { rows: [org] } = await query(`
      UPDATE org_settings SET
        company_name = COALESCE($1, company_name),
        updated_at = NOW()
      WHERE id = 1 RETURNING *
    `, [company_name || null]);
    res.json(org);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update org settings' });
  }
});

// POST /api/org/logo — upload company logo (owner only)
router.post('/logo', upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [user] } = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
    if (!user || !user.is_owner) return res.status(403).json({ error: 'Only owners can update the logo' });

    // Delete old logo from Cloudinary
    const { rows: [old] } = await query(`SELECT company_logo_cloud_id FROM org_settings WHERE id = 1`);
    if (old && old.company_logo_cloud_id) {
      try { await cloudinary.uploader.destroy(old.company_logo_cloud_id); } catch {}
    }

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'propspot/org', transformation: [{ width: 400, height: 400, crop: 'limit' }] },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    const { rows: [org] } = await query(`
      UPDATE org_settings SET
        company_logo_url = $1,
        company_logo_cloud_id = $2,
        updated_at = NOW()
      WHERE id = 1 RETURNING *
    `, [result.secure_url, result.public_id]);

    res.json(org);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

module.exports = router;
