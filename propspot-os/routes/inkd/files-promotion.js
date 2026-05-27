const express = require('express');
const crypto = require('crypto');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { logAudit } = require('../../lib/inkd-audit');
const { signedRawPdfUrl } = require('../../lib/inkd-cloudinary-urls');

const router = express.Router();
router.use(requireAuth);

// POST /api/inkd/envelopes/:id/save-to-files
router.post('/:id/save-to-files', async (req, res) => {
  try {
    const env = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [req.params.id])).rows[0];
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'completed') return res.status(400).json({ error: 'Envelope not completed' });
    if (env.filed_at) return res.status(400).json({ error: 'Already filed' });
    if (!env.property_id) return res.status(400).json({ error: 'Envelope has no property — cannot save to property Files' });

    // The stored final_pdf_url is unsigned and blocked by Cloudinary's ACL.
    // Sign on the fly to fetch the bytes for the paranoia re-hash, and store
    // the signed form on property_files.url so the Files page can render it
    // (property_files.cloudinary_id keeps the raw public_id for regeneration).
    const signedFinalUrl = env.final_pdf_id ? signedRawPdfUrl(env.final_pdf_id) : env.final_pdf_url;

    // Re-verify hash (paranoia)
    const buf = Buffer.from(await (await fetch(signedFinalUrl)).arrayBuffer());
    const recomputed = crypto.createHash('sha256').update(buf).digest('hex');
    if (recomputed !== env.final_pdf_hash) return res.status(500).json({ error: 'Hash mismatch — refusing to save' });

    const filename = `${env.name}.pdf`.replace(/[\/\\]/g, '-');
    const pf = (await query(
      `INSERT INTO property_files
         (property_id, filename, url, cloudinary_id, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [env.property_id, filename, signedFinalUrl, env.final_pdf_id, 'application/pdf', buf.length, req.userId])).rows[0];

    await query(`UPDATE inkd_envelopes SET filed_at=now(), filed_property_file_id=$2 WHERE id=$1`,
      [req.params.id, pf.id]);
    await logAudit({ envelopeId: req.params.id, eventType: 'filed_to_property', req, userId: req.userId, details: { property_file_id: pf.id } });
    res.json({ ok: true, property_file: pf });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Save to Files failed' }); }
});

module.exports = router;
