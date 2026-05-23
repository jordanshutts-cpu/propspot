const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePulseGrant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// Per-user sidebar sections + items. Each user organizes their own sidebar.
// Channels/DMs not in any section render under the default "Channels" /
// "Direct Messages" group in the UI.

// ── GET /api/pulse/sections ─────────────────────────────────────────────
// Returns the caller's sections with items resolved:
//   [{ id, name, position, collapsed, items: [{id, channel_id?, dm_id?, position}] }]
router.get('/', async (req, res) => {
  try {
    const secs = await query(`
      SELECT id, name, position, collapsed
        FROM chat_sidebar_sections
       WHERE user_id = $1
       ORDER BY position ASC, created_at ASC
    `, [req.userId]);

    if (!secs.rows.length) return res.json([]);

    const sectionIds = secs.rows.map(s => s.id);
    const items = await query(`
      SELECT id, section_id, channel_id, dm_id, position
        FROM chat_sidebar_items
       WHERE section_id = ANY($1::uuid[])
       ORDER BY position ASC
    `, [sectionIds]);

    const itemsBySec = new Map();
    for (const it of items.rows) {
      const arr = itemsBySec.get(it.section_id) || [];
      arr.push(it);
      itemsBySec.set(it.section_id, arr);
    }

    res.json(secs.rows.map(s => ({
      ...s,
      items: itemsBySec.get(s.id) || []
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sections' });
  }
});

// ── POST /api/pulse/sections  { name } ───────────────────────────────────
router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  try {
    const max = await query(
      `SELECT COALESCE(MAX(position), -1) AS p FROM chat_sidebar_sections WHERE user_id = $1`,
      [req.userId]
    );
    const nextPos = (max.rows[0].p || -1) + 1;
    const ins = await query(`
      INSERT INTO chat_sidebar_sections (user_id, name, position)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [req.userId, name.trim().slice(0, 80), nextPos]);
    res.json(ins.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create section' });
  }
});

// ── PATCH /api/pulse/sections/:id  { name?, position?, collapsed? } ──────
router.patch('/:id', async (req, res) => {
  const { name, position, collapsed } = req.body || {};
  const updates = [];
  const params = [];
  let idx = 1;
  if (typeof name === 'string' && name.trim()) {
    updates.push(`name = $${idx++}`); params.push(name.trim().slice(0, 80));
  }
  if (typeof position === 'number') {
    updates.push(`position = $${idx++}`); params.push(position);
  }
  if (typeof collapsed === 'boolean') {
    updates.push(`collapsed = $${idx++}`); params.push(collapsed);
  }
  if (!updates.length) return res.status(400).json({ error: 'No updatable fields' });

  params.push(req.params.id, req.userId);
  try {
    const upd = await query(
      `UPDATE chat_sidebar_sections SET ${updates.join(', ')}
        WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      params
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Section not found' });
    res.json(upd.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update section' });
  }
});

// ── DELETE /api/pulse/sections/:id ───────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const del = await query(
      `DELETE FROM chat_sidebar_sections WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (del.rowCount === 0) return res.status(404).json({ error: 'Section not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete section' });
  }
});

// ── POST /api/pulse/sections/:id/items  { channel_id? | dm_id? } ─────────
// Moves the channel/DM into this section. If it was already in a different
// section (owned by the same user), it's removed from there first.
router.post('/:id/items', async (req, res) => {
  const sectionId = req.params.id;
  const { channel_id, dm_id } = req.body || {};
  if ((!channel_id && !dm_id) || (channel_id && dm_id)) {
    return res.status(400).json({ error: 'Exactly one of channel_id or dm_id required' });
  }

  try {
    // Ownership check
    const own = await query(
      `SELECT id FROM chat_sidebar_sections WHERE id = $1 AND user_id = $2`,
      [sectionId, req.userId]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'Section not found' });

    // Remove any prior item for this channel/dm across THIS user's sections
    if (channel_id) {
      await query(`
        DELETE FROM chat_sidebar_items
         WHERE channel_id = $1
           AND section_id IN (SELECT id FROM chat_sidebar_sections WHERE user_id = $2)
      `, [channel_id, req.userId]);
    } else {
      await query(`
        DELETE FROM chat_sidebar_items
         WHERE dm_id = $1
           AND section_id IN (SELECT id FROM chat_sidebar_sections WHERE user_id = $2)
      `, [dm_id, req.userId]);
    }

    const max = await query(
      `SELECT COALESCE(MAX(position), -1) AS p FROM chat_sidebar_items WHERE section_id = $1`,
      [sectionId]
    );
    const nextPos = (max.rows[0].p || -1) + 1;

    const ins = await query(`
      INSERT INTO chat_sidebar_items (section_id, channel_id, dm_id, position)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [sectionId, channel_id || null, dm_id || null, nextPos]);
    res.json(ins.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add item to section' });
  }
});

// ── DELETE /api/pulse/sections/:id/items/:itemId ─────────────────────────
router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    const del = await query(`
      DELETE FROM chat_sidebar_items
       WHERE id = $1
         AND section_id IN (SELECT id FROM chat_sidebar_sections WHERE user_id = $2)
    `, [req.params.itemId, req.userId]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// ── PATCH /api/pulse/sections/:id/items/:itemId  { position } ────────────
router.patch('/:id/items/:itemId', async (req, res) => {
  const { position } = req.body || {};
  if (typeof position !== 'number') {
    return res.status(400).json({ error: 'position (number) required' });
  }
  try {
    const upd = await query(`
      UPDATE chat_sidebar_items SET position = $1
       WHERE id = $2
         AND section_id IN (SELECT id FROM chat_sidebar_sections WHERE user_id = $3)
       RETURNING *
    `, [position, req.params.itemId, req.userId]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(upd.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reorder item' });
  }
});

module.exports = router;
