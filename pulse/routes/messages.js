const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');
const hub = require('../lib/hub');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// Helper: confirm the caller can read/write the given channel.
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
    // Unique violation on (sender_id, client_message_id) — return the existing row.
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

// GET /api/pulse/messages?channel_id=<UUID>   — most recent 100 (Phase 1, no pagination)
router.get('/', async (req, res) => {
  const channel_id = req.query.channel_id;
  if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
  if (!(await userHasChannel(req.userId, channel_id))) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }
  const { rows } = await query(`
    SELECT m.*, u.full_name AS sender_name, u.email AS sender_email
      FROM chat_messages m
      LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.channel_id = $1
       AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT 100
  `, [channel_id]);
  res.json(rows.reverse());
});

module.exports = router;
