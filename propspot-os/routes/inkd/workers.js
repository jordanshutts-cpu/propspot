const { query } = require('../../db');
const { mintToken, hashToken } = require('../../lib/inkd-tokens');
const { sendReminder } = require('../../lib/inkd-email');
const { logAudit } = require('../../lib/inkd-audit');

// Run-once: send overdue reminders + mark expired envelopes.
async function runReminderTick() {
  // 1. Reminders
  const candidates = (await query(
    `SELECT e.id AS envelope_id, e.name AS envelope_name, e.reminder_schedule, e.sent_at,
            r.id AS recipient_id, r.full_name, r.email, r.last_reminded_at, r.sign_token_hash,
            u.full_name AS sender_name
       FROM inkd_envelopes e
       JOIN inkd_recipients r ON r.envelope_id=e.id
       JOIN users u ON u.id=e.created_by
      WHERE e.status IN ('sent','partial')
        AND e.reminders_enabled = TRUE
        AND r.status IN ('notified','viewed')
        AND e.sent_at IS NOT NULL`)).rows;

  const now = Date.now();
  for (const c of candidates) {
    const schedule = c.reminder_schedule || [3, 7];
    const sentMs = new Date(c.sent_at).getTime();
    const daysSent = Math.floor((now - sentMs) / 86400000);
    const dayMatch = schedule.find(d => d === daysSent);
    if (!dayMatch) continue;
    // Don't re-remind the same day twice
    if (c.last_reminded_at && new Date(c.last_reminded_at).toDateString() === new Date(now).toDateString()) continue;

    // Mint a fresh token so the link is always live
    const newToken = mintToken();
    await query('UPDATE inkd_recipients SET sign_token_hash=$2, last_reminded_at=now() WHERE id=$1',
      [c.recipient_id, await hashToken(newToken)]);
    try {
      await sendReminder({
        to: c.email, recipientName: c.full_name, envelopeName: c.envelope_name,
        senderName: c.sender_name, token: newToken, dayNumber: dayMatch,
      });
      await logAudit({ envelopeId: c.envelope_id, recipientId: c.recipient_id, eventType: 'reminder_sent', details: { day: dayMatch } });
    } catch (e) { console.error("Ink'd reminder failed", e); }
  }

  // 2. Expiry
  const expired = (await query(
    `UPDATE inkd_envelopes
        SET status='expired'
      WHERE status IN ('sent','partial')
        AND expires_at < now()
      RETURNING id`)).rows;
  for (const e of expired) {
    await logAudit({ envelopeId: e.id, eventType: 'expired' });
  }
}

function startWorker() {
  // Tick every 5 minutes — matches the lightweight cadence the rest of propspot-os uses
  const FIVE_MIN = 5 * 60 * 1000;
  setInterval(() => {
    runReminderTick().catch(e => console.error("Ink'd reminder tick failed", e));
  }, FIVE_MIN);
}

module.exports = { runReminderTick, startWorker };
