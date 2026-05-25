// ============================================================
//  Prop Spot — Sidebar badge counts (new-chrome Phase 2)
//  Single endpoint that returns every count the new sidebar
//  renders, so the frontend makes one round-trip on load.
//  Each count is independently fault-tolerant — if one query
//  errors (missing table, schema mismatch), that badge falls
//  back to null without breaking the others.
// ============================================================

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Run a counting query, return 0 on failure so the sidebar stays alive.
async function safeCount(sql, params = []) {
  try {
    const { rows } = await query(sql, params);
    return parseInt(rows[0]?.count ?? rows[0]?.n ?? 0, 10);
  } catch (err) {
    console.warn('sidebar-counts query failed:', err.message);
    return null;
  }
}

router.get('/', async (req, res) => {
  const me = req.userId;

  const [
    inbox, mentions, myTasks,
    prospects, leads, opportunities, acquisitions, projects, holdings, dispositions, sold,
    photosToday, workOrders, pulse
  ] = await Promise.all([
    // ── For You ───────────────────────────────────────────────
    safeCount(`
      SELECT COUNT(*)::int AS count
        FROM inbox_threads
       WHERE status = 'open'
         AND unread = TRUE
         AND (assigned_to_user_id = $1 OR assigned_to_user_id IS NULL)
    `, [me]),

    safeCount(`
      SELECT COUNT(*)::int AS count
        FROM chat_mentions cm
        JOIN chat_messages m ON m.id = cm.message_id
        LEFT JOIN chat_channel_members ccm
          ON ccm.channel_id = m.channel_id AND ccm.user_id = $1
       WHERE cm.mentioned_user_id = $1
         AND m.created_at > COALESCE(ccm.last_read_at, 'epoch'::timestamptz)
    `, [me]),

    safeCount(`
      SELECT COUNT(*)::int AS count
        FROM tasks
       WHERE status IN ('open','in_progress')
         AND (assigned_to = $1 OR created_by = $1)
    `, [me]),

    // ── Pipeline (Jordan's flow: prospect → lead → opportunity → acquisition
    //    → project → holdings | disposition → sold; dead off-track) ────
    safeCount(`SELECT COUNT(*)::int AS count FROM prospects     WHERE status IN ('active','attempted')`),
    safeCount(`SELECT COUNT(*)::int AS count FROM leads         WHERE status IN ('new','working')`),
    safeCount(`SELECT COUNT(*)::int AS count FROM opportunities WHERE status IN ('active','appointment_set')`),
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status = 'purchasing'`),                                              // acquisitions
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status = 'renovating'`),                                              // projects
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status IN ('renting','rented','listed_for_rent')`),                   // holdings (rentals only)
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status IN ('selling','listed_for_sale','under_contract_buyer')`),     // dispositions
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status IN ('sold','assigned')`),                                      // sold

    // ── Tools ─────────────────────────────────────────────────
    safeCount(`SELECT COUNT(*)::int AS count FROM photos WHERE created_at >= CURRENT_DATE AND deleted_at IS NULL`),
    safeCount(`SELECT COUNT(*)::int AS count FROM work_orders WHERE status IN ('open','scheduled','in_progress')`),

    // Pulse unread: channels where the latest message is newer than my last_read_at.
    safeCount(`
      SELECT COUNT(*)::int AS count
        FROM chat_channel_members ccm
        JOIN (
          SELECT channel_id, MAX(created_at) AS latest
            FROM chat_messages
           WHERE channel_id IS NOT NULL
           GROUP BY channel_id
        ) lm ON lm.channel_id = ccm.channel_id
       WHERE ccm.user_id = $1
         AND lm.latest > COALESCE(ccm.last_read_at, 'epoch'::timestamptz)
    `, [me])
  ]);

  res.json({
    inbox, mentions, myTasks,
    prospects, leads, opportunities, acquisitions, projects, holdings, dispositions, sold,
    photosToday, workOrders, pulse
  });
});

module.exports = router;
