const express = require('express');
const multer = require('multer');
const { requireAuth, requirePulseGrant } = require('../../middleware/auth');
const { uploadBuffer } = require('../../lib/pulse-cloudinary');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// 25 MB cap. Cloudinary's free tier is 100MB max anyway; 25MB keeps things snappy.
const MAX_BYTES = 25 * 1024 * 1024;

// Allowed mime types. `image/*` covers JPEG/PNG/HEIC/WebP/GIF.
// Office types covered via prefix matching below.
const ALLOWED_PREFIXES = ['image/'];
const ALLOWED_EXACT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip'
]);

function isAllowedMime(mime) {
  if (!mime) return false;
  if (ALLOWED_EXACT.has(mime)) return true;
  for (const p of ALLOWED_PREFIXES) if (mime.startsWith(p)) return true;
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 }
});

// POST /api/pulse/attachments  (multipart, field "file")
// Returns { url, cloudinary_id, mime_type, size_bytes, filename }
// — the frontend then includes this in the next POST /messages body.
router.post('/', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 25MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  if (!isAllowedMime(file.mimetype)) {
    return res.status(415).json({ error: 'Unsupported file type' });
  }

  try {
    const result = await uploadBuffer(file.buffer, {
      folder: `propspot/chat/uploads/${req.userId}`,
      mimeType: file.mimetype
    });
    return res.json({
      url: result.url,
      cloudinary_id: result.cloudinary_id,
      mime_type: file.mimetype,
      size_bytes: file.size,
      filename: file.originalname || 'file'
    });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    return res.status(502).json({ error: 'Upload provider failed' });
  }
});

module.exports = router;
