const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/mentions — unified mentions from Pulse, Inbox, Tasks, and FieldCam
router.get('/', async (req, res) => {
  try {
    const me = req.userId;

    // Pulse mentions — split by target:
    //   - channel / DM     → source='pulse'
    //   - inbox_thread     → source='inbox'  (Pulse comment on an email thread)
    //   - other entity_thread (property, photo, etc.) → source='pulse'
    const { rows: pulseMentions } = await query(`
      SELECT
        CASE
          WHEN et.entity_type = 'inbox_thread' THEN 'inbox'
          ELSE 'pulse'
        END AS source,
        cm.created_at,
        m.id AS source_id,
        m.body AS body,
        u.full_name AS author_name,
        u.avatar_url AS author_avatar,
        COALESCE(
          NULLIF(ch.name, ''),
          NULLIF(it.subject, ''),
          ''
        ) AS context_name,
        COALESCE(m.channel_id, et.entity_id) AS context_id,
        m.channel_id,
        m.dm_id,
        NULL AS task_id,
        NULL AS photo_id,
        CASE WHEN et.entity_type = 'inbox_thread' THEN et.entity_id ELSE NULL END AS inbox_thread_id
      FROM chat_mentions cm
      JOIN chat_messages m ON m.id = cm.message_id
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN chat_channels ch ON ch.id = m.channel_id
      LEFT JOIN pulse_entity_threads et ON et.id = m.entity_thread_id
      LEFT JOIN inbox_threads it ON et.entity_type = 'inbox_thread' AND it.id = et.entity_id
      WHERE cm.mentioned_user_id = $1
      ORDER BY cm.created_at DESC
      LIMIT 50
    `, [me]);

    // Task comment mentions
    const { rows: taskMentions } = await query(`
      SELECT
        'task' AS source,
        tm.created_at,
        tc.id AS source_id,
        tc.body AS body,
        u.full_name AS author_name,
        u.avatar_url AS author_avatar,
        t.title AS context_name,
        t.id AS context_id,
        t.id AS task_id,
        NULL AS photo_id
      FROM task_mentions tm
      JOIN task_comments tc ON tc.id = tm.comment_id
      JOIN users u ON u.id = tc.user_id
      JOIN tasks t ON t.id = tm.task_id
      WHERE tm.mentioned_user_id = $1
      ORDER BY tm.created_at DESC
      LIMIT 50
    `, [me]);

    // FieldCam comment mentions (text-search based)
    const { rows: [meUser] } = await query(`SELECT full_name FROM users WHERE id = $1`, [me]);
    let fieldcamMentions = [];
    if (meUser && meUser.full_name) {
      const { rows } = await query(`
        SELECT
          'fieldcam' AS source,
          c.created_at,
          c.id AS source_id,
          c.body AS body,
          u.full_name AS author_name,
          u.avatar_url AS author_avatar,
          COALESCE(p.address_line1, 'Photo') AS context_name,
          ph.id AS context_id,
          NULL AS task_id,
          ph.id AS photo_id
        FROM comments c
        JOIN users u ON u.id = c.user_id
        JOIN photos ph ON ph.id = c.photo_id
        LEFT JOIN properties p ON p.id = ph.property_id
        WHERE c.body ILIKE '%@' || $1 || '%'
          AND c.user_id != $2
        ORDER BY c.created_at DESC
        LIMIT 50
      `, [meUser.full_name, me]);
      fieldcamMentions = rows;
    }

    // Merge and sort by date
    const all = [...pulseMentions, ...taskMentions, ...fieldcamMentions]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100);

    // Annotate with is_read using user_mention_reads. The DB source key
    // normalizes 'pulse' + 'inbox' (both share chat_messages.id space)
    // into 'pulse'.
    if (all.length) {
      const dbSourceOf = s => (s === 'inbox' ? 'pulse' : s);
      const keys = all.map(m => [dbSourceOf(m.source), m.source_id]);
      const sources = keys.map(([s]) => s);
      const ids     = keys.map(([, id]) => id);
      const { rows: reads } = await query(`
        SELECT source, source_id FROM user_mention_reads
         WHERE user_id = $1
           AND (source, source_id) IN (
             SELECT * FROM UNNEST($2::text[], $3::uuid[])
           )
      `, [me, sources, ids]);
      const readSet = new Set(reads.map(r => `${r.source}|${r.source_id}`));
      for (const m of all) {
        m.is_read = readSet.has(`${dbSourceOf(m.source)}|${m.source_id}`);
      }
    }

    res.json(all);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load mentions' });
  }
});

// POST /api/mentions/:source/:source_id/read — mark one mention as read
router.post('/:source/:source_id/read', async (req, res) => {
  // Normalize "inbox" alias → "pulse" (both share chat_messages.id).
  const source = req.params.source === 'inbox' ? 'pulse' : req.params.source;
  if (!['pulse','task','fieldcam'].includes(source)) {
    return res.status(400).json({ error: 'unsupported source' });
  }
  try {
    await query(`
      INSERT INTO user_mention_reads (user_id, source, source_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, source, source_id) DO UPDATE SET read_at = NOW()
    `, [req.userId, source, req.params.source_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('mark mention read failed:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// POST /api/mentions/read-all — mark every currently-visible mention read
router.post('/read-all', async (req, res) => {
  // Re-run the same UNION as GET / and insert read rows for each.
  const me = req.userId;
  try {
    // pulse + inbox both → 'pulse' bucket
    await query(`
      INSERT INTO user_mention_reads (user_id, source, source_id)
      SELECT $1, 'pulse', m.id
        FROM chat_mentions cm
        JOIN chat_messages m ON m.id = cm.message_id
       WHERE cm.mentioned_user_id = $1
      ON CONFLICT (user_id, source, source_id) DO NOTHING
    `, [me]);
    await query(`
      INSERT INTO user_mention_reads (user_id, source, source_id)
      SELECT $1, 'task', tc.id
        FROM task_mentions tm
        JOIN task_comments tc ON tc.id = tm.comment_id
       WHERE tm.mentioned_user_id = $1
      ON CONFLICT (user_id, source, source_id) DO NOTHING
    `, [me]);
    const { rows: [u] } = await query(`SELECT full_name FROM users WHERE id = $1`, [me]);
    if (u?.full_name) {
      await query(`
        INSERT INTO user_mention_reads (user_id, source, source_id)
        SELECT $1, 'fieldcam', c.id
          FROM comments c
         WHERE c.body ILIKE '%@' || $2 || '%'
           AND c.user_id <> $1
        ON CONFLICT (user_id, source, source_id) DO NOTHING
      `, [me, u.full_name]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('mark all mentions read failed:', err);
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

module.exports = router;
