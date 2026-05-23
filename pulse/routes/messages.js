const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');
const hub = require('../lib/hub');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// ── Scope helpers ──────────────────────────────────────────────────────────
// A message lives in exactly one scope: a channel, a DM, or an entity_thread.
// For the v2 feature pack we handle channels + DMs. entity_thread routes live
// in the inbox satellite.

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

async function userHasDm(userId, dmId) {
  const { rows } = await query(
    `SELECT 1 FROM chat_dm_members WHERE dm_id = $1 AND user_id = $2 LIMIT 1`,
    [dmId, userId]
  );
  return rows.length > 0;
}

// Returns recipient user_ids for the scope (used for unread/mention fanout).
async function scopeRecipients({ channel_id, dm_id }) {
  if (channel_id) {
    const { rows } = await query(
      `SELECT user_id FROM chat_channel_members WHERE channel_id = $1`,
      [channel_id]
    );
    return rows.map(r => r.user_id);
  }
  if (dm_id) {
    const { rows } = await query(
      `SELECT user_id FROM chat_dm_members WHERE dm_id = $1`,
      [dm_id]
    );
    return rows.map(r => r.user_id);
  }
  return [];
}

function scopeKey({ channel_id, dm_id }) {
  if (channel_id) return 'channel:' + channel_id;
  if (dm_id)      return 'dm:' + dm_id;
  return null;
}

// ── Mention parsing ────────────────────────────────────────────────────────
// Quill mention blots render as <span class="pulse-mention" data-uid="UUID">@Name</span>.
// We extract the UUIDs, then validate that each is a current member of the scope
// before writing chat_mentions or firing notifications.

function extractMentionUids(body) {
  if (!body || typeof body !== 'string') return [];
  const re = /data-uid="([0-9a-fA-F-]{36})"/g;
  const out = new Set();
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return Array.from(out);
}

async function filterMentionsToMembers(uids, scope) {
  if (!uids.length) return [];
  if (scope.channel_id) {
    const { rows } = await query(
      `SELECT user_id FROM chat_channel_members
        WHERE channel_id = $1 AND user_id = ANY($2::uuid[])`,
      [scope.channel_id, uids]
    );
    return rows.map(r => r.user_id);
  }
  if (scope.dm_id) {
    const { rows } = await query(
      `SELECT user_id FROM chat_dm_members
        WHERE dm_id = $1 AND user_id = ANY($2::uuid[])`,
      [scope.dm_id, uids]
    );
    return rows.map(r => r.user_id);
  }
  return [];
}

// ── Message hydration ──────────────────────────────────────────────────────

async function hydrateMessage(row) {
  // Sender info
  const sRes = await query(
    `SELECT full_name, email, avatar_url FROM users WHERE id = $1`,
    [row.sender_id]
  );
  const sender = sRes.rows[0] || {};

  // Attachments
  const aRes = await query(
    `SELECT id, url, cloudinary_id, mime_type, size_bytes, filename
       FROM chat_attachments
      WHERE message_id = $1
      ORDER BY created_at ASC`,
    [row.id]
  );

  // Mentions (with names)
  const mRes = await query(
    `SELECT cm.mentioned_user_id, u.full_name, u.email
       FROM chat_mentions cm
       LEFT JOIN users u ON u.id = cm.mentioned_user_id
      WHERE cm.message_id = $1`,
    [row.id]
  );

  return {
    ...row,
    sender_name: sender.full_name || sender.email || 'Unknown',
    sender_email: sender.email || null,
    sender_avatar_url: sender.avatar_url || null,
    attachments: aRes.rows,
    mentions: mRes.rows.map(r => ({
      user_id: r.mentioned_user_id,
      name: r.full_name || r.email || 'Unknown'
    }))
  };
}

