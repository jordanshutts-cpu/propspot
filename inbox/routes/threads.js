const express = require('express');
const { query } = require('../db');
const { requireAuth, requireInboxGrant } = require('../middleware/auth');
const { scopedInboxIds } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

// Helper: confirm the caller can see the given thread (by its shared_inbox_id).
async function assertThreadAccess(req, threadId) {
  const allowed = await scopedInboxIds(req.inboxGrant.scope);
  const { rows } = await query(
    `SELECT id, shared_inbox_id FROM inbox_threads WHERE id = $1`,
    [threadId]
  );
  if (!rows[0]) return { error: 'Thread not found', status: 404 };
  if (allowed === null) return { thread: rows[0] }; // unrestricted
  if (!rows[0].shared_inbox_id) return { error: 'Thread is unrouted', status: 403 };
  if (!allowed.includes(rows[0].shared_inbox_id)) return { error: 'No access to this thread', status: 403 };
  return { thread: rows[0] };
}

// GET /api/threads?inbox=<slug>&status=open&limit=50
router.get('/', async (req, res) => {
  try {
    const allowed = await scopedInboxIds(req.inboxGrant.scope);
    const where = [];
    const params = [];
    let i = 1;

    if (allowed !== null) {
      if (!allowed.length) return res.json([]);
      params.push(allowed);
      where.push(`t.shared_inbox_id = ANY($${i++}::uuid[])`);
    }
    if (req.query.inbox) {
      params.push(req.query.inbox);
      where.push(`i.slug = $${i++}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`t.status = $${i++}`);
    } else {
      where.push(`t.status = 'open'`);
    }
    if (req.query.property_id) {
      params.push(req.query.property_id);
      where.push(`t.property_id = $${i++}`);
    }
    if (req.query.assigned_to_me === '1') {
      params.push(req.userId);
      where.push(`t.assigned_to_user_id = $${i++}`);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const sql = `
      SELECT t.id, t.subject, t.participants, t.last_message_at, t.message_count,
             t.has_attachments, t.unread, t.status, t.property_id, t.assigned_to_user_id,
             i.slug AS inbox_slug, i.name AS inbox_name, i.icon AS inbox_icon,
             p.address_line1, p.city, p.state,
             u.full_name AS assigned_name
        FROM inbox_threads t
   LEFT JOIN inbox_shared i ON i.id = t.shared_inbox_id
   LEFT JOIN properties p   ON p.id = t.property_id
   LEFT JOIN users u        ON u.id = t.assigned_to_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.last_message_at DESC
       LIMIT ${limit}
    `;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// GET /api/threads/:id — thread + messages.
router.get('/:id', async (req, res) => {
  const access = await assertThreadAccess(req, req.params.id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows: tRows } = await query(`
    SELECT t.*,
           i.slug AS inbox_slug, i.name AS inbox_name, i.icon AS inbox_icon,
           p.address_line1, p.city, p.state, p.unit,
           u.full_name AS assigned_name
      FROM inbox_threads t
 LEFT JOIN inbox_shared i ON i.id = t.shared_inbox_id
 LEFT JOIN properties p   ON p.id = t.property_id
 LEFT JOIN users u        ON u.id = t.assigned_to_user_id
     WHERE t.id = $1
  `, [req.params.id]);
  const thread = tRows[0];

  const { rows: messages } = await query(`
    SELECT m.id, m.from_email, m.from_name, m.to_emails, m.cc_emails,
           m.delivered_to_alias, m.subject, m.snippet, m.body_html, m.body_text,
           m.received_at, m.is_outbound, m.sent_by_user_id,
           u.full_name AS sent_by_name,
           (SELECT json_agg(json_build_object(
             'id', a.id, 'filename', a.filename, 'mime_type', a.mime_type,
             'size_bytes', a.size_bytes, 'saved', EXISTS(
               SELECT 1 FROM inbox_attachment_saves s WHERE s.attachment_id = a.id
             )
           )) FROM inbox_attachments a WHERE a.message_id = m.id) AS attachments
      FROM inbox_messages m
 LEFT JOIN users u ON u.id = m.sent_by_user_id
     WHERE m.thread_id = $1
  ORDER BY m.received_at ASC
  `, [req.params.id]);

  // Mark thread as read on first view.
  if (thread.unread) {
    await query(`UPDATE inbox_threads SET unread = FALSE WHERE id = $1`, [thread.id]);
    thread.unread = false;
  }

  res.json({ ...thread, messages });
});

// PATCH /api/threads/:id — update assignment, property tag, status.
router.patch('/:id', async (req, res) => {
  const access = await assertThreadAccess(req, req.params.id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const sets = [];
  const vals = [];
  let i = 1;

  if (req.body.assigned_to_user_id !== undefined) {
    sets.push(`assigned_to_user_id = $${i++}`);
    vals.push(req.body.assigned_to_user_id || null);
  }
  if (req.body.property_id !== undefined) {
    sets.push(`property_id = $${i++}, tagged_at = NOW(), tagged_by = $${i++}`);
    vals.push(req.body.property_id || null);
    vals.push(req.userId);
  }
  if (req.body.status !== undefined) {
    sets.push(`status = $${i++}`);
    vals.push(req.body.status);
    if (req.body.status === 'snoozed' && req.body.snooze_until) {
      sets.push(`snooze_until = $${i++}`);
      vals.push(req.body.snooze_until);
    }
    if (req.body.status === 'open') {
      sets.push(`snooze_until = NULL`);
    }
  }
  if (req.body.unread !== undefined) {
    sets.push(`unread = $${i++}`);
    vals.push(!!req.body.unread);
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

  vals.push(req.params.id);
  const { rows } = await query(
    `UPDATE inbox_threads SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });
  res.json(rows[0]);
});

module.exports = router;
