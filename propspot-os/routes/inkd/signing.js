// PUBLIC routes — DO NOT use requireAuth. Token-authenticated only.
const express = require('express');
const cloudinary = require('cloudinary').v2;
const { query } = require('../../db');
const { verifyToken } = require('../../lib/inkd-tokens');
const { logAudit } = require('../../lib/inkd-audit');
const envelopesRouter = require('./envelopes');

const router = express.Router();

// Helper: resolve a clear-text token to a recipient.
// Scans candidates by bcrypt-comparing each — O(n) but n is small (active recipients only).
async function findRecipientByToken(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const { rows } = await query(
    `SELECT id, envelope_id, sign_token_hash, sign_token_expires_at, status, full_name, email, role
       FROM inkd_recipients
      WHERE sign_token_expires_at > now()
        AND status IN ('notified','viewed')`);
  for (const r of rows) {
    if (await verifyToken(token, r.sign_token_hash)) return r;
  }
  return null;
}

// GET /api/inkd/signing/:token  — load the doc + this recipient's fields
router.get('/:token', async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });

  if (rec.status === 'notified') {
    await query('UPDATE inkd_recipients SET viewed_at=now(), status=$2 WHERE id=$1', [rec.id, 'viewed']);
    await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'viewed', req });
  }
  const env = (await query('SELECT id, name, source_pdf_url, page_count, status FROM inkd_envelopes WHERE id=$1', [rec.envelope_id])).rows[0];
  const allRecips = (await query('SELECT id, role, full_name, signing_order FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order', [rec.envelope_id])).rows;
  const fields = (await query('SELECT * FROM inkd_field_values WHERE envelope_id=$1 ORDER BY page_number', [rec.envelope_id])).rows;
  res.json({
    envelope: env,
    me: { id: rec.id, role: rec.role, full_name: rec.full_name },
    other_recipients: allRecips.filter(r => r.id !== rec.id),
    fields,
  });
});

// POST /api/inkd/signing/:token/upload-signature
// body: { dataUrl: 'data:image/png;base64,...' }
router.post('/:token/upload-signature', express.json({ limit: '4mb' }), async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });
  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return res.status(400).json({ error: 'dataUrl required' });
  try {
    const cloud = await cloudinary.uploader.upload(dataUrl, {
      folder: `propspot/inkd/signatures/${rec.envelope_id}`,
      resource_type: 'image',
    });
    res.json({ url: cloud.secure_url });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Upload failed' }); }
});

// POST /api/inkd/signing/:token/submit
// body: { values: [{ id, value }] }
router.post('/:token/submit', express.json(), async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });

  const items = Array.isArray(req.body.values) ? req.body.values : [];
  try {
    for (const it of items) {
      await query(
        `UPDATE inkd_field_values
            SET value=$2, value_filled_at=now(), autofilled=FALSE
          WHERE id=$1 AND envelope_id=$3 AND recipient_id=$4`,
        [it.id, it.value ?? null, rec.envelope_id, rec.id]);
      await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'field_filled', req, details: { field_value_id: it.id } });
    }

    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress || null;
    await query(`UPDATE inkd_recipients
                    SET status='signed', signed_at=now(), signed_ip=$2, signed_user_agent=$3
                  WHERE id=$1`, [rec.id, ip, req.headers['user-agent'] || null]);
    await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'signed', req });

    const counts = await query(
      `SELECT
          COUNT(*) FILTER (WHERE status='signed')   AS signed,
          COUNT(*)                                   AS total
         FROM inkd_recipients WHERE envelope_id=$1`, [rec.envelope_id]);
    const { signed, total } = counts.rows[0];
    if (Number(signed) === Number(total)) {
      await query(`UPDATE inkd_envelopes SET status='completed', completed_at=now() WHERE id=$1`, [rec.envelope_id]);
      try { await finalizeEnvelope(rec.envelope_id); }
      catch (e) { console.error('finalizeEnvelope failed', e); }
    } else {
      await query(`UPDATE inkd_envelopes SET status='partial' WHERE id=$1 AND status<>'partial'`, [rec.envelope_id]);
      await envelopesRouter.notifyNextBatchIfReady(rec.envelope_id);
    }

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Submit failed' }); }
});

// POST /api/inkd/signing/:token/decline
router.post('/:token/decline', express.json(), async (req, res) => {
  const rec = await findRecipientByToken(req.params.token);
  if (!rec) return res.status(404).json({ error: 'Invalid or expired signing link' });
  try {
    await query(`UPDATE inkd_recipients SET status='declined', decline_reason=$2 WHERE id=$1`, [rec.id, req.body?.reason || null]);
    await logAudit({ envelopeId: rec.envelope_id, recipientId: rec.id, eventType: 'declined', req, details: { reason: req.body?.reason || null } });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Decline failed' }); }
});

const { buildSignedPdf } = require('../../lib/inkd-pdf');
const { sendCompletedToSender } = require('../../lib/inkd-email');

async function finalizeEnvelope(envelopeId) {
  const env       = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [envelopeId])).rows[0];
  const recips    = (await query('SELECT * FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order, id', [envelopeId])).rows;
  const fvs       = (await query('SELECT * FROM inkd_field_values WHERE envelope_id=$1', [envelopeId])).rows;
  const events    = (await query('SELECT * FROM inkd_audit_events WHERE envelope_id=$1 ORDER BY event_at', [envelopeId])).rows;
  const sender    = (await query('SELECT full_name, email FROM users WHERE id=$1', [env.created_by])).rows[0];

  const { bytes, hash } = await buildSignedPdf({
    sourcePdfUrl: env.source_pdf_url,
    envelope: env, recipients: recips, fieldValues: fvs, auditEvents: events,
  });

  const cloud = await new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        type:          'upload',
        access_mode:   'public',
        folder:        'propspot/inkd/signed',
        format:        'pdf',
      },
      (e, out) => e ? reject(e) : resolve(out)
    ).end(Buffer.from(bytes));
  });

  await query(
    `UPDATE inkd_envelopes
        SET final_pdf_url=$2, final_pdf_id=$3, final_pdf_hash=$4
      WHERE id=$1`,
    [envelopeId, cloud.secure_url, cloud.public_id, hash]);

  if (sender?.email) {
    try { await sendCompletedToSender({ to: sender.email, senderName: sender.full_name, envelopeName: env.name }); }
    catch (e) { console.error('sender completion email failed', e); }
  }
}

module.exports = router;
