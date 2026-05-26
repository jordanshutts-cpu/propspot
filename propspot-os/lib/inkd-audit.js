const { query } = require('../db');

const VALID_EVENTS = new Set([
  'created','sent','viewed','started','field_filled',
  'signed','declined','reminder_sent','voided','expired',
  'filed_to_property'
]);

function ipFromReq(req) {
  if (!req) return null;
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket?.remoteAddress || null;
}

async function logAudit({ envelopeId, recipientId = null, eventType, req = null, userId = null, details = null }) {
  if (!envelopeId) throw new Error('logAudit: envelopeId is required');
  if (!VALID_EVENTS.has(eventType)) throw new Error(`logAudit: unknown event_type ${eventType}`);
  const ip = ipFromReq(req);
  const ua = req?.headers['user-agent'] || null;
  await query(
    `INSERT INTO inkd_audit_events (envelope_id, recipient_id, event_type, ip, user_agent, user_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [envelopeId, recipientId, eventType, ip, ua, userId, details ? JSON.stringify(details) : null]
  );
}

module.exports = { logAudit };
