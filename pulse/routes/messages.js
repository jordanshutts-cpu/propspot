const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');
const hub = require('../lib/hub');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

async function userHasChannel(userId, channelId) {
  const { rows } = await query(`
    SELECT 1
      FROM users u
      LEFT JOIN chat_channel_members m
        ON m.user_id = u.id AND m.channel_id = $1
     WHERE u.id = $2
       AND (u.is_owner = TRUE OR m.user_id IS NOT NULL)
     LIMIT 1
  `, [channelId, userId]);
  return rows.length > 0;
}

async function hydrateMessage(row) {
  const { rows } = await query(
    `SELECT full_name, email FROM users WHERE id = $1`,
    [row.sender_id]
  );
  const sender = rows[0] || {};
  return {
    ...row,
    sender_name: sender.full_name || sender.email || 'Unknown',
    sender_email: sender.email || null
  };
}

// POST /api/pulse/messages   { channel_id, body, client_message_id? }
router.post('/', async (req, res) => {
  const { channel_id, body, client_message_id } = req.body || {};
  if (!channel_id || !body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'channel_id and body required' });
  }
  if (body.length > 8000) {
    return res.status(413).json({ error: 'message too long (8000 char max)' });
  }

  if (!(await userHasChannel(req.userId, channel_id))) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  try {
    const ins = await query(`
      INSERT INTO chat_messages (channel_id, sender_id, client_message_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [channel_id, req.userId, client_message_id || null, body.trim()]);
    const enriched = await hydrateMessage(ins.rows[0]);
    hub.publish(channel_id, { type: 'message', message: enriched });
    return res.json(enriched);
  } catch (err) {
    if (err.code === '23505' && client_message_id) {
      const { rows } = await query(
        `SELECT * FROM chat_messages WHERE sender_id = $1 AND client_message_id = $2`,
        [req.userId, client_message_id]
      );
      if (rows.length) return res.json(await hydrateMessage(rows[0]));
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /api/pulse/messages?channel_id=<UUID>&before=<ISO>&limit=50
//   Returns messages strictly OLDER than `before` (or most recent if not given),
//   in chronological order (oldest first), plus has_more so the UI knows whether
//   to keep paginating.
router.get('/', async (req, res) => {
  const channel_id = req.query.channel_id;
  if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
  if (!(await userHasChannel(req.userId, channel_id))) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 100));
  const before = req.query.before ? new Date(req.query.before) : null;
  const params = [channel_id];
  let beforeClause = '';
  if (before && !isNaN(before)) {
    params.push(before.toISOString());
    beforeClause = `AND m.created_at < $${params.length}`;
  }
  params.push(limit);

  const sql = `
    SELECT m.*, u.full_name AS sender_name, u.email AS sender_email
      FROM chat_messages m
      LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.channel_id = $1
       AND m.deleted_at IS NULL
       ${beforeClause}
     ORDER BY m.created_at DESC
     LIMIT $${params.length}
  `;
  const { rows } = await query(sql, params);

  // Pull DESC + LIMIT to grab freshest, reverse for chronological return.
  res.json({
    messages: rows.reverse(),
    has_more: rows.length === limit
  });
});

module.exports = router;
