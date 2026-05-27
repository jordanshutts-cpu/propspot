// ────────────────────────────────────────────────────────────────
//  pushNotification — insert a notification row and fan out via SSE
// ────────────────────────────────────────────────────────────────
const { query } = require('../db');
const hub = require('./hub');

/**
 * Insert a notification for `userId`, then immediately push it to
 * any open /api/notifications/stream connection for that user.
 *
 * All fields except userId / type / title are optional.
 * Non-fatal — logs and returns undefined on DB error so callers
 * don't need try/catch boilerplate.
 */
async function pushNotification({ userId, type, title, body, url, payload }) {
  try {
    const { rows: [n] } = await query(
      `INSERT INTO notifications (user_id, type, title, body, url, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, type, title, body || null, url || null,
       payload ? JSON.stringify(payload) : null]
    );
    hub.publish('user:' + userId, { type: 'notification', notification: n });
    return n;
  } catch (err) {
    console.error('pushNotification error:', err.message);
  }
}

/**
 * Fan out a notification to every active workspace owner (excluding the actor).
 * Used by pipeline promotions where the whole leadership team should see it.
 */
async function notifyOwners({ excludeUserId, type, title, body, url, payload }) {
  try {
    const { rows: owners } = await query(
      `SELECT id FROM users WHERE is_owner = TRUE AND removed_at IS NULL`
    );
    for (const o of owners) {
      if (o.id === excludeUserId) continue;
      await pushNotification({ userId: o.id, type, title, body, url, payload });
    }
  } catch (err) {
    console.error('notifyOwners error:', err.message);
  }
}

module.exports = { pushNotification, notifyOwners };
