const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { SOURCES } = require('../../lib/inkd-autofill-sources');
const { signTemplateUrls } = require('../../lib/inkd-cloudinary-urls');

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

// GET /api/inkd/templates/:id/pdf  — server-side proxy for the template PDF.
//
// Why this exists: this Cloudinary account's ACL denies anonymous AND signed
// delivery of raw PDFs (curl confirmed 'x-cld-error: deny or ACL failure'
// even on /raw/upload/s--XXX--/... URLs). The Admin API endpoint accepts
// api_key+api_secret as Basic Auth and serves the binary, bypassing
// delivery rules. We stream the bytes through here so the browser never
// touches res.cloudinary.com for PDFs.
router.get('/:id/pdf', async (req, res) => {
  try {
    const t = await query('SELECT source_pdf_id FROM inkd_templates WHERE id=$1', [req.params.id]);
    const publicId = t.rows[0]?.source_pdf_id;
    if (!publicId) return res.status(404).json({ error: 'Template has no PDF' });

    // private_download_url generates a signed Admin-API download URL of the
    // form  https://api.cloudinary.com/v1_1/<cloud>/raw/download?api_key=…&
    // signature=…&public_id=…&expires_at=…  — credentials as query params,
    // host is api.cloudinary.com (not res.cloudinary.com), so it bypasses
    // delivery ACLs entirely. The previous attempt embedded creds in the
    // URL as user:pass@host, which Node's fetch rejects for security.
    const downloadUrl = cloudinary.utils.private_download_url(publicId, 'pdf', {
      resource_type: 'raw',
      type:          'upload',
      expires_at:    Math.floor(Date.now() / 1000) + 300,  // 5 minutes
    });

    const upstream = await fetch(downloadUrl);
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      console.error('[inkd] template PDF proxy upstream failed', upstream.status, body);
      return res.status(502).json({ error: 'Cloudinary fetch failed', status: upstream.status, detail: body.slice(0, 500) });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    console.error('[inkd] template PDF proxy error', err);
    res.status(500).json({ error: 'PDF proxy failed', detail: err?.message });
  }
});

// GET /api/inkd/templates/:id  — full template with fields. Returns the
// proxy URL above as source_pdf_url so the editor never tries to fetch
// from res.cloudinary.com directly.
router.get('/:id', async (req, res) => {
  try {
    const t = await query('SELECT * FROM inkd_templates WHERE id=$1', [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const f = await query(
      `SELECT * FROM inkd_template_fields
        WHERE template_id=$1
        ORDER BY page_number, display_order`, [req.params.id]);
    const tpl = t.rows[0];
    if (tpl.source_pdf_id) tpl.source_pdf_url = `/api/inkd/templates/${tpl.id}/pdf`;
    res.json({ ...tpl, fields: f.rows });
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

    // Force resource_type: 'raw' + explicit public access. PR #186 switched
    // from 'auto' to 'raw' to bypass the PDF security policy, but the result
    // still returned 401 — confirmed via direct curl, with the `cache-control:
    // private` header in the response. That means the Cloudinary account is
    // marking new uploads as authenticated (signed-URL required) by default.
    //
    // type: 'upload' + access_mode: 'public' override that default and force
    // the asset to be anonymously accessible via the secure_url we store.
    stage = 'cloudinary-upload';
    const cloud = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          type:          'upload',
          access_mode:   'public',
          folder:        'propspot/inkd/templates',
          format:        'pdf',
        },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    stage = 'db-insert';
    const { rows } = await query(
      `INSERT INTO inkd_templates
        (name, category, description, source_pdf_url, source_pdf_id, page_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [name, category || null, description || null, cloud.secure_url, cloud.public_id, pageCount, req.userId]
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
