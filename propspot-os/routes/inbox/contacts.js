// Contact autocomplete for the compose form's "To" / "Cc" fields.
// Sources addresses + display names from inbox_messages.from_email — the
// people who have emailed the user's accessible shared inboxes. Most-recent
// senders rank first.
//
// v1 deliberately does NOT include outbound recipients (to_emails / cc_emails
// of sent messages); the union query is significantly more expensive and the
// vast majority of useful contacts are people you've received mail from. If
// you need to email someone you've only ever sent to, type the full address.

const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireInboxGrant } = require('../../middleware/auth');
const { scopedInboxIds } = require('../../lib/inbox-scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

// GET /api/contacts?q=<term>&limit=20
// Returns [{ email, name, last_seen }] ordered by recency.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json([]);  // require at least 2 chars to keep the query light
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 50));

  const allowed = await scopedInboxIds(req.inboxGrant.scope, req.userId);
  // null = owner / unrestricted; [] = no access; otherwise the allowed shared_inbox ids
  if (Array.isArray(allowed) && !allowed.length) return res.json([]);

  const params = [`%${q}%`];
  let scopeClause = '';
  if (Array.isArray(allowed)) {
    params.push(allowed);
    scopeClause = `AND t.shared_inbox_id = ANY($${params.length}::uuid[])`;
  }
  params.push(limit);
  const limitIdx = params.length;

  try {
    const { rows } = await query(`
      SELECT DISTINCT ON (LOWER(m.from_email))
             LOWER(m.from_email) AS email,
             m.from_name         AS name,
             m.received_at       AS last_seen
        FROM inbox_messages m
        JOIN inbox_threads  t ON t.id = m.thread_id
       WHERE m.from_email IS NOT NULL
         AND m.from_email <> ''
         AND m.is_outbound = FALSE
         AND (LOWER(m.from_email) LIKE $1 OR LOWER(COALESCE(m.from_name, '')) LIKE $1)
         ${scopeClause}
    ORDER BY LOWER(m.from_email), m.received_at DESC
       LIMIT $${limitIdx}
    `, params);
    // The DISTINCT ON keeps one row per email; re-sort by recency for the response.
    rows.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
    res.json(rows);
  } catch (err) {
    console.error('contacts search failed:', err);
    res.status(500).json({ error: 'Failed to search contacts' });
  }
});

module.exports = router;
