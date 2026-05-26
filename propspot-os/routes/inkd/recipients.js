const express = require('express');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { mintToken, hashToken } = require('../../lib/inkd-tokens');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/inkd/envelopes/:envelopeId/recipients
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, role, full_name, email, phone, contact_id, signing_order, status,
              notified_at, viewed_at, signed_at, decline_reason
         FROM inkd_recipients
        WHERE envelope_id=$1
        ORDER BY signing_order`, [req.params.envelopeId]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list recipients' }); }
});

// POST /api/inkd/envelopes/:envelopeId/recipients  — add a recipient
// body: { role, full_name, email, phone?, contact_id?, signing_order? }
router.post('/', async (req, res) => {
  const { role, full_name, email, phone, contact_id, signing_order } = req.body;
  if (!role || !full_name || !email) return res.status(400).json({ error: 'role, full_name, email required' });
  try {
    const token = mintToken();
    const hashedToken = await hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const { rows } = await query(
      `INSERT INTO inkd_recipients
         (envelope_id, role, full_name, email, phone, contact_id, signing_order,
          sign_token_hash, sign_token_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, role, full_name, email, phone, contact_id, signing_order, status`,
      [req.params.envelopeId, role, full_name, email, phone || null, contact_id || null,
       signing_order || 1, hashedToken, expiresAt]);
    res.status(201).json({ ...rows[0], sign_token: token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add recipient' }); }
});

// PATCH /api/inkd/envelopes/:envelopeId/recipients/:id
router.patch('/:id', async (req, res) => {
  const { role, full_name, email, phone, signing_order } = req.body;
  try {
    const { rows } = await query(
      `UPDATE inkd_recipients
          SET role          = COALESCE($2, role),
              full_name     = COALESCE($3, full_name),
              email         = COALESCE($4, email),
              phone         = COALESCE($5, phone),
              signing_order = COALESCE($6, signing_order)
        WHERE id=$1 AND envelope_id=$7
        RETURNING id, role, full_name, email, phone, signing_order, status`,
      [req.params.id, role, full_name, email, phone, signing_order, req.params.envelopeId]);
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update recipient' }); }
});

// DELETE /api/inkd/envelopes/:envelopeId/recipients/:id  (only while draft)
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM inkd_recipients
                  WHERE id=$1 AND envelope_id=$2
                    AND $2 IN (SELECT id FROM inkd_envelopes WHERE status='draft')`,
      [req.params.id, req.params.envelopeId]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete recipient' }); }
});

// PATCH /api/inkd/envelopes/:envelopeId/recipients/:id/assign-fields
// body: { field_value_ids: [uuid, …] }
router.patch('/:id/assign-fields', async (req, res) => {
  const ids = Array.isArray(req.body.field_value_ids) ? req.body.field_value_ids : null;
  if (!ids) return res.status(400).json({ error: 'field_value_ids array required' });
  try {
    await query(
      `UPDATE inkd_field_values
          SET recipient_id=$1
        WHERE envelope_id=$2 AND id = ANY($3::uuid[])`,
      [req.params.id, req.params.envelopeId, ids]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to assign fields' }); }
});

module.exports = router;
