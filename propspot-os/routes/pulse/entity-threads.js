const express = require('express');
const { query } = require('../../db');
const { requireAuth, requirePulseGrant } = require('../../middleware/auth');
const { canAccessEntity, isEntityTypeSupported } = require('../../lib/authz');
const { parseMentions, writeMentionRows, writeEntityThreadGrants } = require('../../lib/mentions');
const hub = require('../../lib/hub');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

function streamKey(entityThreadId) {
  return `et:${entityThreadId}`;
}

async function hydrateMessage(row) {
  const { rows } = await query(
    `SELECT full_name, email FROM users WHERE id = $1`,
    [row.sender_id]
  );
  const s = rows[0] || {};
  return { ...row, sender_name: s.full_name || s.email || 'Unknown', sender_email: s.email || null };
}

// GET /api/pulse/entity-threads?type=inbox_thread&id=<uuid>
// Returns { thread, messages }. Lazy-creates the thread row on first read by an authorized user.
router.get('/', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  if (!entity_type || !entity_id) {
    return res.status(400).json({ error: 'type and id query params required' });
  }
  if (!isEntityTypeSupported(entity_type)) {
    return res.status(400).json({ error: 'unsupported entity_type' });
  }
  try {
    const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
    if (!access.allowed) return res.status(403).json({ error: 'No access' });

    const { rows: tRows } = await query(
      `SELECT id, entity_type, entity_id, created_at, updated_at
         FROM pulse_entity_threads WHERE id = $1`,
      [access.entityThreadId]
    );
    const { rows: mRows } = await query(`
      SELECT m.*, u.full_name AS sender_name, u.email AS sender_email
        FROM chat_messages m
        LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.entity_thread_id = $1
         AND m.deleted_at IS NULL
    ORDER BY m.created_at ASC
    `, [access.entityThreadId]);

    // caller_user_id lets the widget show edit/delete controls only on
    // messages the caller authored (server-side PATCH/DELETE re-check the
    // same condition; this is just for hiding the UI).
    res.json({ thread: tRows[0], messages: mRows, caller_user_id: req.userId });
  } catch (err) {
    console.error('entity-threads GET failed:', err);
    res.status(500).json({ error: 'Failed to load entity thread' });
  }
});

