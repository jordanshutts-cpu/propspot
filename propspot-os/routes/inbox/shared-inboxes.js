const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireInboxGrant, requireOwner } = require('../../middleware/auth');
const { scopedInboxIds } = require('../../lib/inbox-scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

// GET /api/shared-inboxes — list inboxes the caller can see.
router.get('/', async (req, res) => {
  const allowed = await scopedInboxIds(req.inboxGrant.scope);
  const params = [];
  let where = '';
  if (allowed !== null) {
    if (!allowed.length) return res.json([]);
    params.push(allowed);
    where = 'WHERE i.id = ANY($1::uuid[])';
  }
  const { rows } = await query(`
    SELECT i.id, i.slug, i.name, i.description, i.icon, i.signature_html, i.created_at,
           (SELECT COUNT(*) FROM inbox_threads t
             WHERE t.shared_inbox_id = i.id AND t.status = 'open')::int AS open_count,
           (SELECT COUNT(*) FROM inbox_threads t
             WHERE t.shared_inbox_id = i.id AND t.status = 'open' AND t.unread = TRUE)::int AS unread_count
      FROM inbox_shared i
      ${where}
  ORDER BY i.name ASC
  `, params);
  res.json(rows);
});

// POST /api/shared-inboxes — owner-only.
router.post('/', requireOwner, async (req, res) => {
  const { name, slug, description, icon } = req.body;
  if (!name?.trim() || !slug?.trim()) {
    return res.status(400).json({ error: 'name and slug are required' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO inbox_shared (name, slug, description, icon, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), slug.trim().toLowerCase(), description?.trim() || null, icon || '📨', req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already in use' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create shared inbox' });
  }
});

// PATCH /api/shared-inboxes/:id — owner-only.
router.patch('/:id', requireOwner, async (req, res) => {
  const allowed = ['name', 'description', 'icon', 'signature_html'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      sets.push(`${k} = $${i++}`);
      vals.push(req.body[k] || null);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(req.params.id);
  const { rows } = await query(
    `UPDATE inbox_shared SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'Inbox not found' });
  res.json(rows[0]);
});

// DELETE /api/shared-inboxes/:id — owner-only.
router.delete('/:id', requireOwner, async (req, res) => {
  await query(`DELETE FROM inbox_shared WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

// GET /api/shared-inboxes/:id/members — list users who can access this inbox.
router.get('/:id/members', requireOwner, async (req, res) => {
  // Owners (is_owner=TRUE) implicitly have access.
  const { rows: owners } = await query(
    `SELECT id, full_name, email, 'owner' AS source FROM users WHERE is_owner = TRUE ORDER BY full_name`
  );
  // Explicit members: users whose inbox app_grant.scope.inbox_ids contains this id.
  const { rows: members } = await query(`
    SELECT u.id, u.full_name, u.email, 'grant' AS source
      FROM users u
      JOIN app_grants ag ON ag.user_id = u.id
      JOIN apps a        ON a.id      = ag.app_id
     WHERE a.slug = 'inbox'
       AND (ag.scope ? 'inbox_ids')
       AND ag.scope->'inbox_ids' @> to_jsonb($1::text)
  ORDER BY u.full_name`, [req.params.id]);
  res.json([...owners, ...members]);
});

// PATCH /api/shared-inboxes/:id/members — add or remove a user's access.
//   body: { user_id, action: 'grant' | 'revoke' }
router.patch('/:id/members', requireOwner, async (req, res) => {
  const { user_id, action } = req.body;
  if (!user_id || !['grant','revoke'].includes(action)) {
    return res.status(400).json({ error: 'user_id and action (grant|revoke) required' });
  }
  // Make sure the user has an Inbox grant; create an empty one if not.
  const { rows: appRows } = await query(`SELECT id FROM apps WHERE slug = 'inbox'`);
  const appId = appRows[0]?.id;
  if (!appId) return res.status(500).json({ error: 'Inbox app row missing' });

  await query(
    `INSERT INTO app_grants (user_id, app_id, role, scope, granted_by)
     VALUES ($1, $2, 'member', '{"inbox_ids":[]}'::jsonb, $3)
     ON CONFLICT (user_id, app_id) DO NOTHING`,
    [user_id, appId, req.userId]
  );
  // Then update the scope to add/remove this inbox id.
  if (action === 'grant') {
    await query(`
      UPDATE app_grants
         SET scope = jsonb_set(
           COALESCE(scope, '{}'::jsonb),
           '{inbox_ids}',
           COALESCE(scope->'inbox_ids', '[]'::jsonb) ||
             (CASE WHEN scope->'inbox_ids' @> to_jsonb($1::text)
                   THEN '[]'::jsonb ELSE to_jsonb(ARRAY[$1::text]) END),
           true
         )
       WHERE user_id = $2 AND app_id = $3
    `, [req.params.id, user_id, appId]);
  } else {
    await query(`
      UPDATE app_grants
         SET scope = jsonb_set(
           scope,
           '{inbox_ids}',
           COALESCE(
             (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(scope->'inbox_ids') elem
               WHERE elem <> $1),
             '[]'::jsonb
           ),
           true
         )
       WHERE user_id = $2 AND app_id = $3
    `, [req.params.id, user_id, appId]);
  }
  res.json({ success: true });
});

module.exports = router;