// Lighter hydrator for the GET list — joins sender inline, then fetches
// attachments/mentions in batched follow-up queries.
async function hydrateMessages(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);

  const aRes = await query(
    `SELECT message_id, id, url, cloudinary_id, mime_type, size_bytes, filename
       FROM chat_attachments
      WHERE message_id = ANY($1::uuid[])
      ORDER BY created_at ASC`,
    [ids]
  );
  const attsByMsg = new Map();
  for (const r of aRes.rows) {
    const arr = attsByMsg.get(r.message_id) || [];
    arr.push(r);
    attsByMsg.set(r.message_id, arr);
  }

  const mRes = await query(
    `SELECT cm.message_id, cm.mentioned_user_id, u.full_name, u.email
       FROM chat_mentions cm
       LEFT JOIN users u ON u.id = cm.mentioned_user_id
      WHERE cm.message_id = ANY($1::uuid[])`,
    [ids]
  );
  const mentByMsg = new Map();
  for (const r of mRes.rows) {
    const arr = mentByMsg.get(r.message_id) || [];
    arr.push({
      user_id: r.mentioned_user_id,
      name: r.full_name || r.email || 'Unknown'
    });
    mentByMsg.set(r.message_id, arr);
  }

  return rows.map(r => ({
    ...r,
    attachments: attsByMsg.get(r.id) || [],
    mentions: mentByMsg.get(r.id) || []
  }));
}

