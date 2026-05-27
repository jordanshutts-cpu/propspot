const express = require('express');
const { query } = require('../../db');
const { requireAuth } = require('../../middleware/auth');
const { resolvePath } = require('../../lib/inkd-autofill');
const { logAudit } = require('../../lib/inkd-audit');
const { signEnvelopeUrls } = require('../../lib/inkd-cloudinary-urls');

const router = express.Router();
router.use(requireAuth);

// GET /api/inkd/envelopes  — list with filters (lane)
// Query: ?status=draft|sent|partial|completed|voided|expired&filed=true|false
router.get('/', async (req, res) => {
  const { status, filed } = req.query;
  const args = [];
  const where = ['1=1'];
  if (status)                { args.push(status);             where.push(`status = $${args.length}`); }
  if (filed === 'true')      {                                 where.push(`filed_at IS NOT NULL`); }
  else if (filed === 'false'){                                 where.push(`filed_at IS NULL`); }
  try {
    const { rows } = await query(
      `SELECT e.*, p.address AS property_address, t.name AS template_name
         FROM inkd_envelopes e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN inkd_templates t ON t.id = e.template_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT 200`,
      args);
    rows.forEach(signEnvelopeUrls);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to list envelopes' }); }
});

// GET /api/inkd/envelopes/:id  — full envelope with recipients + field_values
router.get('/:id', async (req, res) => {
  try {
    const e = await query('SELECT * FROM inkd_envelopes WHERE id=$1', [req.params.id]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Envelope not found' });
    const r = await query('SELECT id, role, full_name, email, phone, contact_id, signing_order, status, notified_at, viewed_at, signed_at FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order', [req.params.id]);
    const v = await query('SELECT * FROM inkd_field_values WHERE envelope_id=$1', [req.params.id]);
    res.json({ ...signEnvelopeUrls(e.rows[0]), recipients: r.rows, field_values: v.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load envelope' }); }
});

// POST /api/inkd/envelopes  — create draft (from a template + optional property/opportunity/contact)
// body: { template_id, property_id?, opportunity_id?, contact_id?, name? }
router.post('/', async (req, res) => {
  const { template_id, property_id, opportunity_id, contact_id, name } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  try {
    const t = await query('SELECT * FROM inkd_templates WHERE id=$1 AND archived_at IS NULL', [template_id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Template not found' });
    const tpl = t.rows[0];

    const ctx = await buildAutofillContext({ property_id, opportunity_id, contact_id, userId: req.userId });
    const fields = (await query('SELECT * FROM inkd_template_fields WHERE template_id=$1', [template_id])).rows;

    let envName = name;
    if (!envName) {
      envName = ctx.property?.address ? `${tpl.name} — ${ctx.property.address}` : tpl.name;
    }

    const env = (await query(
      `INSERT INTO inkd_envelopes
         (template_id, source_pdf_url, source_pdf_id, page_count, name,
          property_id, opportunity_id, contact_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [template_id, tpl.source_pdf_url, tpl.source_pdf_id, tpl.page_count, envName,
       property_id || null, opportunity_id || null, contact_id || null, req.userId])).rows[0];

    for (const f of fields) {
      const value = f.autofill_source ? resolvePath(f.autofill_source, ctx) : null;
      await query(
        `INSERT INTO inkd_field_values
           (envelope_id, template_field_id, page_number,
            x_pct, y_pct, width_pct, height_pct,
            field_type, label, recipient_id, value, value_filled_at, value_filled_by, autofilled)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12,$13)`,
        [env.id, f.id, f.page_number,
         f.x_pct, f.y_pct, f.width_pct, f.height_pct,
         f.field_type, f.label,
         value, value ? new Date() : null, value ? req.userId : null, !!value]);
    }

    await logAudit({ envelopeId: env.id, eventType: 'created', req, userId: req.userId });
    res.status(201).json(env);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create envelope' }); }
});

// PATCH /api/inkd/envelopes/:id  — update name, reminders, expiry (only while draft)
router.patch('/:id', async (req, res) => {
  const { name, reminders_enabled, reminder_schedule, expires_at } = req.body;
  try {
    const e = await query('SELECT status FROM inkd_envelopes WHERE id=$1', [req.params.id]);
    if (!e.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (e.rows[0].status !== 'draft') return res.status(400).json({ error: 'Can only edit drafts' });
    const { rows } = await query(
      `UPDATE inkd_envelopes
          SET name = COALESCE($2, name),
              reminders_enabled = COALESCE($3, reminders_enabled),
              reminder_schedule = COALESCE($4::jsonb, reminder_schedule),
              expires_at = COALESCE($5, expires_at)
        WHERE id=$1
        RETURNING *`,
      [req.params.id, name, reminders_enabled,
       reminder_schedule ? JSON.stringify(reminder_schedule) : null,
       expires_at]);
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update envelope' }); }
});

// PUT /api/inkd/envelopes/:id/field-values  — update field values (during composition)
// body: { values: [{ id, value }] }
router.put('/:id/field-values', async (req, res) => {
  const items = Array.isArray(req.body.values) ? req.body.values : null;
  if (!items) return res.status(400).json({ error: 'values array required' });
  try {
    for (const it of items) {
      await query(
        `UPDATE inkd_field_values
            SET value=$2, value_filled_at=now(), value_filled_by=$3, autofilled=FALSE
          WHERE id=$1 AND envelope_id=$4`,
        [it.id, it.value ?? null, req.userId, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update field values' }); }
});

// POST /api/inkd/envelopes/:id/void  — manual void by sender
router.post('/:id/void', async (req, res) => {
  try {
    await query(`UPDATE inkd_envelopes SET status='voided' WHERE id=$1`, [req.params.id]);
    await logAudit({ envelopeId: req.params.id, eventType: 'voided', req, userId: req.userId, details: { reason: req.body?.reason || null } });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to void' }); }
});

// GET /api/inkd/envelopes/:id/audit
router.get('/:id/audit', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT event_type, event_at, ip, user_agent, details
         FROM inkd_audit_events WHERE envelope_id=$1 ORDER BY event_at`, [req.params.id]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load audit' }); }
});

async function buildAutofillContext({ property_id, opportunity_id, contact_id, userId }) {
  const ctx = { property: null, opportunity: null, contact: null, user: null, recipients: {} };
  if (property_id) {
    const r = await query('SELECT * FROM properties WHERE id=$1', [property_id]);
    ctx.property = r.rows[0] || null;
  }
  if (opportunity_id) {
    const r = await query('SELECT * FROM opportunities WHERE id=$1', [opportunity_id]);
    ctx.opportunity = r.rows[0] || null;
  }
  if (contact_id) {
    const r = await query('SELECT * FROM contacts WHERE id=$1', [contact_id]);
    ctx.contact = r.rows[0] || null;
  }
  if (userId) {
    const r = await query('SELECT id, full_name, email FROM users WHERE id=$1', [userId]);
    ctx.user = r.rows[0] || null;
  }
  const now = new Date();
  ctx.today      = now.toISOString().slice(0, 10);
  ctx.today_long = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return ctx;
}

const { sendInvite, sendYourTurn } = require('../../lib/inkd-email');
const { mintToken, hashToken } = require('../../lib/inkd-tokens');

// Internal: bind field_values to recipients by role + resolve recipient.* autofills.
// Called at send time so role-based field assignment and recipient.* autofill paths
// can finally resolve (recipients don't exist yet at draft creation).
async function bindFieldsAndResolveRecipientAutofills(envelopeId) {
  const recipients = (await query(
    'SELECT id, role, full_name, email, phone FROM inkd_recipients WHERE envelope_id=$1',
    [envelopeId])).rows;
  const byRole = {};
  for (const r of recipients) { byRole[r.role] = r; }

  const fields = (await query(
    `SELECT fv.id AS fv_id, fv.value, fv.autofilled,
            tf.recipient_role, tf.autofill_source
       FROM inkd_field_values fv
       LEFT JOIN inkd_template_fields tf ON tf.id = fv.template_field_id
      WHERE fv.envelope_id=$1`, [envelopeId])).rows;

  const today = new Date();
  const ctxBase = {
    recipients: byRole,
    today:      today.toISOString().slice(0, 10),
    today_long: today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    envelope:   { id: envelopeId },
  };

  for (const f of fields) {
    const role = f.recipient_role;
    const recipientId = role && byRole[role] ? byRole[role].id : null;

    let newValue = null;
    if (f.autofill_source && f.autofill_source.startsWith('recipient.') && !f.value) {
      newValue = resolvePath(f.autofill_source, ctxBase);
    }

    if (recipientId || newValue != null) {
      await query(
        `UPDATE inkd_field_values
            SET recipient_id = COALESCE($2, recipient_id),
                value        = COALESCE($3, value),
                autofilled   = CASE WHEN $3 IS NOT NULL THEN TRUE ELSE autofilled END
          WHERE id=$1`,
        [f.fv_id, recipientId, newValue]);
    }
  }
}

// POST /api/inkd/envelopes/:id/send  — kick off the envelope
router.post('/:id/send', async (req, res) => {
  try {
    const env = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [req.params.id])).rows[0];
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'draft') return res.status(400).json({ error: 'Already sent' });

    const recipients = (await query(
      'SELECT * FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order', [req.params.id])).rows;
    if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient' });

    await bindFieldsAndResolveRecipientAutofills(req.params.id);

    const sender = (await query('SELECT full_name, email FROM users WHERE id=$1', [env.created_by])).rows[0];

    await query(`UPDATE inkd_envelopes SET status='sent', sent_at=now(),
                  expires_at=COALESCE(expires_at, now() + interval '30 days') WHERE id=$1`,
      [req.params.id]);
    await logAudit({ envelopeId: req.params.id, eventType: 'sent', req, userId: req.userId });

    const firstOrder = recipients[0].signing_order;
    const firstBatch = recipients.filter(r => r.signing_order === firstOrder);
    for (const r of firstBatch) {
      const newToken = mintToken();
      await query('UPDATE inkd_recipients SET sign_token_hash=$2, notified_at=now(), status=$3 WHERE id=$1',
        [r.id, await hashToken(newToken), 'notified']);
      try {
        await sendInvite({
          to: r.email, recipientName: r.full_name, envelopeName: env.name,
          senderName: sender?.full_name || 'PropSpot user', token: newToken,
        });
      } catch (e) { console.error('Email send failed for', r.email, e); }
    }

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to send envelope' }); }
});

// Internal helper: notify the next batch in sequence after one signs.
// Called by the signing router when a recipient finishes.
async function notifyNextBatchIfReady(envelopeId) {
  const env = (await query('SELECT * FROM inkd_envelopes WHERE id=$1', [envelopeId])).rows[0];
  if (!env) return;
  const recipients = (await query(
    'SELECT * FROM inkd_recipients WHERE envelope_id=$1 ORDER BY signing_order, id', [envelopeId])).rows;
  const orders = [...new Set(recipients.map(r => r.signing_order))].sort((a, b) => a - b);
  let nextOrder = null;
  for (const o of orders) {
    const batch = recipients.filter(r => r.signing_order === o);
    if (batch.every(r => r.status === 'signed')) continue;
    if (batch.some(r => r.status === 'notified' || r.status === 'viewed')) return;
    nextOrder = o; break;
  }
  if (nextOrder == null) return;
  const sender = (await query('SELECT full_name FROM users WHERE id=$1', [env.created_by])).rows[0];
  const batch = recipients.filter(r => r.signing_order === nextOrder);
  for (const r of batch) {
    const newToken = mintToken();
    await query('UPDATE inkd_recipients SET sign_token_hash=$2, notified_at=now(), status=$3 WHERE id=$1',
      [r.id, await hashToken(newToken), 'notified']);
    try {
      await sendYourTurn({
        to: r.email, recipientName: r.full_name, envelopeName: env.name,
        senderName: sender?.full_name || 'PropSpot user', token: newToken,
      });
    } catch (e) { console.error('Your-turn email failed for', r.email, e); }
  }
}

router.notifyNextBatchIfReady = notifyNextBatchIfReady;

module.exports = router;
