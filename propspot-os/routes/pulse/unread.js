const express = require('express');
const { query } = require('../../db');
const { requireAuth, requirePulseGrant } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// GET /api/pulse/unread
// Returns per-scope unread + mention counts for everything the caller can see.
// Shape: { channels: [{channel_id, unread, mentions}], dms: [{dm_id, unread, mentions}] }
router.get('/', async (req, res) => {
  try {
    // Channels (caller is a member of)
    const chans = await query(`
      SELECT
        m.channel_id,
        (SELECT COUNT(*) FROM chat_messages msg
          WHERE msg.channel_id = m.channel_id
            AND msg.deleted_at IS NULL
            AND msg.sender_id <> $1
            AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at))::int AS unread,
        (SELECT COUNT(*) FROM chat_mentions cm
           JOIN chat_messages msg ON msg.id = cm.message_id
          WHERE msg.channel_id = m.channel_id
            AND msg.deleted_at IS NULL
            AND cm.mentioned_user_id = $1
            AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at))::int AS mentions
        FROM chat_channel_members m
       WHERE m.user_id = $1
    `, [req.userId]);

    const dms = await query(`
      SELECT
        m.dm_id,
        (SELECT COUNT(*) FROM chat_messages msg
          WHERE msg.dm_id = m.dm_id
            AND msg.deleted_at IS NULL
            AND msg.sender_id <> $1
            AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at))::int AS unread,
        (SELECT COUNT(*) FROM chat_mentions cm
           JOIN chat_messages msg ON msg.id = cm.message_id
          WHERE msg.dm_id = m.dm_id
            AND msg.deleted_at IS NULL
            AND cm.mentioned_user_id = $1
            AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at))::int AS mentions
        FROM chat_dm_members m
       WHERE m.user_id = $1
    `, [req.userId]);

    res.json({ channels: chans.rows, dms: dms.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load unread counts' });
  }
});

module.exports = router;
