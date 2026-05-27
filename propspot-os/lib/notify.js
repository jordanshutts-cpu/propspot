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

module.exports = { pushNotification };
