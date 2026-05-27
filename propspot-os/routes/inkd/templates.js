const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { SOURCES } = require('../../lib/inkd-autofill-sources');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 30 * 1024 * 1024 }  // 30 MB PDFs allowed
});

// GET /api/inkd/templates  — list (non-archived)
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, category, description, page_count, created_at, updated_at
         FROM inkd_templates
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list templates' }); }
});

// GET /api/inkd/templates/autofill-sources  — return the dropdown list
router.get('/autofill-sources', (_req, res) => res.json(SOURCES));

// GET /api/inkd/templates/:id  — full template with fields
router.get('/:id', async (req, res) => {
  try {
    const t = await query('SELECT * FROM inkd_templates WHERE id=$1', [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const f = await query(
      `SELECT * FROM inkd_template_fields
        WHERE template_id=$1
        ORDER BY page_number, display_order`, [req.params.id]);
    res.json({ ...t.rows[0], fields: f.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load template' }); }
});

// POST /api/inkd/templates  — create a new template by uploading a PDF
// multipart: file (pdf), name, category, description
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file required' });
  const { name, category, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  let stage = 'parse-pdf';
  try {
    // Count pages from the PDF using pdf-lib (server-side, cheap)
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(req.file.buffer, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    // Match the property-files.js pattern (resource_type: 'auto'). On some Cloudinary
    // plans 'raw' uploads of PDFs are restricted; 'auto' classifies PDFs as image
    // resources, which always works for upload (we never request rendering, just storage).
    stage = 'cloudinary-upload';
    const cloud = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: 'propspot/inkd/templates' },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    stage = 'db-insert';
    const { rows } = await query(
      `INSERT INTO inkd_templates
        (name, category, description, source_pdf_url, source_pdf_id, page_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [name, category || null, description || null, cloud.secure_url, cloud.public_id, pageCount, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(`[inkd] template create failed at stage=${stage}:`, err);
    res.status(500).json({
      error: 'Failed to create template',
      stage,
      detail: err?.message || String(err),
    });
  }
});

// PATCH /api/inkd/templates/:id  — update name/category/description
router.patch('/:id', async (req, res) => {
  const { name, category, description } = req.body;
  try {
    const { rows } = await query(
      `UPDATE inkd_templates
          SET name=COALESCE($2,name),
              category=COALESCE($3,category),
              description=COALESCE($4,description),
              updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [req.params.id, name, category, description]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update template' }); }
});

// DELETE /api/inkd/templates/:id  — soft archive
router.delete('/:id', async (req, res) => {
  try {
    await query('UPDATE inkd_templates SET archived_at=now() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to archive template' }); }
});

// PUT /api/inkd/templates/:id/fields  — replace the full field set for a template
router.put('/:id/fields', async (req, res) => {
  const fields = Array.isArray(req.body.fields) ? req.body.fields : null;
  if (!fields) return res.status(400).json({ error: 'fields array required' });
  try {
    await query('DELETE FROM inkd_template_fields WHERE template_id=$1', [req.params.id]);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await query(
        `INSERT INTO inkd_template_fields
          (template_id, page_number, x_pct, y_pct, width_pct, height_pct,
           field_type, label, recipient_role, required, autofill_source, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.params.id, f.page_number, f.x_pct, f.y_pct, f.width_pct, f.height_pct,
         f.field_type, f.label || null, f.recipient_role || null,
         f.required !== false, f.autofill_source || null, i]
      );
    }
    await query('UPDATE inkd_templates SET updated_at=now() WHERE id=$1', [req.params.id]);
    const { rows } = await query(
      'SELECT * FROM inkd_template_fields WHERE template_id=$1 ORDER BY page_number, display_order',
      [req.params.id]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save fields' }); }
});

module.exports = router;
