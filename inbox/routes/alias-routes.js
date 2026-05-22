const express = require('express');
const { query } = require('../db');
const { requireAuth, requireInboxGrant, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

// GET /api/alias-routes — list every discovered alias across every mailbox,
// plus whether it's already routed.
router.get('/', requireOwner, async (req, res) => {
  const { rows: routed } = await query(`
    SELECT r.id, r.mailbox_id, r.alias_email, r.shared_inbox_id, r.detected_at,
           m.email AS mailbox_email,
           i.name  AS shared_inbox_name,
           i.slug  AS shared_inbox_slug,
           i.icon  AS shared_inbox_icon
      FROM inbox_alias_routes r
      JOIN inbox_mailboxes m ON m.id = r.mailbox_id
      JOIN inbox_shared i    ON i.id = r.shared_inbox_id
  ORDER BY m.email, r.alias_email
  `);
  // Unrouted alias candidates. Defense-in-depth filters (in case any bogus
  // delivered_to_alias values were recorded before the threading.js fix):
  //   - only inbound messages (msg.is_outbound = FALSE) — outbound message
  //     recipients are NOT aliases on the mailbox
  //   - only addresses on the SAME DOMAIN as the mailbox — external
  //     addresses in Reply-All threads are recipients, not aliases
  const { rows: unrouted } = await query(`
    SELECT DISTINCT msg.delivered_to_alias AS alias_email,
                    t.mailbox_id,
                    m.email                AS mailbox_email
      FROM inbox_messages msg
      JOIN inbox_threads t  ON t.id = msg.thread_id
      JOIN inbox_mailboxes m ON m.id = t.mailbox_id
     WHERE msg.delivered_to_alias IS NOT NULL
       AND msg.is_outbound = FALSE
       AND LOWER(SPLIT_PART(msg.delivered_to_alias, '@', 2))
           = LOWER(SPLIT_PART(m.email, '@', 2))
       AND NOT EXISTS (
         SELECT 1 FROM inbox_alias_routes r
          WHERE r.mailbox_id = t.mailbox_id
            AND LOWER(r.alias_email) = LOWER(msg.delivered_to_alias)
       )
  ORDER BY m.email, msg.delivered_to_alias
  `);
  res.json({ routed, unrouted });
});

// POST /api/alias-routes — create a mapping. body: { mailbox_id, alias_email, shared_inbox_id }
router.post('/', requireOwner, async (req, res) => {
  const { mailbox_id, alias_email, shared_inbox_id } = req.body;
  if (!mailbox_id || !alias_email?.trim() || !shared_inbox_id) {
    return res.status(400).json({ error: 'mailbox_id, alias_email, shared_inbox_id required' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO inbox_alias_routes (mailbox_id, alias_email, shared_inbox_id)
       VALUES ($1, LOWER($2), $3)
       ON CONFLICT (mailbox_id, alias_email) DO UPDATE
         SET shared_inbox_id = EXCLUDED.shared_inbox_id
       RETURNING *`,
      [mailbox_id, alias_email.trim(), shared_inbox_id]
    );
    // Back-fill any existing threads on this alias that aren't yet routed.
    await query(`
      UPDATE inbox_threads t
         SET shared_inbox_id = $1
        FROM inbox_messages m
       WHERE m.thread_id = t.id
         AND t.mailbox_id = $2
         AND LOWER(m.delivered_to_alias) = LOWER($3)
         AND t.shared_inbox_id IS NULL
    `, [shared_inbox_id, mailbox_id, alias_email.trim()]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save alias route' });
  }
});

// DELETE /api/alias-routes/:id — remove a mapping (threads stay where they are).
router.delete('/:id', requireOwner, async (req, res) => {
  await query(`DELETE FROM inbox_alias_routes WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