// POST /api/pulse/entity-threads/messages?type=inbox_thread&id=<uuid>
// Body: { body, client_message_id? }
router.post('/messages', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  const { body, client_message_id } = req.body || {};
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'type and id required' });
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  if (!body || typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (body.length > 8000) return res.status(413).json({ error: 'message too long (8000 char max)' });

  try {
    const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
    if (!access.allowed) return res.status(403).json({ error: 'No access' });

    const ins = await query(`
      INSERT INTO chat_messages (entity_thread_id, sender_id, client_message_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [access.entityThreadId, req.userId, client_message_id || null, body.trim()]);
    const message = ins.rows[0];

    // Mentions + grants are best-effort. Failures here must NOT roll back the
    // saved message or fail the response — the caller already has a saved row
    // and a retry would hit the dedupe path returning the same row.
    let validIds = [];
    try {
      const mentionedIds = parseMentions(body);
      validIds = await writeMentionRows(message.id, mentionedIds);
      await writeEntityThreadGrants(access.entityThreadId, validIds, req.userId);
    } catch (mentionErr) {
      console.warn('entity-threads mention/grant write failed (message still saved):', mentionErr);
    }

    const enriched = await hydrateMessage(message);
    hub.publish(streamKey(access.entityThreadId), {
      type: 'entity_thread.message_created',
      entity_type, entity_id,
      entity_thread_id: access.entityThreadId,
      message: enriched,
      mentions: validIds
    });

    res.json(enriched);
  } catch (err) {
    if (err.code === '23505' && client_message_id) {
      // Optimistic-dedupe path: client retried with the same client_message_id
      const { rows } = await query(
        `SELECT * FROM chat_messages WHERE sender_id = $1 AND client_message_id = $2`,
        [req.userId, client_message_id]
      );
      if (rows.length) return res.json(await hydrateMessage(rows[0]));
    }
    console.error('entity-threads POST failed:', err);
    res.status(500).json({ error: 'Failed to post message' });
  }
});

// PATCH /api/pulse/entity-threads/messages/:id — edit own message
router.patch('/messages/:id', async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  try {
    const { rows } = await query(`
      UPDATE chat_messages
         SET body = $1, edited_at = NOW()
       WHERE id = $2 AND sender_id = $3 AND deleted_at IS NULL
     RETURNING *
    `, [body.trim(), req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found or not yours' });

    const enriched = await hydrateMessage(rows[0]);
    if (rows[0].entity_thread_id) {
      hub.publish(streamKey(rows[0].entity_thread_id), {
        type: 'entity_thread.message_updated',
        entity_thread_id: rows[0].entity_thread_id,
        message: enriched
      });
    }
    res.json(enriched);
  } catch (err) {
    console.error('entity-threads PATCH failed:', err);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE /api/pulse/entity-threads/messages/:id — soft-delete own message
router.delete('/messages/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      UPDATE chat_messages SET deleted_at = NOW()
       WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
     RETURNING id, entity_thread_id
    `, [req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found or not yours' });

    if (rows[0].entity_thread_id) {
      hub.publish(streamKey(rows[0].entity_thread_id), {
        type: 'entity_thread.message_deleted',
        entity_thread_id: rows[0].entity_thread_id,
        message_id: rows[0].id
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('entity-threads DELETE failed:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// GET /api/pulse/entity-threads/mentionable-users?type=inbox_thread&id=<uuid>
// Returns full team list; users with ambient access first.
router.get('/mentionable-users', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  try {
    const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
    if (!access.allowed) return res.status(403).json({ error: 'No access' });

    // View name is whitelisted via isEntityTypeSupported; safe to interpolate.
    const viewName = `pulse_authz_${entity_type}`;
    const { rows } = await query(`
      SELECT u.id, u.full_name, u.email, TRUE AS has_ambient
        FROM users u
        JOIN ${viewName} v ON v.user_id = u.id AND v.entity_id = $1
     UNION
      SELECT u.id, u.full_name, u.email, FALSE AS has_ambient
        FROM users u
       WHERE NOT EXISTS (
         SELECT 1 FROM ${viewName} v
          WHERE v.user_id = u.id AND v.entity_id = $1
       )
     ORDER BY has_ambient DESC, full_name ASC NULLS LAST, email ASC
    `, [entity_id]);
    res.json(rows);
  } catch (err) {
    console.error('mentionable-users failed:', err);
    res.status(500).json({ error: 'Failed to load mentionable users' });
  }
});

// GET /api/pulse/entity-threads/unread-counts?type=inbox_thread
// Returns [{ entity_id, unread_mention_count }] for the caller.
router.get('/unread-counts', async (req, res) => {
  const entity_type = req.query.type;
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  try {
    const { rows } = await query(`
      SELECT et.entity_id, COUNT(*)::int AS unread_mention_count
        FROM chat_mentions cm
        JOIN chat_messages m         ON m.id = cm.message_id
        JOIN pulse_entity_threads et ON et.id = m.entity_thread_id
   LEFT JOIN pulse_entity_thread_reads r
          ON r.entity_thread_id = et.id AND r.user_id = $1
       WHERE cm.mentioned_user_id = $1
         AND et.entity_type = $2
         AND m.deleted_at IS NULL
         AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
    GROUP BY et.entity_id
    `, [req.userId, entity_type]);
    res.json(rows);
  } catch (err) {
    console.error('unread-counts failed:', err);
    res.status(500).json({ error: 'Failed to load unread counts' });
  }
});

// POST /api/pulse/entity-threads/mark-read?type=inbox_thread&id=<uuid>
// Records that the caller has seen everything on this thread up to NOW().
router.post('/mark-read', async (req, res) => {
  const entity_type = req.query.type;
  const entity_id   = req.query.id;
  if (!isEntityTypeSupported(entity_type)) return res.status(400).json({ error: 'unsupported entity_type' });
  try {
    const access = await canAccessEntity({ userId: req.userId, entityType: entity_type, entityId: entity_id });
    if (!access.allowed) return res.status(403).json({ error: 'No access' });
    await query(`
      INSERT INTO pulse_entity_thread_reads (entity_thread_id, user_id, last_read_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (entity_thread_id, user_id) DO UPDATE SET last_read_at = NOW()
    `, [access.entityThreadId, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('mark-read failed:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

module.exports = router;
