const express = require('express');
const { query } = require('../../db');
const { requireAuth, requirePulseGrant } = require('../../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePulseGrant);

// Canonical key for 1:1 DM dedup: sorted user UUIDs joined by ":".
// Two users always resolve to the same key regardless of who initiated.
function dmKeyFor1to1(uid1, uid2) {
  return [uid1, uid2].sort().join(':');
}

// ── GET /api/pulse/dms — caller's DMs, with other-members + counts ───────
// Shape mirrors GET /api/pulse/channels: caller-relative fields up front.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        d.id, d.is_group, d.dm_key, d.created_at,
        dm_me.last_read_at,
        (SELECT MAX(created_at) FROM chat_messages
          WHERE dm_id = d.id AND deleted_at IS NULL) AS last_message_at,
        (SELECT COUNT(*) FROM chat_messages
          WHERE dm_id = d.id AND deleted_at IS NULL
            AND (dm_me.last_read_at IS NULL OR created_at > dm_me.last_read_at)
            AND sender_id <> $1)::int AS unread,
        (SELECT COUNT(*) FROM chat_mentions cm
           JOIN chat_messages m ON m.id = cm.message_id
          WHERE m.dm_id = d.id AND m.deleted_at IS NULL
            AND cm.mentioned_user_id = $1
            AND (dm_me.last_read_at IS NULL OR m.created_at > dm_me.last_read_at))::int AS mentions
        FROM chat_dms d
        JOIN chat_dm_members dm_me
          ON dm_me.dm_id = d.id AND dm_me.user_id = $1
       WHERE dm_me.hidden_at IS NULL
          OR EXISTS (
               SELECT 1 FROM chat_messages
                WHERE dm_id = d.id
                  AND deleted_at IS NULL
                  AND created_at > dm_me.hidden_at
             )
       ORDER BY last_message_at DESC NULLS LAST, d.created_at DESC
    `, [req.userId]);

    if (!rows.length) return res.json([]);

    // Pull "other members" for each DM in one shot.
    const ids = rows.map(r => r.id);
    const memRes = await query(`
      SELECT dm.dm_id, dm.user_id, u.full_name, u.email, u.avatar_url
        FROM chat_dm_members dm
        LEFT JOIN users u ON u.id = dm.user_id
       WHERE dm.dm_id = ANY($1::uuid[])
    `, [ids]);
    const byDm = new Map();
    for (const r of memRes.rows) {
      const list = byDm.get(r.dm_id) || [];
      list.push({
        user_id: r.user_id,
        full_name: r.full_name,
        email: r.email,
        avatar_url: r.avatar_url
      });
      byDm.set(r.dm_id, list);
    }

    res.json(rows.map(d => {
      const all = byDm.get(d.id) || [];
      const others = all.filter(m => m.user_id !== req.userId);
      const title = d.is_group
        ? others.map(m => (m.full_name || m.email || '').split(' ')[0]).filter(Boolean).join(', ') || 'Group'
        : (others[0] ? (others[0].full_name || others[0].email) : 'Direct Message');
      return { ...d, members: all, others, title };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load DMs' });
  }
});

// ── POST /api/pulse/dms  { user_ids: [...] } ────────────────────────────
// 1 target → upsert 1:1 (deduped by dm_key)
// 2+ targets → always create new group DM
router.post('/', async (req, res) => {
  const raw = (req.body && req.body.user_ids) || [];
  const uids = Array.from(new Set(raw.filter(u => u && u !== req.userId)));
  if (!uids.length) return res.status(400).json({ error: 'user_ids required' });

  try {
    if (uids.length === 1) {
      const other = uids[0];
      const key = dmKeyFor1to1(req.userId, other);
      // Try insert; on conflict, fetch existing.
      const ins = await query(`
        INSERT INTO chat_dms (is_group, dm_key, created_by)
        VALUES (FALSE, $1, $2)
        ON CONFLICT (dm_key) WHERE dm_key IS NOT NULL DO NOTHING
        RETURNING *
      `, [key, req.userId]);

      let dm = ins.rows[0];
      if (!dm) {
        const ex = await query(`SELECT * FROM chat_dms WHERE dm_key = $1`, [key]);
        dm = ex.rows[0];
      } else {
        // Newly created — add both members.
        await query(`
          INSERT INTO chat_dm_members (dm_id, user_id)
          VALUES ($1, $2), ($1, $3)
          ON CONFLICT DO NOTHING
        `, [dm.id, req.userId, other]);
      }
      return res.json(dm);
    }

    // Group DM
    const ins = await query(`
      INSERT INTO chat_dms (is_group, dm_key, created_by)
      VALUES (TRUE, NULL, $1)
      RETURNING *
    `, [req.userId]);
    const dm = ins.rows[0];
    const allMembers = [req.userId, ...uids];
    // Build a VALUES list dynamically
    const values = allMembers.map((_, i) => `($1, $${i + 2})`).join(',');
    await query(
      `INSERT INTO chat_dm_members (dm_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      [dm.id, ...allMembers]
    );
    return res.json(dm);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create DM' });
  }
});

// ── GET /api/pulse/dms/:id/members ──────────────────────────────────────
router.get('/:id/members', async (req, res) => {
  const dmId = req.params.id;
  try {
    const mine = await query(
      `SELECT 1 FROM chat_dm_members WHERE dm_id = $1 AND user_id = $2`,
      [dmId, req.userId]
    );
    if (!mine.rows.length) return res.status(403).json({ error: 'Not a member of this DM' });

    const { rows } = await query(`
      SELECT m.user_id, m.joined_at,
             u.full_name, u.email, u.avatar_url
        FROM chat_dm_members m
        LEFT JOIN users u ON u.id = m.user_id
       WHERE m.dm_id = $1
       ORDER BY u.full_name ASC NULLS LAST, u.email ASC
    `, [dmId]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load DM members' });
  }
});

// ── POST /api/pulse/dms/:id/read — set last_read_at = NOW() for caller ──
router.post('/:id/read', async (req, res) => {
  const dmId = req.params.id;
  try {
    const upd = await query(
      `UPDATE chat_dm_members SET last_read_at = NOW()
        WHERE dm_id = $1 AND user_id = $2`,
      [dmId, req.userId]
    );
    if (upd.rowCount === 0) {
      return res.status(403).json({ error: 'Not a member of this DM' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update read' });
  }
});

// ── POST /api/pulse/dms/:id/hide — soft hide from caller's sidebar ──────
// Sets hidden_at = NOW() for the caller's row. The DM reappears in the
// caller's list as soon as a newer message arrives.
router.post('/:id/hide', async (req, res) => {
  try {
    const upd = await query(
      `UPDATE chat_dm_members SET hidden_at = NOW()
        WHERE dm_id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (upd.rowCount === 0) {
      return res.status(403).json({ error: 'Not a member of this DM' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to hide DM' });
  }
});

module.exports = router;
