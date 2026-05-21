const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// GET /api/pulse/channels — list channels the caller belongs to (owners see all).
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
             (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id)::int AS member_count
        FROM chat_channels c
        LEFT JOIN chat_channel_members m ON m.channel_id = c.id AND m.user_id = $1
        LEFT JOIN users u ON u.id = $1
       WHERE u.is_owner = TRUE
          OR m.user_id IS NOT NULL
          OR c.is_private = FALSE
       ORDER BY c.created_at ASC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load channels' });
  }
});

// POST /api/pulse/channels/:id/join — make the caller a member (public channels only for Phase 1).
router.post('/:id/join', async (req, res) => {
  const channelId = req.params.id;
  try {
    const { rows } = await query(
      `SELECT is_private FROM chat_channels WHERE id = $1`,
      [channelId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Channel not found' });
    if (rows[0].is_private) {
      // Owners can self-join; everyone else needs an invite.
      const ownerCheck = await query(`SELECT is_owner FROM users WHERE id = $1`, [req.userId]);
      if (!ownerCheck.rows[0]?.is_owner) {
        return res.status(403).json({ error: 'Private channel — ask an existing member to invite you' });
      }
    }
    await query(`
      INSERT INTO chat_channel_members (channel_id, user_id, role)
      VALUES ($1, $2, 'member')
      ON CONFLICT (channel_id, user_id) DO NOTHING
    `, [channelId, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join channel' });
  }
});

module.exports = router;
