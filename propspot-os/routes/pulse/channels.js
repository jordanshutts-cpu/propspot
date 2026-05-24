const express = require('express');
const { query } = require('../../db');
const { requireAuth, requirePulseGrant } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// Normalize a free-form name into a slug: lowercase, alnum + hyphen only.
function toSlug(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function isOwner(userId) {
  const { rows } = await query(`SELECT is_owner FROM users WHERE id = $1`, [userId]);
  return !!rows[0]?.is_owner;
}

async function isMember(channelId, userId) {
  const { rows } = await query(
    `SELECT 1 FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId]
  );
  return rows.length > 0;
}

async function isAdmin(channelId, userId) {
  const { rows } = await query(
    `SELECT role FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId]
  );
  return rows[0]?.role === 'admin';
}

// GET /api/pulse/channels — list channels the caller can see.
//   Includes is_member + my_role so the UI can branch on "Join" vs "Open".
//   Filters out archived channels by default. Pass ?archived=1 to get just
//   the archived list (useful for the "Show archived" view).
router.get('/', async (req, res) => {
  const wantArchived = req.query.archived === '1' || req.query.archived === 'true';
  const archivedFilter = wantArchived
    ? 'AND c.archived_at IS NOT NULL'
    : 'AND c.archived_at IS NULL';
  try {
    const { rows } = await query(`
      SELECT c.*,
             (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id)::int AS member_count,
             (m.user_id IS NOT NULL) AS is_member,
             m.role AS my_role
        FROM chat_channels c
        LEFT JOIN chat_channel_members m ON m.channel_id = c.id AND m.user_id = $1
        LEFT JOIN users u ON u.id = $1
       WHERE (u.is_owner = TRUE
              OR m.user_id IS NOT NULL
              OR c.is_private = FALSE)
         ${archivedFilter}
       ORDER BY
         (c.slug = 'general') DESC,
         c.is_private ASC,
         c.created_at ASC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load channels' });
  }
});

// POST /api/pulse/channels   { name, description?, is_private? }
router.post('/', async (req, res) => {
  const { name, description, is_private } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const slug = toSlug(name);
  if (!slug) return res.status(400).json({ error: 'name must contain at least one letter or digit' });
  if (slug.length < 2) return res.status(400).json({ error: 'name too short' });

  try {
    const ins = await query(`
      INSERT INTO chat_channels (slug, name, description, is_private, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [slug, name.trim(), (description || null), !!is_private, req.userId]);
    const channel = ins.rows[0];

    await query(`
      INSERT INTO chat_channel_members (channel_id, user_id, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (channel_id, user_id) DO NOTHING
    `, [channel.id, req.userId]);

    res.json({ ...channel, is_member: true, my_role: 'admin', member_count: 1 });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A channel with that name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// POST /api/pulse/channels/:id/join — caller joins a public channel.
router.post('/:id/join', async (req, res) => {
  const channelId = req.params.id;
  try {
    const { rows } = await query(`SELECT is_private FROM chat_channels WHERE id = $1`, [channelId]);
    if (!rows.length) return res.status(404).json({ error: 'Channel not found' });
    if (rows[0].is_private && !(await isOwner(req.userId))) {
      return res.status(403).json({ error: 'Private channel — ask an existing member to invite you' });
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

// POST /api/pulse/channels/:id/leave — caller leaves the channel.
router.post('/:id/leave', async (req, res) => {
  const channelId = req.params.id;
  try {
    const { rows } = await query(`SELECT slug FROM chat_channels WHERE id = $1`, [channelId]);
    if (rows[0]?.slug === 'general') {
      return res.status(400).json({ error: "You can't leave #general" });
    }
    await query(
      `DELETE FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2`,
      [channelId, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

// POST /api/pulse/channels/:id/members   { user_id }
router.post('/:id/members', async (req, res) => {
  const channelId = req.params.id;
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    if (!(await isOwner(req.userId)) && !(await isMember(channelId, req.userId))) {
      return res.status(403).json({ error: 'Only channel members can add others' });
    }
    await query(`
      INSERT INTO chat_channel_members (channel_id, user_id, role)
      VALUES ($1, $2, 'member')
      ON CONFLICT (channel_id, user_id) DO NOTHING
    `, [channelId, user_id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(404).json({ error: 'Channel or user not found' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// DELETE /api/pulse/channels/:id/members/:userId
router.delete('/:id/members/:userId', async (req, res) => {
  const channelId = req.params.id;
  const targetUserId = req.params.userId;
  try {
    const slugRow = await query(`SELECT slug FROM chat_channels WHERE id = $1`, [channelId]);
    if (slugRow.rows[0]?.slug === 'general' && targetUserId === req.userId) {
      return res.status(400).json({ error: "You can't leave #general" });
    }
    if (targetUserId !== req.userId
        && !(await isAdmin(channelId, req.userId))
        && !(await isOwner(req.userId))) {
      return res.status(403).json({ error: 'Only channel admins can remove other members' });
    }
    await query(
      `DELETE FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2`,
      [channelId, targetUserId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// POST /api/pulse/channels/:id/read — set caller's last_read_at = NOW().
// Called when the user opens the channel or focuses the tab. Idempotent.
router.post('/:id/read', async (req, res) => {
  const channelId = req.params.id;
  try {
    const upd = await query(
      `UPDATE chat_channel_members SET last_read_at = NOW()
        WHERE channel_id = $1 AND user_id = $2`,
      [channelId, req.userId]
    );
    if (upd.rowCount === 0) {
      // Owners can read channels they're not a member of; nothing to track.
      // Treat as no-op success so the frontend doesn't error noisily.
      return res.json({ ok: true, noop: true });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update read' });
  }
});

// GET /api/pulse/channels/:id/members — list members with display names.
router.get('/:id/members', async (req, res) => {
  const channelId = req.params.id;
  try {
    if (!(await isOwner(req.userId)) && !(await isMember(channelId, req.userId))) {
      return res.status(403).json({ error: 'Not a member of this channel' });
    }
    const { rows } = await query(`
      SELECT m.user_id, m.role, m.joined_at,
             u.full_name, u.email, u.avatar_url
        FROM chat_channel_members m
        LEFT JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = $1
       ORDER BY m.role DESC, u.full_name ASC NULLS LAST, u.email ASC
    `, [channelId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load members' });
  }
});

// ── Archive / unarchive ─────────────────────────────────────────────────
// An archived channel disappears from the default sidebar list but keeps its
// members and message history. Anyone can unarchive it via the "Show archived"
// view. #general can never be archived. Authz: channel admin or account owner.

async function canArchiveChannel(channelId, userId) {
  if (await isOwner(userId)) return true;
  return await isAdmin(channelId, userId);
}

// POST /api/pulse/channels/:id/archive
router.post('/:id/archive', async (req, res) => {
  const channelId = req.params.id;
  try {
    const slugRow = await query(`SELECT slug, archived_at FROM chat_channels WHERE id = $1`, [channelId]);
    if (!slugRow.rows.length) return res.status(404).json({ error: 'Channel not found' });
    if (slugRow.rows[0].slug === 'general') {
      return res.status(400).json({ error: "You can't archive #general" });
    }
    if (slugRow.rows[0].archived_at) {
      return res.json({ ok: true, already_archived: true });
    }
    if (!(await canArchiveChannel(channelId, req.userId))) {
      return res.status(403).json({ error: 'Only channel admins or account owners can archive a channel' });
    }
    await query(
      `UPDATE chat_channels SET archived_at = NOW(), archived_by = $2 WHERE id = $1`,
      [channelId, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to archive channel' });
  }
});

// POST /api/pulse/channels/:id/unarchive
router.post('/:id/unarchive', async (req, res) => {
  const channelId = req.params.id;
  try {
    const row = await query(`SELECT archived_at FROM chat_channels WHERE id = $1`, [channelId]);
    if (!row.rows.length) return res.status(404).json({ error: 'Channel not found' });
    if (!row.rows[0].archived_at) {
      return res.json({ ok: true, already_active: true });
    }
    if (!(await canArchiveChannel(channelId, req.userId))) {
      return res.status(403).json({ error: 'Only channel admins or account owners can unarchive a channel' });
    }
    await query(
      `UPDATE chat_channels SET archived_at = NULL, archived_by = NULL WHERE id = $1`,
      [channelId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unarchive channel' });
  }
});

module.exports = router;