// ── Write mention rows + fanout ────────────────────────────────────────────
async function writeMentionsAndNotify(messageId, body, scope, message, alreadyMentioned = []) {
  const raw = extractMentionUids(body);
  const valid = await filterMentionsToMembers(raw, scope);
  if (!valid.length) return [];

  // Insert (ignore duplicates)
  for (const uid of valid) {
    await query(
      `INSERT INTO chat_mentions (message_id, mentioned_user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [messageId, uid]
    );
  }

  // Notify any newly-added mentions (not already in `alreadyMentioned`)
  const already = new Set(alreadyMentioned);
  for (const uid of valid) {
    if (already.has(uid)) continue;
    if (uid === message.sender_id) continue; // don't notify self
    hub.publish('user:' + uid, { type: 'mention', message });
  }
  return valid;
}

// ── Unread fanout ──────────────────────────────────────────────────────────
// After a message is posted, push unread_update to every recipient EXCEPT the
// sender. Each recipient's frontend then re-computes its sidebar dot.
async function publishUnreadFanout(scope, senderId) {
  const recipients = await scopeRecipients(scope);
  for (const uid of recipients) {
    if (uid === senderId) continue;
    hub.publish('user:' + uid, {
      type: 'unread_update',
      channel_id: scope.channel_id || null,
      dm_id: scope.dm_id || null
    });
  }
}

// ── POST /api/pulse/messages  {channel_id|dm_id, body, client_message_id?, attachments?[]} ──
router.post('/', async (req, res) => {
  const { channel_id, dm_id, body, client_message_id, attachments } = req.body || {};

  // Exactly one of channel_id / dm_id required
  if ((!channel_id && !dm_id) || (channel_id && dm_id)) {
    return res.status(400).json({ error: 'Exactly one of channel_id or dm_id required' });
  }
  if ((!body || typeof body !== 'string' || !body.trim()) && !(Array.isArray(attachments) && attachments.length)) {
    return res.status(400).json({ error: 'body or attachments required' });
  }
  if (body && body.length > 16000) {
    return res.status(413).json({ error: 'message too long (16000 char max)' });
  }

  // Membership check
  if (channel_id && !(await userHasChannel(req.userId, channel_id))) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }
  if (dm_id && !(await userHasDm(req.userId, dm_id))) {
    return res.status(403).json({ error: 'Not a member of this DM' });
  }

  const scope = { channel_id, dm_id };
  const cleanBody = (body || '').trim();

  try {
    const ins = await query(`
      INSERT INTO chat_messages (channel_id, dm_id, sender_id, client_message_id, body)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [channel_id || null, dm_id || null, req.userId, client_message_id || null, cleanBody]);

    const row = ins.rows[0];

    // Persist attachments (if any)
    if (Array.isArray(attachments) && attachments.length) {
      for (const a of attachments.slice(0, 10)) {
        if (!a || !a.url) continue;
        await query(`
          INSERT INTO chat_attachments
            (message_id, url, cloudinary_id, mime_type, size_bytes, filename)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          row.id,
          a.url,
          a.cloudinary_id || null,
          a.mime_type || null,
          a.size_bytes || null,
          a.filename || null
        ]);
      }
    }

    // Hydrate then broadcast — order matters: mentions need the hydrated payload.
    const enriched = await hydrateMessage(row);
    await writeMentionsAndNotify(row.id, cleanBody, scope, enriched, []);
    // Re-hydrate mentions in case writeMentions added new ones
    enriched.mentions = (await hydrateMessage(row)).mentions;

    hub.publish(scopeKey(scope), { type: 'message', message: enriched });
    await publishUnreadFanout(scope, req.userId);

    return res.json(enriched);
  } catch (err) {
    if (err.code === '23505' && client_message_id) {
      // Replay of a deduped client_message_id — return the existing row.
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

// ── PATCH /api/pulse/messages/:id  { body } — author only, body only ────────
router.patch('/:id', async (req, res) => {
  const messageId = req.params.id;
  const { body } = req.body || {};
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body required' });
  }
  if (body.length > 16000) {
    return res.status(413).json({ error: 'message too long (16000 char max)' });
  }

  try {
    const { rows } = await query(
      `SELECT * FROM chat_messages WHERE id = $1 AND deleted_at IS NULL`,
      [messageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const msg = rows[0];
    if (msg.sender_id !== req.userId) {
      return res.status(403).json({ error: 'Only the author can edit a message' });
    }

    const scope = { channel_id: msg.channel_id, dm_id: msg.dm_id };

    // Capture existing mentions BEFORE we update, so we only notify newly added ones.
    const prev = await query(
      `SELECT mentioned_user_id FROM chat_mentions WHERE message_id = $1`,
      [messageId]
    );
    const previouslyMentioned = prev.rows.map(r => r.mentioned_user_id);

    const cleanBody = body.trim();
    const upd = await query(
      `UPDATE chat_messages SET body = $1, edited_at = NOW()
        WHERE id = $2 RETURNING *`,
      [cleanBody, messageId]
    );

    // Re-derive mentions from the new body. Wipe old, then re-write valid ones.
    await query(`DELETE FROM chat_mentions WHERE message_id = $1`, [messageId]);

    const enriched = await hydrateMessage(upd.rows[0]);
    await writeMentionsAndNotify(messageId, cleanBody, scope, enriched, previouslyMentioned);
    enriched.mentions = (await hydrateMessage(upd.rows[0])).mentions;

    hub.publish(scopeKey(scope), { type: 'message_updated', message: enriched });
    return res.json(enriched);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to edit message' });
  }
});

// ── DELETE /api/pulse/messages/:id — author only, soft delete ──────────────
router.delete('/:id', async (req, res) => {
  const messageId = req.params.id;
  try {
    const { rows } = await query(
      `SELECT * FROM chat_messages WHERE id = $1 AND deleted_at IS NULL`,
      [messageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Message not found' });
    const msg = rows[0];
    if (msg.sender_id !== req.userId) {
      return res.status(403).json({ error: 'Only the author can delete a message' });
    }

    await query(
      `UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1`,
      [messageId]
    );

    const scope = { channel_id: msg.channel_id, dm_id: msg.dm_id };
    hub.publish(scopeKey(scope), {
      type: 'message_deleted',
      message_id: messageId,
      channel_id: msg.channel_id || null,
      dm_id: msg.dm_id || null
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ── GET /api/pulse/messages?channel_id=|dm_id=  [&before=&limit=] ─────────
router.get('/', async (req, res) => {
  const channel_id = req.query.channel_id || null;
  const dm_id = req.query.dm_id || null;
  if ((!channel_id && !dm_id) || (channel_id && dm_id)) {
    return res.status(400).json({ error: 'Exactly one of channel_id or dm_id required' });
  }
  if (channel_id && !(await userHasChannel(req.userId, channel_id))) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }
  if (dm_id && !(await userHasDm(req.userId, dm_id))) {
    return res.status(403).json({ error: 'Not a member of this DM' });
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 100));
  const before = req.query.before ? new Date(req.query.before) : null;
  const params = [];
  let whereScope, idx = 1;
  if (channel_id) { whereScope = `m.channel_id = $${idx++}`; params.push(channel_id); }
  else            { whereScope = `m.dm_id      = $${idx++}`; params.push(dm_id); }

  let beforeClause = '';
  if (before && !isNaN(before)) {
    beforeClause = `AND m.created_at < $${idx++}`;
    params.push(before.toISOString());
  }
  params.push(limit);

  const sql = `
    SELECT m.*, u.full_name AS sender_name, u.email AS sender_email,
           u.avatar_url AS sender_avatar_url
      FROM chat_messages m
      LEFT JOIN users u ON u.id = m.sender_id
     WHERE ${whereScope}
       AND m.deleted_at IS NULL
       ${beforeClause}
     ORDER BY m.created_at DESC
     LIMIT $${idx}
  `;
  const { rows } = await query(sql, params);
  const hydrated = await hydrateMessages(rows);

  res.json({
    messages: hydrated.reverse(),
    has_more: rows.length === limit
  });
});

module.exports = router;
